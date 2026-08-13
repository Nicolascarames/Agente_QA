import {
  ensureProjectEnvTemplate,
  saveProjectConfig,
  readProjectGitignoreEntries,
  appendProjectGitignoreEntries,
} from "@agente-qa/core";
import type { InitPrompts } from "../prompts/types.js";

export interface InitResult {
  testsDir: string;
  envPath: string;
  envCreated: boolean;
  gitignoreEntriesAdded: string[];
}

function gitignoreCandidates(testsDir: string): string[] {
  return ["node_modules", `${testsDir}/results`, `${testsDir}/test-results`];
}

export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  const headedMode = await prompts.confirmHeadedMode();
  await saveProjectConfig(projectRoot, { testsDir, headedMode });

  const { created, path: envPath } = await ensureProjectEnvTemplate(projectRoot);

  const existingGitignoreEntries = await readProjectGitignoreEntries(projectRoot);
  const candidates = gitignoreCandidates(testsDir);
  const missing = candidates.filter((entry) => !existingGitignoreEntries.includes(entry));
  let gitignoreEntriesAdded: string[] = [];
  if (missing.length > 0) {
    gitignoreEntriesAdded = await prompts.selectGitignoreEntries(missing);
    await appendProjectGitignoreEntries(projectRoot, gitignoreEntriesAdded);
  }

  return { testsDir, envPath, envCreated: created, gitignoreEntriesAdded };
}
