import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRealCodeChecker, realCodeChecker, MissingCodeToolError } from "./realCodeChecker.js";

function commandExists(cmd: string): boolean {
  const result = spawnSync(cmd, ["--version"]);
  return result.error === undefined;
}

const hasPython = commandExists("python");
const hasRuff = commandExists("ruff");

describe("realCodeChecker missing tool handling", () => {
  it("throws MissingCodeToolError when the python command doesn't exist", async () => {
    const checker = createRealCodeChecker({ pythonCommand: "agente-qa-definitely-missing-python" });
    await expect(
      checker.check([{ path: "tests/test_x.py", content: "x = 1\n" }])
    ).rejects.toThrow(MissingCodeToolError);
  });

  it("throws MissingCodeToolError when the ruff command doesn't exist", async () => {
    const checker = createRealCodeChecker({
      pythonCommand: hasPython ? "python" : "python3",
      ruffCommand: "agente-qa-definitely-missing-ruff",
    });
    if (!hasPython) return; // can't isolate the ruff failure without a working python step first
    await expect(
      checker.check([{ path: "tests/test_x.py", content: "x = 1\n" }])
    ).rejects.toThrow(MissingCodeToolError);
  });

  it("rejects a file path that escapes the temp directory before spawning anything", async () => {
    const checker = createRealCodeChecker();
    await expect(
      checker.check([{ path: "../../evil.py", content: "x = 1\n" }])
    ).rejects.toThrow(/no permitida/);
  });
});

describe.skipIf(!hasPython || !hasRuff)("realCodeChecker (requires Python + ruff on PATH)", () => {
  it("reports ok:true for valid, clean Python", async () => {
    const result = await realCodeChecker.check([
      { path: "tests/test_ok.py", content: "def test_ok():\n    assert True\n" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("reports ok:false with a syntax error", async () => {
    const result = await realCodeChecker.check([
      { path: "tests/test_bad.py", content: "def test_bad(:\n    pass\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toBeTruthy();
  });
});
