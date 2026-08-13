import {
  loadProjectConfig,
  runReportes,
  type ReportesCallbacks,
  type ReportesResult,
} from "@agente-qa/core";
import type { ReportesPrompts } from "../prompts/types.js";
import { openFile } from "../util/openFile.js";

export async function runGenerateReports(
  prompts: ReportesPrompts,
  projectRoot: string
): Promise<ReportesResult> {
  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  let detailLevel: "resumen" | "completo" = "resumen" as "resumen" | "completo";
  const callbacks: ReportesCallbacks = {
    selectDetailLevel: async () => {
      detailLevel = await prompts.selectDetailLevel();
      return detailLevel;
    },
  };

  const result = await runReportes(projectRoot, projectConfig.testsDir, callbacks);

  await openFile("markdown", result.summaryPath);
  if (detailLevel === "completo") {
    await openFile("html", result.htmlReportPath);
  }

  return result;
}
