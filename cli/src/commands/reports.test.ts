import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig } from "@agente-qa/core";
import type { ReportesPrompts } from "../prompts/types.js";

const openFileMock = vi.fn();
vi.mock("../util/openFile.js", () => ({
  openFile: (...args: unknown[]) => openFileMock(...args),
}));

import { runGenerateReports } from "./reports.js";

const sampleXml = `<testsuites>
  <testsuite name="pytest" tests="1" time="0.4">
    <testcase classname="tests.test_x" name="test_ok" time="0.4" />
  </testsuite>
</testsuites>`;

describe("runGenerateReports", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-reports-project-"));
    openFileMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: ReportesPrompts = { selectDetailLevel: vi.fn() };
    await expect(runGenerateReports(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws a clear error when there are no results yet", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    const prompts: ReportesPrompts = { selectDetailLevel: vi.fn() };
    await expect(runGenerateReports(prompts, tmpProject)).rejects.toThrow(/Ejecutar tests/);
  });

  it("reads the junit-xml, asks for the detail level, and returns the result", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    const resultsDir = path.join(tmpProject, "tests", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, "latest.xml"), sampleXml, "utf-8");

    const prompts: ReportesPrompts = {
      selectDetailLevel: vi.fn().mockResolvedValue("resumen"),
    };

    const result = await runGenerateReports(prompts, tmpProject);

    expect(prompts.selectDetailLevel).toHaveBeenCalledTimes(1);
    expect(result.totalTests).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.summaryPath).toBe(path.join(resultsDir, "summary.md"));
  });

  it('opens only the markdown summary when the chosen level is "resumen"', async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    const resultsDir = path.join(tmpProject, "tests", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, "latest.xml"), sampleXml, "utf-8");

    const prompts: ReportesPrompts = {
      selectDetailLevel: vi.fn().mockResolvedValue("resumen"),
    };

    const result = await runGenerateReports(prompts, tmpProject);

    expect(openFileMock).toHaveBeenCalledTimes(1);
    expect(openFileMock).toHaveBeenCalledWith("markdown", result.summaryPath);
  });

  it('opens both the markdown summary and the html report when the chosen level is "completo"', async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    const resultsDir = path.join(tmpProject, "tests", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, "latest.xml"), sampleXml, "utf-8");

    const prompts: ReportesPrompts = {
      selectDetailLevel: vi.fn().mockResolvedValue("completo"),
    };

    const result = await runGenerateReports(prompts, tmpProject);

    expect(openFileMock).toHaveBeenCalledTimes(2);
    expect(openFileMock).toHaveBeenCalledWith("markdown", result.summaryPath);
    expect(openFileMock).toHaveBeenCalledWith("html", result.htmlReportPath);
  });
});
