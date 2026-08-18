import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, projectEnvPath, saveAppMap, type AppMap, type Screen } from "@agente-qa/core";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));
vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => provider,
}));

import { runCreatePlan } from "./chat.js";
import type { ChatPrompts } from "../prompts/types.js";

const loginScreen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: ["Welcome back"], probeValues: [], locators: [],
  ambiguous: [], transitions: [], writeActions: [],
  states: [],
};

const baseMap: AppMap = {
  schemaVersion: 2, appUrl: "https://example.com/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
  screens: [loginScreen],
};

describe("end-to-end: create plan via the real wiring, only the network call mocked", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-e2e-project-"));
    await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
    await fs.writeFile(
      projectEnvPath(tmpProject),
      "AGENTE_QA_LLM_PROVIDER=anthropic\nAGENTE_QA_LLM_API_KEY=sk-test\n",
      "utf-8"
    );
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    await saveAppMap(tmpProject, baseMap);
    generateTextMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("grounds the plan in the app map and writes an approved feature file", async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: '{"ambiguous": false, "questions": []}' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          fileName: "login.feature",
          featureText: 'Feature: Login\n\n  @screen:login\n  Scenario: acceso válido\n    Then I see "Welcome back"\n',
        }),
      });

    const prompts: ChatPrompts = {
      inputInitialText: vi.fn().mockResolvedValue("Quiero probar que el login funciona"),
      askUser: vi.fn(),
      chooseScenario: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const filePath = await runCreatePlan(prompts, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("Feature: Login");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});
