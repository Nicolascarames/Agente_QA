import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { saveProjectConfig, ensureProjectEnvTemplate, projectEnvPath } from "@agente-qa/core";
import { runExecuteTests } from "./execute.js";

vi.mock("../util/openFile.js", () => ({
  openFile: vi.fn(),
}));

import { runGenerateReports } from "./reports.js";
import type { ExecutorPrompts, ReportesPrompts } from "../prompts/types.js";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}
function pytestStackAvailable(pythonCmd: string): boolean {
  return spawnSync(pythonCmd, ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"]).status === 0;
}
const hasPython = commandExists("python");
const hasPytestStack = hasPython && pytestStackAvailable("python");

describe.skipIf(!hasPytestStack)(
  "end-to-end: the real junit-xml pytest produces is parseable by Agente 4",
  () => {
    let tmpProject: string;

    beforeEach(async () => {
      tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-reports-e2e-project-"));
      await saveProjectConfig(tmpProject, { testsDir: "tests" });
      await ensureProjectEnvTemplate(tmpProject);
      // The sample pytest-bdd scenario below doesn't make any real network calls,
      // so this URL is only here to satisfy runExecuteTests' AGENTE_QA_APP_URL check.
      await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://example.com\n", "utf-8");
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

    it("runs the real pytest suite, then parses its real junit-xml into a summary", async () => {
      const executorPrompts: ExecutorPrompts = {
        selectTags: async (availableTags) => availableTags,
        selectCaptureMode: async () => "off",
      };
      const executeResult = await runExecuteTests(executorPrompts, tmpProject);
      expect(executeResult.exitCode).toBe(0);

      const reportesPrompts: ReportesPrompts = {
        selectDetailLevel: async () => "completo",
      };
      const result = await runGenerateReports(reportesPrompts, tmpProject);

      expect(result.totalTests).toBe(1);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);

      const summaryContent = await fs.readFile(result.summaryPath, "utf-8");
      expect(summaryContent).toContain("Ningún test falló.");
      expect(summaryContent).toContain("## Pasados");

      const htmlExists = await fs.access(result.htmlReportPath).then(
        () => true,
        () => false
      );
      expect(htmlExists).toBe(true);
    });
  }
);
