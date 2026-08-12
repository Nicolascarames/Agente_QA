import { ensureProjectEnvTemplate, saveProjectConfig } from "@agente-qa/core";
import type { InitPrompts } from "../prompts/types.js";

export interface InitResult {
  testsDir: string;
  envPath: string;
  envCreated: boolean;
}

export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  await saveProjectConfig(projectRoot, { testsDir });

  const { created, path: envPath } = await ensureProjectEnvTemplate(projectRoot);

  return { testsDir, envPath, envCreated: created };
}
