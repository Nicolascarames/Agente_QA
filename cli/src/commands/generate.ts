import path from "node:path";
import {
  createProvider,
  loadProjectEnv,
  requireLlmConfig,
  requireAppUrl,
  loadProjectConfig,
  loadAllPatterns,
  listFeatureFiles,
  realCodeChecker,
  createRealSiteExplorer,
  runGenerador,
  projectEnvPath,
  type GeneratorCallbacks,
} from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";
import { withLLMSpinner, withCodeCheckerSpinner } from "../util/spinner.js";

export async function runGenerateTests(prompts: GeneratorPrompts, projectRoot: string): Promise<string[]> {
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const llmCredentials = requireLlmConfig(env, projectEnvPath(projectRoot));
  const baseUrl = requireAppUrl(env, projectEnvPath(projectRoot));

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

  const llm = withLLMSpinner(createProvider(llmCredentials));
  const patterns = await loadAllPatterns(projectRoot);
  const explorer = createRealSiteExplorer(llm);
  const credentials =
    env.testUsername && env.testPassword ? { username: env.testUsername, password: env.testPassword } : undefined;

  const callbacks: GeneratorCallbacks = {
    offerSavePattern: () => prompts.offerSavePattern(),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
    onExplorationStep: (message) => {
      console.log(message);
    },
  };

  const { writtenPaths } = await runGenerador({
    featureFilePath,
    llm,
    patterns,
    checker: withCodeCheckerSpinner(realCodeChecker),
    explorer,
    projectRoot,
    testsDir: projectConfig.testsDir,
    baseUrl,
    credentials,
    callbacks,
  });

  return writtenPaths;
}
