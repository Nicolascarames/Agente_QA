import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectGitignorePath,
  readProjectGitignoreEntries,
  appendProjectGitignoreEntries,
} from "./projectGitignore.js";

describe("projectGitignore", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-gitignore-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  describe("readProjectGitignoreEntries", () => {
    it("returns an empty array when no .gitignore exists", async () => {
      expect(await readProjectGitignoreEntries(tmpProject)).toEqual([]);
    });

    it("returns trimmed, non-empty lines from an existing .gitignore", async () => {
      await fs.writeFile(projectGitignorePath(tmpProject), "node_modules\n\n  tests/results  \n", "utf-8");
      expect(await readProjectGitignoreEntries(tmpProject)).toEqual(["node_modules", "tests/results"]);
    });
  });

  describe("appendProjectGitignoreEntries", () => {
    it("creates the .gitignore when it doesn't exist yet", async () => {
      await appendProjectGitignoreEntries(tmpProject, ["node_modules"]);
      expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe("node_modules\n");
    });

    it("appends to an existing .gitignore without touching what's already there", async () => {
      await fs.writeFile(projectGitignorePath(tmpProject), "dist\n", "utf-8");
      await appendProjectGitignoreEntries(tmpProject, ["node_modules", "tests/results"]);
      expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe(
        "dist\nnode_modules\ntests/results\n"
      );
    });

    it("adds a leading newline when the existing file doesn't end with one", async () => {
      await fs.writeFile(projectGitignorePath(tmpProject), "dist", "utf-8");
      await appendProjectGitignoreEntries(tmpProject, ["node_modules"]);
      expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe("dist\nnode_modules\n");
    });

    it("does nothing when entries is empty", async () => {
      await appendProjectGitignoreEntries(tmpProject, []);
      const exists = await fs.stat(projectGitignorePath(tmpProject)).then(() => true, () => false);
      expect(exists).toBe(false);
    });
  });
});
