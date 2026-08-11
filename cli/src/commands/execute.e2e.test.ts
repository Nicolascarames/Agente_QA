import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { saveProjectConfig } from "@agente-qa/core";
import { runExecuteTests } from "./execute.js";
import type { ExecutorPrompts } from "../prompts/types.js";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}
function pytestStackAvailable(pythonCmd: string): boolean {
  return spawnSync(pythonCmd, ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"]).status === 0;
}
const hasPython = commandExists("python");
const hasPytestStack = hasPython && pytestStackAvailable("python");

describe.skipIf(!hasPytestStack)(
  "end-to-end: execute tests via the real wiring (no LLM involved in this agent)",
  () => {
    let tmpProject: string;

    beforeEach(async () => {
      tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-exec-e2e-project-"));
      await saveProjectConfig(tmpProject, { testsDir: "tests" });
      const featuresDir = path.join(tmpProject, "tests", "features");
      const testsCodeDir = path.join(tmpProject, "tests", "tests");
      await fs.mkdir(featuresDir, { recursive: true });
      await fs.mkdir(testsCodeDir, { recursive: true });
      await fs.writeFile(
        path.join(featuresDir, "sample.feature"),
        "Feature: Sample\n  @smoke\n  Scenario: it works\n    Given a precondition\n    When an action happens\n    Then the outcome is correct\n",
        "utf-8"
      );
      await fs.writeFile(
        path.join(testsCodeDir, "test_sample.py"),
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
    });

    afterEach(async () => {
      await fs.rm(tmpProject, { recursive: true, force: true });
    });

    it("runs the generated test and writes the junit-xml and the html report", async () => {
      const prompts: ExecutorPrompts = {
        selectTags: async (availableTags) => availableTags,
        selectCaptureMode: async () => "off",
      };

      const result = await runExecuteTests(prompts, tmpProject);

      expect(result.exitCode).toBe(0);
      const xmlExists = await fs.access(result.junitXmlPath).then(
        () => true,
        () => false
      );
      expect(xmlExists).toBe(true);
      const htmlExists = await fs.access(result.htmlReportPath).then(
        () => true,
        () => false
      );
      expect(htmlExists).toBe(true);
    });
  }
);
