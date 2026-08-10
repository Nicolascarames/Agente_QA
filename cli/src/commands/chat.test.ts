import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, saveProjectConfig, FakeLLMProvider } from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";

const createProviderMock = vi.fn();

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
  };
});

import { runCreatePlan } from "./chat.js";

describe("runCreatePlan", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-chat-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-chat-project-"));
    createProviderMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: ChatPrompts = {
      inputInitialText: vi.fn(),
      askUser: vi.fn(),
      presentForApproval: vi.fn(),
      offerSavePattern: vi.fn(),
    };
    await expect(runCreatePlan(prompts, tmpHome, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("loads credentials/config, runs intake through the fake LLM, and writes the feature file", async () => {
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test" }, tmpHome);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

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
      offerSavePattern: vi.fn(),
    };

    const filePath = await runCreatePlan(prompts, tmpHome, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toContain("Feature: Login");
    expect(prompts.offerSavePattern).not.toHaveBeenCalled();
  });
});
