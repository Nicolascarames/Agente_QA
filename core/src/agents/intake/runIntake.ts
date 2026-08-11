import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import { checkAmbiguity } from "./ambiguityChecker.js";
import { matchPattern } from "../../patterns/matcher.js";
import { generateGherkin } from "./gherkinGenerator.js";
import { writeFeatureFile, featureFileExists, featureFilePath } from "./writeFeatureFile.js";

export interface IntakeCallbacks {
  askUser(question: string): Promise<string>;
  presentForApproval(plan: GherkinPlan): Promise<{ approved: boolean; feedback?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}

export async function runIntake(
  initialText: string,
  llm: LLMProvider,
  patterns: Pattern[],
  projectRoot: string,
  testsDir: string,
  callbacks: IntakeCallbacks
): Promise<{ plan: GherkinPlan; filePath: string }> {
  let text = initialText;

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

  let plan = await generateGherkin(text, llm, matched);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const decision = await callbacks.presentForApproval(plan);
    if (decision.approved) break;
    text = `${text}\n\nPlan anterior:\n"""\n${plan.featureText}\n"""\n\nCambios solicitados sobre el plan anterior:\n${decision.feedback ?? ""}`;
    plan = await generateGherkin(text, llm, matched);
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
