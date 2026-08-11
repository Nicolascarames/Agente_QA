import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReportes, type ReportesCallbacks } from "./runReportes.js";

const sampleXml = `<testsuites>
  <testsuite name="pytest" tests="2" time="0.9">
    <testcase classname="tests.test_x" name="test_ok" time="0.4" />
    <testcase classname="tests.test_x" name="test_fail" time="0.5">
      <failure message="AssertionError: boom">...</failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe("runReportes", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-runreportes-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  async function writeJunitXml(content: string): Promise<void> {
    const resultsDir = path.join(tmpProject, "tests", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, "latest.xml"), content, "utf-8");
  }

  it("throws a clear error when there are no results yet", async () => {
    const callbacks: ReportesCallbacks = { selectDetailLevel: vi.fn() };
    await expect(runReportes(tmpProject, "tests", callbacks)).rejects.toThrow(/Ejecutar tests/);
  });

  it("parses the junit-xml, asks for the detail level, and writes the summary", async () => {
    await writeJunitXml(sampleXml);
    const callbacks: ReportesCallbacks = {
      selectDetailLevel: vi.fn().mockResolvedValue("resumen"),
    };

    const result = await runReportes(tmpProject, "tests", callbacks);

    expect(callbacks.selectDetailLevel).toHaveBeenCalledTimes(1);
    expect(result.totalTests).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);

    const expectedResultsDir = path.join(tmpProject, "tests", "results");
    expect(result.junitXmlPath).toBe(path.join(expectedResultsDir, "latest.xml"));
    expect(result.htmlReportPath).toBe(path.join(expectedResultsDir, "latest.html"));
    expect(result.summaryPath).toBe(path.join(expectedResultsDir, "summary.md"));

    const summaryContent = await fs.readFile(result.summaryPath, "utf-8");
    expect(summaryContent).toContain("`test_fail` — AssertionError: boom");
  });

  it("writes a 'completo' summary including passed tests when requested", async () => {
    await writeJunitXml(sampleXml);
    const callbacks: ReportesCallbacks = {
      selectDetailLevel: vi.fn().mockResolvedValue("completo"),
    };

    const result = await runReportes(tmpProject, "tests", callbacks);

    const summaryContent = await fs.readFile(result.summaryPath, "utf-8");
    expect(summaryContent).toContain("## Pasados");
    expect(summaryContent).toContain("`test_ok`");
  });

  it("overwrites an existing summary.md without asking for confirmation", async () => {
    await writeJunitXml(sampleXml);
    const resultsDir = path.join(tmpProject, "tests", "results");
    await fs.writeFile(path.join(resultsDir, "summary.md"), "# resumen viejo\n", "utf-8");

    const callbacks: ReportesCallbacks = {
      selectDetailLevel: vi.fn().mockResolvedValue("resumen"),
    };
    const result = await runReportes(tmpProject, "tests", callbacks);

    const summaryContent = await fs.readFile(result.summaryPath, "utf-8");
    expect(summaryContent).not.toContain("resumen viejo");
  });
});
