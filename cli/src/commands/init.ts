import { saveCredentials, saveProjectConfig } from "@agente-qa/core";
import type { InitPrompts } from "../prompts/types.js";

export async function runInit(prompts: InitPrompts, homeDir: string, projectRoot: string): Promise<void> {
  const provider = await prompts.selectProvider();
  const apiKey = await prompts.inputApiKey(provider);

  if (provider === "openai-compatible") {
    const baseURL = await prompts.inputBaseURL();
    const model = await prompts.inputModel();
    await saveCredentials({ provider, apiKey, baseURL, model }, homeDir);
  } else {
    await saveCredentials({ provider, apiKey }, homeDir);
  }

  const testsDir = await prompts.inputTestsDir();
  await saveProjectConfig(projectRoot, { testsDir });
}
