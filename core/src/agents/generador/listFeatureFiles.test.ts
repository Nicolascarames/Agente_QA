import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFeatureFiles } from "./listFeatureFiles.js";

describe("listFeatureFiles", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-listfeatures-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("returns an empty array when the features directory doesn't exist", async () => {
    expect(await listFeatureFiles(tmpProject, "tests")).toEqual([]);
  });

  it("lists only .feature files, sorted, ignoring other files", async () => {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "signup.feature"), "Feature: Signup\n", "utf-8");
    await fs.writeFile(path.join(dir, "login.feature"), "Feature: Login\n", "utf-8");
    await fs.writeFile(path.join(dir, "notes.txt"), "not a feature file\n", "utf-8");

    expect(await listFeatureFiles(tmpProject, "tests")).toEqual(["login.feature", "signup.feature"]);
  });
});
