import { describe, it, expect } from "vitest";
import { generateSummaryMarkdown } from "./generateSummaryMarkdown.js";
import type { JunitResults } from "./parseJunitResults.js";

const sampleResults: JunitResults = {
  totalTests: 3,
  passed: 1,
  failed: 1,
  skipped: 1,
  durationSeconds: 1.234,
  testCases: [
    { name: "test_ok", status: "passed" },
    { name: "test_fail", status: "failed", message: "AssertionError: boom" },
    { name: "test_skip", status: "skipped", message: "not ready" },
  ],
};

describe("generateSummaryMarkdown", () => {
  it("includes counts and duration in the header", () => {
    const md = generateSummaryMarkdown(sampleResults, "resumen");
    expect(md).toContain("Total: 3");
    expect(md).toContain("Pasados: 1");
    expect(md).toContain("Fallidos: 1");
    expect(md).toContain("Omitidos: 1");
    expect(md).toContain("Duración: 1.234s");
  });

  it("lists every failed test with its name and message", () => {
    const md = generateSummaryMarkdown(sampleResults, "resumen");
    expect(md).toContain("`test_fail` — AssertionError: boom");
  });

  it("says no test failed when there are no failures", () => {
    const noFailures: JunitResults = {
      ...sampleResults,
      failed: 0,
      testCases: [{ name: "test_ok", status: "passed" }],
    };
    const md = generateSummaryMarkdown(noFailures, "resumen");
    expect(md).toContain("Ningún test falló.");
  });

  it('"resumen" does not include a list of passed tests', () => {
    const md = generateSummaryMarkdown(sampleResults, "resumen");
    expect(md).not.toContain("## Pasados");
  });

  it('"completo" includes a list of passed tests', () => {
    const md = generateSummaryMarkdown(sampleResults, "completo");
    expect(md).toContain("## Pasados");
    expect(md).toContain("`test_ok`");
  });
});
