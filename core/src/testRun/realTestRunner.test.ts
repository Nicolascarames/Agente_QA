import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRealTestRunner, realTestRunner, MissingTestToolError } from "./realTestRunner.js";
import type { TestRunOptions } from "./testRunner.js";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}

function pytestStackAvailable(pythonCmd: string): boolean {
  return spawnSync(pythonCmd, ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"]).status === 0;
}

const hasPython = commandExists("python");
const hasPytestStack = hasPython && pytestStackAvailable("python");

function baseOptions(overrides: Partial<TestRunOptions> = {}): TestRunOptions {
  return {
    cwd: process.cwd(),
    markerExpression: null,
    screenshotMode: "off",
    videoMode: "off",
    junitXmlPath: path.join(os.tmpdir(), "agente-qa-realtestrunner-preflight.xml"),
    htmlReportPath: path.join(os.tmpdir(), "agente-qa-realtestrunner-preflight.html"),
    onOutput: () => {},
    ...overrides,
  };
}

describe("realTestRunner missing tool handling", () => {
  it("throws MissingTestToolError when the python command doesn't exist", async () => {
    const runner = createRealTestRunner({ pythonCommand: "agente-qa-definitely-missing-python" });
    await expect(runner.run(baseOptions())).rejects.toThrow(MissingTestToolError);
  });

  it("throws MissingTestToolError when pytest/pytest-bdd/pytest-playwright/pytest-html aren't importable", async () => {
    if (!hasPython || hasPytestStack) return; // can't reproduce "modules missing" without an interpreter that actually lacks them
    const runner = createRealTestRunner({ pythonCommand: "python" });
    await expect(runner.run(baseOptions())).rejects.toThrow(MissingTestToolError);
  });
});

describe.skipIf(!hasPytestStack)(
  "realTestRunner (requires Python + pytest + pytest-bdd + pytest-playwright + pytest-html on PATH)",
  () => {
    it("runs a trivial pytest-bdd scenario and writes the junit-xml and the html report", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-realtestrunner-"));
      try {
        await fs.mkdir(path.join(tmpDir, "features"), { recursive: true });
        await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, "features", "sample.feature"),
          "Feature: Sample\n  @smoke\n  Scenario: it works\n    Given a precondition\n    When an action happens\n    Then the outcome is correct\n",
          "utf-8"
        );
        await fs.writeFile(
          path.join(tmpDir, "tests", "test_sample.py"),
          `from pytest_bdd import scenarios, given, when, then

scenarios("../features/sample.feature")


@given("a precondition")
def _():
    pass


@when("an action happens")
def _():
    pass


@then("the outcome is correct")
def _():
    pass
`,
          "utf-8"
        );

        const junitXmlPath = path.join(tmpDir, "results", "latest.xml");
        const htmlReportPath = path.join(tmpDir, "results", "latest.html");
        await fs.mkdir(path.dirname(junitXmlPath), { recursive: true });

        let output = "";
        const result = await realTestRunner.run({
          cwd: tmpDir,
          markerExpression: null,
          screenshotMode: "off",
          videoMode: "off",
          junitXmlPath,
          htmlReportPath,
          onOutput: (chunk) => {
            output += chunk;
          },
        });

        expect(result.exitCode).toBe(0);
        expect(output.length).toBeGreaterThan(0);
        const xmlExists = await fs.access(junitXmlPath).then(
          () => true,
          () => false
        );
        expect(xmlExists).toBe(true);
        const htmlExists = await fs.access(htmlReportPath).then(
          () => true,
          () => false
        );
        expect(htmlExists).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  }
);
