import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, loadProjectConfig, projectConfigPath } from "./projectConfig.js";

describe("projectConfig", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("returns null when no config file exists", async () => {
    expect(await loadProjectConfig(tmpProject)).toBeNull();
  });

  it("saves and loads project config round-trip", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests" });
  });

  it("writes the file at <project>/.agente-qa/config.json", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "qa-tests" });
    expect(projectConfigPath(tmpProject)).toBe(path.join(tmpProject, ".agente-qa", "config.json"));
  });

  it("rejects and does not write the file when testsDir is empty", async () => {
    await expect(saveProjectConfig(tmpProject, { testsDir: "" })).rejects.toThrow();
    const exists = await fs.stat(projectConfigPath(tmpProject)).then(() => true, () => false);
    expect(exists).toBe(false);
  });
});
