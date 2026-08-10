import {
  createProvider,
  loadCredentials,
  loadProjectConfig,
  loadAllPatterns,
  runIntake,
  type IntakeCallbacks,
} from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";

export async function runCreatePlan(
  prompts: ChatPrompts,
  homeDir: string,
  projectRoot: string
): Promise<string> {
  const credentials = await loadCredentials(homeDir);
  if (!credentials) {
    throw new Error("No hay credenciales configuradas. Ejecuta 'agente-qa init' primero.");
  }

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const llm = createProvider(credentials);
  const patterns = await loadAllPatterns(projectRoot);
  const initialText = await prompts.inputInitialText();

  const callbacks: IntakeCallbacks = {
    askUser: (question) => prompts.askUser(question),
    presentForApproval: (plan) => prompts.presentForApproval(plan.featureText),
    offerSavePattern: () => prompts.offerSavePattern(),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
  };

  const { filePath } = await runIntake(
    initialText,
    llm,
    patterns,
    projectRoot,
    projectConfig.testsDir,
    callbacks
  );

  return filePath;
}
