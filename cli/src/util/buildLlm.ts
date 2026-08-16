import {
  createProvider, loadProjectEnv, projectEnvPath, requireLlmConfig, type LLMProvider,
} from "@agente-qa/core";
import { withLLMSpinner } from "./spinner.js";

export async function buildLlm(projectRoot: string): Promise<LLMProvider> {
  const env = await loadProjectEnv(projectRoot);
  if (!env) throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  return withLLMSpinner(createProvider(requireLlmConfig(env, projectEnvPath(projectRoot))));
}
