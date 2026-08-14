import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRealLocatorVerifier, MissingLocatorVerifierToolError } from "./realLocatorVerifier.js";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}

function pytestStackAvailable(pythonCmd: string): boolean {
  return spawnSync(pythonCmd, ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"]).status === 0;
}

const hasPython = commandExists("python");
const hasPytestStack = hasPython && pytestStackAvailable("python");

describe("realLocatorVerifier missing tool handling", () => {
  it("throws MissingLocatorVerifierToolError when the python command doesn't exist", async () => {
    const verifier = createRealLocatorVerifier({ pythonCommand: "agente-qa-definitely-missing-python" });
    await expect(verifier.verify([], [], "https://example.com", undefined)).rejects.toThrow(
      MissingLocatorVerifierToolError
    );
  });

  it("throws MissingLocatorVerifierToolError when pytest/pytest-bdd/pytest-playwright/pytest-html aren't importable", async () => {
    if (!hasPython || hasPytestStack) return; // can't reproduce "modules missing" without an interpreter that actually lacks them
    const verifier = createRealLocatorVerifier({ pythonCommand: "python" });
    await expect(verifier.verify([], [], "https://example.com", undefined)).rejects.toThrow(
      MissingLocatorVerifierToolError
    );
  });
});
