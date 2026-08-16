import {
  loadProjectEnv,
  loadProjectConfig,
  runIntake,
  type IntakeCallbacks,
  type AgentEvent,
} from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";
import { buildLlm } from "../util/buildLlm.js";
import { formatAgentEvent } from "../util/renderEvent.js";

export async function runCreatePlan(prompts: ChatPrompts, projectRoot: string): Promise<string> {
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const llm = await buildLlm(projectRoot);
  const initialText = await prompts.inputInitialText();

  const callbacks: IntakeCallbacks = {
    askUser: (question) => prompts.askUser(question),
    chooseScenario: (candidates) => prompts.chooseScenario(candidates),
    presentForApproval: (plan) => prompts.presentForApproval(plan.featureText),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
  };

  const { filePath } = await runIntake({
    initialText,
    llm,
    projectRoot,
    testsDir: projectConfig.testsDir,
    callbacks,
    emit: (event: AgentEvent) => {
      console.log(formatAgentEvent(event));
    },
  });

  return filePath;
}
