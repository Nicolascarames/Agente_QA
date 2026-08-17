import {
  loadProjectConfig,
  runReportes,
  type ReportesCallbacks,
  type ReportesResult,
  type AgentEvent,
} from "@agente-qa/core";
import type { ReportesPrompts } from "../prompts/types.js";
import { openFile } from "../util/openFile.js";
import { formatAgentEvent } from "../util/renderEvent.js";

export async function runGenerateReports(
  prompts: ReportesPrompts,
  projectRoot: string
): Promise<ReportesResult> {
  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  let detailLevel: "resumen" | "completo" = "resumen" as "resumen" | "completo"; // cast needed: TS can't prove this closure — passed to runReportes as an opaque callback — runs before this comparison, so it narrows detailLevel to the literal "resumen" without it
  const callbacks: ReportesCallbacks = {
    selectDetailLevel: async () => {
      detailLevel = await prompts.selectDetailLevel();
      return detailLevel;
    },
  };

  const result = await runReportes(projectRoot, projectConfig.testsDir, callbacks, (event: AgentEvent) => {
    console.log(formatAgentEvent(event));
  });

  await openFile("markdown", result.summaryPath);
  if (detailLevel === "completo") {
    await openFile("html", result.htmlReportPath);
  }

  return result;
}
