import { promises as fs } from "node:fs";
import path from "node:path";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";

export async function writeFeatureFile(
  projectRoot: string,
  testsDir: string,
  plan: GherkinPlan
): Promise<string> {
  const dir = path.join(projectRoot, testsDir, "features");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, plan.fileName);
  await fs.writeFile(filePath, plan.featureText, "utf-8");
  return filePath;
}
