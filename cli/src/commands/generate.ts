import path from "node:path";
import {
  createProvider,
  loadProjectEnv,
  requireLlmConfig,
  requireAppUrl,
  loadProjectConfig,
  listFeatureFiles,
  realCodeChecker,
  createRealLocatorVerifier,
  runGenerador,
  projectEnvPath,
  type GeneratorCallbacks,
  type AgentEvent,
} from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";
import { withLLMSpinner, withCodeCheckerSpinner, withLocatorVerifierSpinner } from "../util/spinner.js";
import { formatAgentEvent } from "../util/renderEvent.js";

export async function runGenerateTests(prompts: GeneratorPrompts, projectRoot: string): Promise<string[]> {
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const llmCredentials = requireLlmConfig(env, projectEnvPath(projectRoot));

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const baseUrl = requireAppUrl(projectConfig);

  const featureFiles = await listFeatureFiles(projectRoot, projectConfig.testsDir);
  if (featureFiles.length === 0) {
    throw new Error(
      "No hay ningún plan de pruebas (.feature) aprobado todavía. Usa 'Crear plan de pruebas' primero."
    );
  }

  const chosen = await prompts.selectFeatureFile(featureFiles);
  const featureFilePath = path.join(projectRoot, projectConfig.testsDir, "features", chosen);

  const llm = withLLMSpinner(createProvider(llmCredentials));
  const credentials =
    env.testUsername && env.testPassword ? { username: env.testUsername, password: env.testPassword } : undefined;

  const callbacks: GeneratorCallbacks = {
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
    onStaleLocator: (stale) => prompts.onStaleLocator(stale),
  };

  const { writtenPaths } = await runGenerador({
    featureFilePath,
    llm,
    checker: withCodeCheckerSpinner(realCodeChecker),
    verifier: withLocatorVerifierSpinner(createRealLocatorVerifier()),
    projectRoot,
    testsDir: projectConfig.testsDir,
    baseUrl,
    credentials,
    callbacks,
    emit: (event: AgentEvent) => {
      console.log(formatAgentEvent(event));
    },
  });

  return writtenPaths;
}
