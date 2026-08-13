import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, projectEnvPath, FakeLLMProvider, FakeSiteExplorer, realCodeChecker } from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";

const createProviderMock = vi.fn();
const realCodeCheckerCheckMock = vi.fn();
const createRealSiteExplorerMock = vi.fn();
const withLLMSpinnerMock = vi.fn((provider: unknown) => provider);
const withCodeCheckerSpinnerMock = vi.fn((checker: unknown) => checker);

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
    realCodeChecker: { check: (...args: unknown[]) => realCodeCheckerCheckMock(...args) },
    createRealSiteExplorer: (...args: unknown[]) => createRealSiteExplorerMock(...args),
  };
});

vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => withLLMSpinnerMock(provider),
  withCodeCheckerSpinner: (checker: unknown) => withCodeCheckerSpinnerMock(checker),
}));

import { runGenerateTests } from "./generate.js";

async function writeEnv(projectRoot: string, values: Record<string, string>): Promise<void> {
  await fs.mkdir(path.join(projectRoot, ".agente-qa"), { recursive: true });
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await fs.writeFile(projectEnvPath(projectRoot), `${content}\n`, "utf-8");
}

const BASE_ENV = {
  AGENTE_QA_LLM_PROVIDER: "anthropic",
  AGENTE_QA_LLM_API_KEY: "sk-test",
  AGENTE_QA_APP_URL: "https://example.com",
};

describe("runGenerateTests", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-generate-project-"));
    createProviderMock.mockReset();
    realCodeCheckerCheckMock.mockReset();
    createRealSiteExplorerMock.mockReset();
    createRealSiteExplorerMock.mockReturnValue(new FakeSiteExplorer([{ ok: true, screens: [] }]));
    withLLMSpinnerMock.mockClear();
    withLLMSpinnerMock.mockImplementation((provider: unknown) => provider);
    withCodeCheckerSpinnerMock.mockClear();
    withCodeCheckerSpinnerMock.mockImplementation((checker: unknown) => checker);
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws a clear error when AGENTE_QA_APP_URL isn't configured", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpProject)).rejects.toThrow(/AGENTE_QA_APP_URL/);
  });

  it("throws a clear error when there are no approved .feature files yet", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpProject)).rejects.toThrow(/Crear plan de pruebas/);
  });

  it("lists feature files, generates code through the fake LLM, and writes the test files", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "Feature: Login\n", "utf-8");

    const scriptedResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    createProviderMock.mockReturnValue(new FakeLLMProvider([scriptedResponse]));
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
      offerSavePattern: vi.fn().mockResolvedValue({ save: false }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const writtenPaths = await runGenerateTests(prompts, tmpProject);

    expect(prompts.selectFeatureFile).toHaveBeenCalledWith(["login.feature"]);
    expect(writtenPaths).toHaveLength(2);
    expect(
      await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")
    ).toContain("scenarios(");
  });

  it("wraps the LLM provider and the code checker with their spinner decorators before using them", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "Feature: Login\n", "utf-8");

    const scriptedResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    const fake = new FakeLLMProvider([scriptedResponse]);
    createProviderMock.mockReturnValue(fake);
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
      offerSavePattern: vi.fn().mockResolvedValue({ save: false }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runGenerateTests(prompts, tmpProject);

    expect(withLLMSpinnerMock.mock.calls[0][0]).toBe(fake);
    expect(withCodeCheckerSpinnerMock.mock.calls[0][0]).toBe(realCodeChecker);
  });

  it("builds the site explorer from the LLM provider and passes app URL and test credentials through", async () => {
    await writeEnv(tmpProject, {
      ...BASE_ENV,
      AGENTE_QA_TEST_USERNAME: "qa@example.com",
      AGENTE_QA_TEST_PASSWORD: "s3cret",
    });
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "Feature: Login\n", "utf-8");

    const scriptedResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    const fake = new FakeLLMProvider([scriptedResponse]);
    createProviderMock.mockReturnValue(fake);
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    createRealSiteExplorerMock.mockReturnValue(explorer);

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
      offerSavePattern: vi.fn().mockResolvedValue({ save: false }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runGenerateTests(prompts, tmpProject);

    expect(createRealSiteExplorerMock).toHaveBeenCalledWith(fake);
    expect(explorer.receivedCalls[0].baseUrl).toBe("https://example.com");
    expect(explorer.receivedCalls[0].credentials).toEqual({ username: "qa@example.com", password: "s3cret" });
  });
});
