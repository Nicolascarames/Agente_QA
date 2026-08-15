import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, projectEnvPath, FakeSiteExplorer } from "@agente-qa/core";

const generateTextMock = vi.fn();
const createRealSiteExplorerMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));
vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => provider,
}));
vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createRealSiteExplorer: (...args: unknown[]) => createRealSiteExplorerMock(...args),
  };
});

import { runCreatePlan } from "./chat.js";
import type { ChatPrompts } from "../prompts/types.js";

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
    generateTextMock.mockReset();
    createRealSiteExplorerMock.mockReset();
    createRealSiteExplorerMock.mockReturnValue(new FakeSiteExplorer([{ ok: true, screens: [] }]));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("matches the built-in login pattern and writes an approved feature file", async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: '{"ambiguous": false, "questions": []}' })
      .mockResolvedValueOnce({ text: '{"matchedPatternName": "login"}' })
      .mockResolvedValueOnce({
        text: "Feature: Login\n  Scenario: acceso válido\n    Given a\n    When b\n    Then c\n",
      });

    const prompts: ChatPrompts = {
      inputInitialText: vi.fn().mockResolvedValue("Quiero probar que el login funciona"),
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const filePath = await runCreatePlan(prompts, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("Feature: Login");
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });
});
