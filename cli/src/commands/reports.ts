import {
  loadProjectConfig,
  runReportes,
  type ReportesCallbacks,
  type ReportesResult,
} from "@agente-qa/core";
import type { ReportesPrompts } from "../prompts/types.js";

export async function runGenerateReports(
  prompts: ReportesPrompts,
  projectRoot: string
): Promise<ReportesResult> {
  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const callbacks: ReportesCallbacks = {
    selectDetailLevel: () => prompts.selectDetailLevel(),
  };

  return runReportes(projectRoot, projectConfig.testsDir, callbacks);
}
