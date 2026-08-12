import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectConfig, projectEnvPath } from "@agente-qa/core";
import { runInit } from "./init.js";
import type { InitPrompts } from "../prompts/types.js";

describe("runInit", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-init-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("saves the project config from the prompt answer", async () => {
    const prompts: InitPrompts = { inputTestsDir: async () => "tests" };

    await runInit(prompts, tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests" });
  });

  it("creates the .env template when it doesn't exist yet, and reports it as created", async () => {
    const prompts: InitPrompts = { inputTestsDir: async () => "tests" };

    const result = await runInit(prompts, tmpProject);

    expect(result.envCreated).toBe(true);
    expect(result.envPath).toBe(projectEnvPath(tmpProject));
    const exists = await fs.stat(projectEnvPath(tmpProject)).then(() => true, () => false);
    expect(exists).toBe(true);
  });

  it("does not overwrite an existing .env, and reports it as not created", async () => {
    const prompts: InitPrompts = { inputTestsDir: async () => "tests" };
    await runInit(prompts, tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");

    const result = await runInit(prompts, tmpProject);

    expect(result.envCreated).toBe(false);
    expect(await fs.readFile(projectEnvPath(tmpProject), "utf-8")).toBe(
      "AGENTE_QA_APP_URL=https://mi-app.com\n"
    );
  });
});
