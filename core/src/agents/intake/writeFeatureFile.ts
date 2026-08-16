import { promises as fs } from "node:fs";
import path from "node:path";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import { slugify } from "../../util/slugify.js";

/**
 * The Gherkin prompt embeds text scraped from the application under test, so
 * the model's `fileName` is influenced by content that application's authors
 * control — not just by the user's request. Reduce it to a safe basename
 * before it ever becomes part of a path: drop any directory components,
 * slugify what remains, and force the `.feature` extension.
 */
function sanitizeFeatureFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/\.feature$/i, "");
  const slug = slugify(base);
  return `${slug.length > 0 ? slug : "plan"}.feature`;
}

/**
 * The single place all three exported functions route `fileName` through, so
 * the existence check and the write can never disagree about the target. The
 * containment check is a backstop: sanitization above already guarantees it,
 * but a model-controlled name is worth double-checking before touching disk.
 */
export function featureFilePath(projectRoot: string, testsDir: string, fileName: string): string {
  const featuresDir = path.join(projectRoot, testsDir, "features");
  const filePath = path.join(featuresDir, sanitizeFeatureFileName(fileName));

  const resolvedFeaturesDir = path.resolve(featuresDir);
  const resolvedFilePath = path.resolve(filePath);
  if (resolvedFilePath !== resolvedFeaturesDir && !resolvedFilePath.startsWith(resolvedFeaturesDir + path.sep)) {
    throw new Error(`Nombre de archivo de plan no válido: "${fileName}".`);
  }

  return filePath;
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
  await fs.writeFile(filePath, plan.featureText, "utf-8");
  return filePath;
}
