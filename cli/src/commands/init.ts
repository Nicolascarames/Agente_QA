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

function normalizeGitignoreEntry(entry: string): string {
  return entry.replace(/^\/+/, "").replace(/\/+$/, "");
}

function gitignoreCandidates(testsDir: string): string[] {
  const normalizedTestsDir = testsDir.replace(/\/+$/, "");
  return ["node_modules", `${normalizedTestsDir}/results`, `${normalizedTestsDir}/test-results`];
}

export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  const headedMode = await prompts.confirmHeadedMode();
  const appUrl = await prompts.inputAppUrl();
  const appLanguage = await prompts.selectAppLanguage();
  const homeRoute = await prompts.inputRoute("página principal (home)");
  const loginRoute = await prompts.inputRoute("login");
  const extraRoutes = await prompts.promptAdditionalRoutes();
  const maxViewDepth = await prompts.inputMaxViewDepth();
  const routes: Record<string, string> = { home: homeRoute, ...(loginRoute ? { login: loginRoute } : {}), ...extraRoutes };
  await saveProjectConfig(projectRoot, { testsDir, headedMode, appUrl, appLanguage, routes, crawl: { maxViewDepth } });

  const { created, path: envPath } = await ensureProjectEnvTemplate(projectRoot);

  const existingGitignoreEntries = await readProjectGitignoreEntries(projectRoot);
  const normalizedExisting = existingGitignoreEntries.map(normalizeGitignoreEntry);
  const candidates = gitignoreCandidates(testsDir);
  const missing = candidates.filter((entry) => !normalizedExisting.includes(normalizeGitignoreEntry(entry)));
  let gitignoreEntriesAdded: string[] = [];
  if (missing.length > 0) {
    gitignoreEntriesAdded = await prompts.selectGitignoreEntries(missing);
    await appendProjectGitignoreEntries(projectRoot, gitignoreEntriesAdded);
  }

  return { testsDir, envPath, envCreated: created, gitignoreEntriesAdded };
}
