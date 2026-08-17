import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmitEvent } from "../../events/agentEvent.js";
import { parseJunitResults } from "./parseJunitResults.js";
import { generateSummaryMarkdown } from "./generateSummaryMarkdown.js";

export interface ReportesCallbacks {
  selectDetailLevel(): Promise<"resumen" | "completo">;
}

export interface ReportesResult {
  junitXmlPath: string;
  htmlReportPath: string;
  summaryPath: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
}

export async function runReportes(
  projectRoot: string,
  testsDir: string,
  callbacks: ReportesCallbacks,
  emit: EmitEvent
): Promise<ReportesResult> {
  emit({ agent: "reportes", status: "start", depth: 0, message: "Generación de reportes" });
  const startedAt = Date.now();

  const resultsDir = path.join(projectRoot, testsDir, "results");
  const junitXmlPath = path.join(resultsDir, "latest.xml");

  let xml: string;
  try {
    xml = await fs.readFile(junitXmlPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("No hay resultados de ejecución todavía. Usa 'Ejecutar tests' primero.");
    }
    throw err;
  }

  const results = parseJunitResults(xml);
  const htmlReportPath = path.join(resultsDir, "latest.html");

  const detailLevel = await callbacks.selectDetailLevel();
  const markdown = generateSummaryMarkdown(results, detailLevel);

  const summaryPath = path.join(resultsDir, "summary.md");
  await fs.writeFile(summaryPath, markdown, "utf-8");

  emit({
    agent: "reportes", status: "ok", depth: 0,
    message: `${results.passed} pasado(s), ${results.failed} fallido(s), ${results.skipped} omitido(s) — resumen en ${summaryPath}`,
    durationMs: Date.now() - startedAt,
  });

  return {
    junitXmlPath,
    htmlReportPath,
    summaryPath,
    totalTests: results.totalTests,
    passed: results.passed,
    failed: results.failed,
    skipped: results.skipped,
  };
}
