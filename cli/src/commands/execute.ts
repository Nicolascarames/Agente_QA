import {
  loadProjectConfig,
  loadProjectEnv,
  requireAppUrl,
  testEnvVars,
  realTestRunner,
  runEjecutor,
  type ExecutorCallbacks,
  type EjecutorResult,
} from "@agente-qa/core";
import type { ExecutorPrompts } from "../prompts/types.js";
import { withTestRunnerSpinner } from "../util/spinner.js";

export async function runExecuteTests(prompts: ExecutorPrompts, projectRoot: string): Promise<EjecutorResult> {
  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  requireAppUrl(projectConfig);

  const callbacks: ExecutorCallbacks = {
    selectTags: (availableTags) => prompts.selectTags(availableTags),
    selectCaptureMode: () => prompts.selectCaptureMode(),
    onOutput: (chunk) => {
      process.stdout.write(chunk);
    },
  };

  return runEjecutor(
    projectRoot,
    projectConfig.testsDir,
    withTestRunnerSpinner(realTestRunner),
    projectConfig.headedMode,
    callbacks,
    testEnvVars(projectConfig, env)
  );
}
