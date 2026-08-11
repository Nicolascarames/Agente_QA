import { promises as fs } from "node:fs";
import path from "node:path";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";

export function featureFilePath(projectRoot: string, testsDir: string, fileName: string): string {
  return path.join(projectRoot, testsDir, "features", fileName);
}

export async function featureFileExists(
  projectRoot: string,
  testsDir: string,
  fileName: string
): Promise<boolean> {
  try {
    await fs.access(featureFilePath(projectRoot, testsDir, fileName));
    return true;
  } catch {
    return false;
  }
}

export async function writeFeatureFile(
  projectRoot: string,
  testsDir: string,
  plan: GherkinPlan
): Promise<string> {
  const dir = path.join(projectRoot, testsDir, "features");
  await fs.mkdir(dir, { recursive: true });
  const filePath = featureFilePath(projectRoot, testsDir, plan.fileName);
  const content = plan.matchedPatternName
    ? `# agente-qa:pattern=${plan.matchedPatternName}\n${plan.featureText}`
    : plan.featureText;
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}
