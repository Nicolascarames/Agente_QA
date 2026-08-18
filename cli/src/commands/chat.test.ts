import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveProjectConfig, projectEnvPath, saveAppMap, FakeLLMProvider,
  type AppMap, type Screen,
} from "@agente-qa/core";
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

const loginScreen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: ["Welcome back", "Email"], probeValues: [], locators: [],
  ambiguous: [], transitions: [], writeActions: [],
  states: [],
};

const baseMap: AppMap = {
  schemaVersion: 2, appUrl: "https://example.com/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
  screens: [loginScreen],
};

const emptyPrompts = (overrides: Partial<ChatPrompts> = {}): ChatPrompts => ({
  inputInitialText: vi.fn(),
  askUser: vi.fn(),
  chooseScenario: vi.fn(),
  presentForApproval: vi.fn(),
  confirmOverwrite: vi.fn().mockResolvedValue(true),
  ...overrides,
});

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
    const prompts = emptyPrompts();
    await expect(runCreatePlan(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws naming the missing .env variable when the LLM API key is blank", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });

    const prompts = emptyPrompts();
    await expect(runCreatePlan(prompts, tmpProject)).rejects.toThrow(/AGENTE_QA_LLM_API_KEY/);
  });

  it("throws an actionable error naming 'agente-qa map' when there is no app map yet", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    createProviderMock.mockReturnValue(new FakeLLMProvider([]));

    const prompts = emptyPrompts({ inputInitialText: vi.fn().mockResolvedValue("quiero probar el login") });
    await expect(runCreatePlan(prompts, tmpProject)).rejects.toThrow(/agente-qa map/);
  });

  it("loads env/config/map, runs intake through the fake LLM, and writes the feature file", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);

    const fake = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      JSON.stringify({
        fileName: "login.feature",
        featureText: 'Feature: Login\n\n  @screen:login\n  Scenario: x\n    Then I see "Welcome back"\n',
      }),
    ]);
    createProviderMock.mockReturnValue(fake);

    const prompts = emptyPrompts({
      inputInitialText: vi.fn().mockResolvedValue("quiero probar el login"),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
    });

    const filePath = await runCreatePlan(prompts, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toContain("Feature: Login");
  });

  it("wraps the LLM provider with the spinner decorator before using it", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);

    const fake = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      JSON.stringify({
        fileName: "login.feature",
        featureText: 'Feature: Login\n\n  @screen:login\n  Scenario: x\n    Then I see "Welcome back"\n',
      }),
    ]);
    createProviderMock.mockReturnValue(fake);

    const prompts = emptyPrompts({
      inputInitialText: vi.fn().mockResolvedValue("quiero probar el login"),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
    });

    await runCreatePlan(prompts, tmpProject);

    expect(withLLMSpinnerMock.mock.calls[0][0]).toBe(fake);
  });

  it("offers the map's candidate scenarios through the chooseScenario prompt", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, {
      ...baseMap,
      scenarios: [{
        id: "s1", title: "Invalid login shows an error", screenId: "login",
        involvedScreens: ["login"], rationale: "Covers the failure path",
      }],
    });

    const fake = new FakeLLMProvider([
      JSON.stringify({
        fileName: "login.feature",
        featureText: 'Feature: Login\n\n  @screen:login\n  Scenario: x\n    Then I see "Welcome back"\n',
      }),
    ]);
    createProviderMock.mockReturnValue(fake);

    const chooseScenario = vi.fn().mockImplementation(async (candidates) => candidates[0]);
    const prompts = emptyPrompts({
      inputInitialText: vi.fn().mockResolvedValue(""),
      chooseScenario,
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
    });

    await runCreatePlan(prompts, tmpProject);

    expect(chooseScenario).toHaveBeenCalledWith([
      expect.objectContaining({ id: "s1", title: "Invalid login shows an error" }),
    ]);
  });
});
