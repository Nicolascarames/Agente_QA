import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
      inputTestsDir: async () => "tests",
    };

    await runInit(prompts, tmpHome, tmpProject);

    expect(await loadCredentials(tmpHome)).toEqual({ provider: "anthropic", apiKey: "sk-ant-test" });
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests" });
  });
});
