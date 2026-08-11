import path from "node:path";
import {
  createProvider,
  loadCredentials,
  loadProjectConfig,
  loadAllPatterns,
  listFeatureFiles,
  realCodeChecker,
  runGenerador,
  type GeneratorCallbacks,
} from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";

export async function runGenerateTests(
  prompts: GeneratorPrompts,
  homeDir: string,
  projectRoot: string
): Promise<string[]> {
  const credentials = await loadCredentials(homeDir);
  if (!credentials) {
    throw new Error("No hay credenciales configuradas. Ejecuta 'agente-qa init' primero.");
  }

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const featureFiles = await listFeatureFiles(projectRoot, projectConfig.testsDir);
  if (featureFiles.length === 0) {
    throw new Error(
      "No hay ningún plan de pruebas (.feature) aprobado todavía. Usa 'Crear plan de pruebas' primero."
    );
  }

  const chosen = await prompts.selectFeatureFile(featureFiles);
  const featureFilePath = path.join(projectRoot, projectConfig.testsDir, "features", chosen);

  const llm = createProvider(credentials);
  const patterns = await loadAllPatterns(projectRoot);

  const callbacks: GeneratorCallbacks = {
    offerSavePattern: () => prompts.offerSavePattern(),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
  };

  const { writtenPaths } = await runGenerador(
    featureFilePath,
    llm,
    patterns,
    realCodeChecker,
    projectRoot,
    projectConfig.testsDir,
    callbacks
  );

  return writtenPaths;
}
