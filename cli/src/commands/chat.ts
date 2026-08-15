import {
  createProvider,
  loadProjectEnv,
  requireLlmConfig,
  requireAppUrl,
  loadProjectConfig,
  loadAllPatterns,
  createRealSiteExplorer,
  runIntake,
  projectEnvPath,
  type IntakeCallbacks,
} from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";
import { withLLMSpinner } from "../util/spinner.js";

export async function runCreatePlan(prompts: ChatPrompts, projectRoot: string): Promise<string> {
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const llmCredentials = requireLlmConfig(env, projectEnvPath(projectRoot));

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const llm = withLLMSpinner(createProvider(llmCredentials));
  const patterns = await loadAllPatterns(projectRoot);
  const explorer = createRealSiteExplorer(llm);
  const credentials =
    env.testUsername && env.testPassword ? { username: env.testUsername, password: env.testPassword } : undefined;
  const baseUrl = requireAppUrl(projectConfig);
  const initialText = await prompts.inputInitialText();

  const callbacks: IntakeCallbacks = {
    askUser: (question) => prompts.askUser(question),
    presentForApproval: (plan) => prompts.presentForApproval(plan.featureText),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
    onExplorationStep: (message: string) => {
      console.log(message);
    },
  };

  const { filePath } = await runIntake({
    initialText,
    llm,
    patterns,
    explorer,
    projectRoot,
    testsDir: projectConfig.testsDir,
    baseUrl,
    appLanguage: projectConfig.appLanguage,
    routes: projectConfig.routes,
    credentials,
    callbacks,
  });

  return filePath;
}
