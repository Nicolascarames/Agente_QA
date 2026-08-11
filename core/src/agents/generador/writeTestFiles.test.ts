import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTestFiles, testFileExists, testFilePath } from "./writeTestFiles.js";

describe("writeTestFiles", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-writetests-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("writes each file under <testsDir>/<relative path> and returns the written paths", async () => {
    const written = await writeTestFiles(tmpProject, "tests", [
      { path: "tests/test_login.py", content: "x = 1\n" },
      { path: "pages/login_page.py", content: "y = 2\n" },
    ]);

    expect(written.sort()).toEqual(
      [
        path.join(tmpProject, "tests", "tests", "test_login.py"),
        path.join(tmpProject, "tests", "pages", "login_page.py"),
      ].sort()
    );
    expect(await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")).toBe("x = 1\n");
  });

  it("treats conftest.py like any other file (no longer skipped when it already exists)", async () => {
    const conftestPath = testFilePath(tmpProject, "tests", "conftest.py");
    await fs.mkdir(path.dirname(conftestPath), { recursive: true });
    await fs.writeFile(conftestPath, "# fixtures antiguas\n", "utf-8");

    const written = await writeTestFiles(tmpProject, "tests", [
      { path: "conftest.py", content: "import pytest\n" },
    ]);

    expect(written).toEqual([conftestPath]);
    expect(await fs.readFile(conftestPath, "utf-8")).toBe("import pytest\n");
  });

  it("testFileExists reports existence correctly", async () => {
    expect(await testFileExists(tmpProject, "tests", "tests/test_login.py")).toBe(false);
    await writeTestFiles(tmpProject, "tests", [{ path: "tests/test_login.py", content: "x = 1\n" }]);
    expect(await testFileExists(tmpProject, "tests", "tests/test_login.py")).toBe(true);
  });

  it("rejects a generated file path that escapes the tests directory", async () => {
    await expect(
      writeTestFiles(tmpProject, "tests", [{ path: "../../evil.py", content: "x = 1\n" }])
    ).rejects.toThrow(/no permitida/);
  });
});
