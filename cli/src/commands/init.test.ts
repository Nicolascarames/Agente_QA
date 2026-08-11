import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCredentials, loadProjectConfig } from "@agente-qa/core";
import { runInit } from "./init.js";
import type { InitPrompts } from "../prompts/types.js";

describe("runInit", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-init-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-init-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("saves credentials and project config from the prompt answers", async () => {
    const prompts: InitPrompts = {
      selectProvider: async () => "anthropic",
      inputApiKey: async () => "sk-ant-test",
      inputBaseURL: vi.fn(),
      inputModel: vi.fn(),
      inputTestsDir: async () => "tests",
    };

    await runInit(prompts, tmpHome, tmpProject);

    expect(await loadCredentials(tmpHome)).toEqual({ provider: "anthropic", apiKey: "sk-ant-test" });
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests" });
  });

  it("asks for baseURL and model, and saves them, when provider is openai-compatible", async () => {
    const prompts: InitPrompts = {
      selectProvider: async () => "openai-compatible",
      inputApiKey: async () => "sk-test",
      inputBaseURL: async () => "https://api.groq.com/openai/v1",
      inputModel: async () => "llama-3.3-70b-versatile",
      inputTestsDir: async () => "tests",
    };

    await runInit(prompts, tmpHome, tmpProject);

    expect(await loadCredentials(tmpHome)).toEqual({
      provider: "openai-compatible",
      apiKey: "sk-test",
      baseURL: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    });
  });

  it("does not ask for baseURL/model when the provider is not openai-compatible", async () => {
    const inputBaseURL = vi.fn();
    const inputModel = vi.fn();
    const prompts: InitPrompts = {
      selectProvider: async () => "anthropic",
      inputApiKey: async () => "sk-ant-test",
      inputBaseURL,
      inputModel,
      inputTestsDir: async () => "tests",
    };

    await runInit(prompts, tmpHome, tmpProject);

    expect(inputBaseURL).not.toHaveBeenCalled();
    expect(inputModel).not.toHaveBeenCalled();
  });
});
