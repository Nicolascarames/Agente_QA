import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadBuiltinPatterns,
  loadProjectPatterns,
  loadAllPatterns,
  saveProjectPattern,
} from "./registry.js";
import type { Pattern } from "../schemas/pattern.js";

describe("pattern registry", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-patterns-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("loads the 4 built-in patterns", () => {
    const patterns = loadBuiltinPatterns();
    expect(patterns.map((p) => p.name).sort()).toEqual(
      ["login", "logout", "password-reset", "signup"].sort()
    );
  });

  it("returns an empty array of project patterns when none saved yet", async () => {
    expect(await loadProjectPatterns(tmpProject)).toEqual([]);
  });

  it("saves and reloads a project pattern", async () => {
    const custom: Pattern = {
      name: "checkout",
      description: "Flujo de compra completo",
      gherkinTemplate: "Feature: Checkout\n  Scenario: x\n    Given a\n",
    };
    await saveProjectPattern(tmpProject, custom);
    const projectPatterns = await loadProjectPatterns(tmpProject);
    expect(projectPatterns).toEqual([custom]);
  });

  it("loadAllPatterns combines built-in and project patterns", async () => {
    const custom: Pattern = {
      name: "checkout",
      description: "Flujo de compra completo",
      gherkinTemplate: "Feature: Checkout\n  Scenario: x\n    Given a\n",
    };
    await saveProjectPattern(tmpProject, custom);
    const all = await loadAllPatterns(tmpProject);
    expect(all.length).toBe(5);
    expect(all.some((p) => p.name === "checkout")).toBe(true);
    expect(all.some((p) => p.name === "login")).toBe(true);
  });
});
