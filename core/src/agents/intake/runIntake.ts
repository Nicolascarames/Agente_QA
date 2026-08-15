import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import type { SiteExplorer, ExplorationCredentials, ScreenEvidence } from "../../siteExplorer/siteExplorer.js";
import { evidenceCacheKey, readCachedEvidence, writeCachedEvidence } from "../../siteExplorer/evidenceCache.js";
import { applyProjectRoute } from "../../patterns/applyProjectRoute.js";
import { checkAmbiguity } from "./ambiguityChecker.js";
import { matchPattern } from "../../patterns/matcher.js";
import { generateGherkin } from "./gherkinGenerator.js";
import { writeFeatureFile, featureFileExists, featureFilePath } from "./writeFeatureFile.js";

export interface IntakeCallbacks {
  askUser(question: string): Promise<string>;
  presentForApproval(plan: GherkinPlan): Promise<{ approved: boolean; feedback?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
  onExplorationStep(message: string): void;
}

export interface RunIntakeOptions {
  initialText: string;
  llm: LLMProvider;
  patterns: Pattern[];
  explorer: SiteExplorer;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  appLanguage: "es" | "en";
  routes: Record<string, string>;
  credentials?: ExplorationCredentials;
  callbacks: IntakeCallbacks;
}

export async function runIntake(
  options: RunIntakeOptions
): Promise<{ plan: GherkinPlan; filePath: string }> {
  const { llm, patterns, explorer, projectRoot, testsDir, baseUrl, appLanguage, routes, credentials, callbacks } =
    options;
  let text = options.initialText;

  const ambiguity = await checkAmbiguity(text, llm);
  if (ambiguity.ambiguous) {
    const answers: string[] = [];
    for (const question of ambiguity.questions) {
      const answer = await callbacks.askUser(question);
      answers.push(`${question}\n${answer}`);
    }
    text = `${text}\n\nAclaraciones:\n${answers.join("\n\n")}`;
  }

  const matched = await matchPattern(text, patterns, llm);

  const patternWithRoute = applyProjectRoute(matched, routes);
  const cacheKey = evidenceCacheKey({ appUrl: baseUrl, patternName: matched?.name ?? null, routes });

  let evidence: ScreenEvidence[] = (await readCachedEvidence(projectRoot, cacheKey)) ?? [];
  if (evidence.length === 0) {
    callbacks.onExplorationStep("Explorando la aplicación real para anclar los textos esperados...");
    const exploration = await explorer.explore(
      {
        featureText: text,
        matchedPattern: patternWithRoute,
        baseUrl,
        credentials,
        headed: false,
      },
      callbacks.onExplorationStep
    );
    if (exploration.ok) {
      evidence = exploration.screens;
      await writeCachedEvidence(projectRoot, cacheKey, evidence);
    } else {
      // Not fatal: the user still reviews and approves the .feature, and the
      // generator's verification blocks later if the literals don't hold up.
      callbacks.onExplorationStep(
        `No se pudo explorar la aplicación (${exploration.error}). Se generará el plan sin evidencia real.`
      );
    }
  }

  let plan = await generateGherkin(text, llm, matched, appLanguage, evidence);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const decision = await callbacks.presentForApproval(plan);
    if (decision.approved) break;
    text = `${text}\n\nPlan anterior:\n"""\n${plan.featureText}\n"""\n\nCambios solicitados sobre el plan anterior:\n${decision.feedback ?? ""}`;
    plan = await generateGherkin(text, llm, matched, appLanguage, evidence);
  }

  const alreadyExists = await featureFileExists(projectRoot, testsDir, plan.fileName);
  if (alreadyExists) {
    const targetPath = featureFilePath(projectRoot, testsDir, plan.fileName);
    const overwrite = await callbacks.confirmOverwrite(targetPath);
    if (!overwrite) {
      throw new Error(`Cancelado: ya existe ${targetPath} y no se sobrescribió.`);
    }
  }

  const filePath = await writeFeatureFile(projectRoot, testsDir, plan);

  return { plan, filePath };
}
