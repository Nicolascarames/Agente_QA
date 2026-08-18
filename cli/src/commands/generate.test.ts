import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveProjectConfig,
  saveAppMap,
  loadOverrides,
  projectEnvPath,
  FakeLLMProvider,
  FakeLocatorVerifier,
  realCodeChecker,
  type AppMap,
  type Screen,
} from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";
import { formatAgentEvent } from "../util/renderEvent.js";

const createProviderMock = vi.fn();
const realCodeCheckerCheckMock = vi.fn();
const createRealLocatorVerifierMock = vi.fn();
const withLLMSpinnerMock = vi.fn((provider: unknown) => provider);
const withCodeCheckerSpinnerMock = vi.fn((checker: unknown) => checker);
const withLocatorVerifierSpinnerMock = vi.fn((verifier: unknown) => verifier);

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
    realCodeChecker: { check: (...args: unknown[]) => realCodeCheckerCheckMock(...args) },
    createRealLocatorVerifier: (...args: unknown[]) => createRealLocatorVerifierMock(...args),
  };
});

vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => withLLMSpinnerMock(provider),
  withCodeCheckerSpinner: (checker: unknown) => withCodeCheckerSpinnerMock(checker),
  withLocatorVerifierSpinner: (verifier: unknown) => withLocatorVerifierSpinnerMock(verifier),
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
};

const loginScreen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: ["Welcome back"], probeValues: [], ambiguous: [], transitions: [], writeActions: [],
  states: [],
  locators: [
    {
      name: "log_in_button", kind: "button", accessibleName: "Log in",
      python: 'page.get_by_role("button", name="Log in", exact=True)', count: 1, verifiedAt: "t",
    },
  ],
};

const baseMap: AppMap = {
  schemaVersion: 2, appUrl: "https://example.com/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [loginScreen],
};

// Same twins fixture as runGenerador.test.ts: two buttons sharing the
// accessible name "Log in", only one of which submits — the ambiguity a
// step's quoted text alone cannot resolve, used here to prove the CLI's
// onAmbiguousLocator prompt is actually wired into runGenerador's callback.
const homeScreenWithTwins: Screen = {
  id: "home", name: "home", className: "HomePage", urlTemplate: "/",
  signature: "sha256:t", requiresAuth: false,
  texts: ["Log in"], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
  locators: [
    { name: "log_in_button", kind: "button", accessibleName: "Log in",
      python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'button\']"))',
      count: 1, verifiedAt: "t" },
    { name: "log_in_button_submit", kind: "button", accessibleName: "Log in",
      python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))',
      count: 1, verifiedAt: "t" },
  ],
};

const mapWithTwins: AppMap = { ...baseMap, screens: [homeScreenWithTwins] };

const featureWithAmbiguousClick =
  'Feature: Login\n\n  @screen:home\n  Scenario: x\n    When I click "Log in"\n';

// Carries no "I click"/"I fill" step, so locatorsUsedBy finds nothing to
// revalidate — the FakeLocatorVerifier never needs a scripted response.
const simpleFeature = "Feature: Login\n\n  @screen:login\n  Scenario: x\n    Given a\n";

const featureWithClick =
  'Feature: Login\n\n  @screen:login\n  Scenario: x\n    When I click "Log in"\n    Then I see "Welcome back"\n';

const scriptedResponse = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, given, when, then

scenarios("../features/login.feature")


@given("a")
def a():
    pass
`;

function generatorPrompts(overrides: Partial<GeneratorPrompts> = {}): GeneratorPrompts {
  return {
    selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
    confirmOverwrite: vi.fn().mockResolvedValue(true),
    onStaleLocator: vi.fn().mockRejectedValue(new Error("onStaleLocator no debería haberse llamado")),
    onAmbiguousLocator: vi.fn().mockRejectedValue(new Error("onAmbiguousLocator no debería haberse llamado")),
    ...overrides,
  };
}

describe("runGenerateTests", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-generate-project-"));
    createProviderMock.mockReset();
    realCodeCheckerCheckMock.mockReset();
    createRealLocatorVerifierMock.mockReset();
    createRealLocatorVerifierMock.mockReturnValue(new FakeLocatorVerifier([]));
    withLLMSpinnerMock.mockClear();
    withLLMSpinnerMock.mockImplementation((provider: unknown) => provider);
    withCodeCheckerSpinnerMock.mockClear();
    withCodeCheckerSpinnerMock.mockImplementation((checker: unknown) => checker);
    withLocatorVerifierSpinnerMock.mockClear();
    withLocatorVerifierSpinnerMock.mockImplementation((verifier: unknown) => verifier);
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  async function writeFeature(content: string): Promise<void> {
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), content, "utf-8");
  }

  it("throws a clear error when init hasn't been run yet", async () => {
    await expect(runGenerateTests(generatorPrompts(), tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws a clear error when there are no approved .feature files yet", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });

    await expect(runGenerateTests(generatorPrompts(), tmpProject)).rejects.toThrow(/Crear plan de pruebas/);
  });

  it("lists feature files, generates code through the fake LLM, and writes the test file", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);
    await writeFeature(simpleFeature);

    createProviderMock.mockReturnValue(new FakeLLMProvider([scriptedResponse]));
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });

    const prompts = generatorPrompts();
    const writtenPaths = await runGenerateTests(prompts, tmpProject);

    expect(prompts.selectFeatureFile).toHaveBeenCalledWith(["login.feature"]);
    expect(writtenPaths).toHaveLength(1);
    expect(writtenPaths[0]).toMatch(/tests[\\/]test_login\.py$/);
    expect(await fs.readFile(writtenPaths[0], "utf-8")).toContain("scenarios(");
  });

  it("wraps the LLM provider and the code checker with their spinner decorators before using them", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);
    await writeFeature(simpleFeature);

    const fake = new FakeLLMProvider([scriptedResponse]);
    createProviderMock.mockReturnValue(fake);
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });

    await runGenerateTests(generatorPrompts(), tmpProject);

    expect(withLLMSpinnerMock.mock.calls[0][0]).toBe(fake);
    expect(withCodeCheckerSpinnerMock.mock.calls[0][0]).toBe(realCodeChecker);
  });

  it("builds the locator verifier and wraps it with its spinner decorator before using it", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);
    await writeFeature(simpleFeature);

    createProviderMock.mockReturnValue(new FakeLLMProvider([scriptedResponse]));
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });
    const verifier = new FakeLocatorVerifier([]);
    createRealLocatorVerifierMock.mockReturnValue(verifier);

    await runGenerateTests(generatorPrompts(), tmpProject);

    expect(createRealLocatorVerifierMock).toHaveBeenCalled();
    expect(withLocatorVerifierSpinnerMock.mock.calls[0][0]).toBe(verifier);
  });

  it("revalidates locators the scenario actually uses against the real app, passing test credentials through", async () => {
    await writeEnv(tmpProject, {
      ...BASE_ENV,
      AGENTE_QA_TEST_USERNAME: "qa@example.com",
      AGENTE_QA_TEST_PASSWORD: "s3cret",
    });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);
    await writeFeature(featureWithClick);

    createProviderMock.mockReturnValue(new FakeLLMProvider([scriptedResponse]));
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    createRealLocatorVerifierMock.mockReturnValue(verifier);

    await runGenerateTests(generatorPrompts(), tmpProject);

    expect(verifier.receivedCalls).toHaveLength(1);
    expect(verifier.receivedCalls[0].credentials).toEqual({ username: "qa@example.com", password: "s3cret" });
  });

  it("routes a stale locator through the onStaleLocator prompt, persists the override it returns, and stops the run", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);
    await writeFeature(featureWithClick);

    createProviderMock.mockReturnValue(new FakeLLMProvider([scriptedResponse]));
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });
    createRealLocatorVerifierMock.mockReturnValue(
      new FakeLocatorVerifier([{ ok: false, errors: 'El locator get_log_in_button("") no se pudo verificar: 0 coincidencias.' }])
    );
    const overridePython = 'page.get_by_test_id("login-btn")';
    const prompts = generatorPrompts({
      onStaleLocator: vi.fn().mockResolvedValue({ action: "override", python: overridePython }),
    });

    // runGenerador now stops the run once an override is persisted, instead of
    // generating against a Page Object that still holds the stale expression.
    await expect(runGenerateTests(prompts, tmpProject)).rejects.toThrow(/agente-qa map/);

    expect(prompts.onStaleLocator).toHaveBeenCalledWith([{ screenId: "login", name: "log_in_button", count: 0 }]);
    const overrides = await loadOverrides(tmpProject);
    expect(overrides.locators).toEqual([{ screenId: "login", name: "log_in_button", python: overridePython }]);
  });

  it("routes an ambiguous locator through the onAmbiguousLocator prompt, and writes the chosen locator into the .feature", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, mapWithTwins);
    await writeFeature(featureWithAmbiguousClick);

    createProviderMock.mockReturnValue(new FakeLLMProvider([scriptedResponse]));
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });
    createRealLocatorVerifierMock.mockReturnValue(new FakeLocatorVerifier([{ ok: true }]));

    const [, submitButton] = homeScreenWithTwins.locators;
    const prompts = generatorPrompts({
      onAmbiguousLocator: vi.fn().mockResolvedValue(submitButton),
    });

    await runGenerateTests(prompts, tmpProject);

    expect(prompts.onAmbiguousLocator).toHaveBeenCalledWith({
      screenId: "home",
      screenName: "home",
      quoted: "Log in",
      candidates: homeScreenWithTwins.locators,
    });
    const rewritten = await fs.readFile(path.join(tmpProject, "tests", "features", "login.feature"), "utf-8");
    expect(rewritten).toContain('When I click "log_in_button_submit"');
  });

  it("prints each agent event through formatAgentEvent, not a hand-built string", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);
    await writeFeature(simpleFeature);

    createProviderMock.mockReturnValue(new FakeLLMProvider([scriptedResponse]));
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let printedLines: unknown[];
    try {
      await runGenerateTests(generatorPrompts(), tmpProject);
    } finally {
      // Read the calls before restoring: mockRestore() also clears .mock.calls.
      printedLines = logSpy.mock.calls.map((call) => call[0]);
      logSpy.mockRestore();
    }

    // The generation-attempt event this agent emits mid-run; formatAgentEvent
    // prepends the indentation and status mark. A CLI that printed
    // `event.message` (or any other hand-built string) instead of
    // `formatAgentEvent(event)` would never produce this exact line.
    const expectedLine = formatAgentEvent({
      agent: "generador", status: "info", depth: 1,
      message: "Generando código (intento 1 de 4)",
    });
    expect(printedLines).toContain(expectedLine);
  });
});
