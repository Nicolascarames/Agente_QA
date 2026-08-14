import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, projectEnvPath, FakeLLMProvider } from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";

const createProviderMock = vi.fn();
const withLLMSpinnerMock = vi.fn((provider: unknown) => provider);

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
  };
});

vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => withLLMSpinnerMock(provider),
}));

import { runCreatePlan } from "./chat.js";

async function writeEnv(projectRoot: string, values: Record<string, string>): Promise<void> {
  await fs.mkdir(path.join(projectRoot, ".agente-qa"), { recursive: true });
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await fs.writeFile(projectEnvPath(projectRoot), `${content}\n`, "utf-8");
}

describe("runCreatePlan", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-chat-project-"));
    createProviderMock.mockReset();
    withLLMSpinnerMock.mockClear();
    withLLMSpinnerMock.mockImplementation((provider: unknown) => provider);
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: ChatPrompts = {
      inputInitialText: vi.fn(),
      askUser: vi.fn(),
      presentForApproval: vi.fn(),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };
    await expect(runCreatePlan(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws naming the missing .env variable when the LLM API key is blank", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });

    const prompts: ChatPrompts = {
      inputInitialText: vi.fn(),
      askUser: vi.fn(),
      presentForApproval: vi.fn(),
      confirmOverwrite: vi.fn(),
    };

    await expect(runCreatePlan(prompts, tmpProject)).rejects.toThrow(/AGENTE_QA_LLM_API_KEY/);
  });

  it("loads env/config, runs intake through the fake LLM, and writes the feature file", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });

    const fake = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    createProviderMock.mockReturnValue(fake);

    const prompts: ChatPrompts = {
      inputInitialText: vi.fn().mockResolvedValue("quiero probar el login"),
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const filePath = await runCreatePlan(prompts, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toContain("Feature: Login");
  });

  it("wraps the LLM provider with the spinner decorator before using it", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });

    const fake = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    createProviderMock.mockReturnValue(fake);

    const prompts: ChatPrompts = {
      inputInitialText: vi.fn().mockResolvedValue("quiero probar el login"),
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runCreatePlan(prompts, tmpProject);

    expect(withLLMSpinnerMock.mock.calls[0][0]).toBe(fake);
  });
});
