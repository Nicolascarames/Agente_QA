import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import type { ScreenEvidence } from "../../siteExplorer/siteExplorer.js";
import { gherkinGenerationPrompt } from "../../prompts/intake.js";
import { slugify } from "../../util/slugify.js";

function extractFeatureTitle(featureText: string): string {
  const match = featureText.match(/^Feature:\s*(.+)$/m);
  return match ? match[1].trim() : "plan de pruebas";
}

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:gherkin)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export async function generateGherkin(
  text: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null,
  appLanguage: "es" | "en",
  evidence: ScreenEvidence[]
): Promise<GherkinPlan> {
  const raw = await llm.generate([
    { role: "system", content: "Eres un analista de QA experto en especificaciones Gherkin." },
    { role: "user", content: gherkinGenerationPrompt(text, matchedPattern, appLanguage, evidence) },
  ]);

  const featureText = stripCodeFences(raw);

  if (!/^\s*(@\S+\s*)*Feature:/.test(featureText)) {
    throw new Error(
      `La respuesta del modelo no parece un archivo Gherkin válido (no empieza por "Feature:"): ${featureText.slice(0, 80)}...`
    );
  }

  const fileName = `${slugify(extractFeatureTitle(featureText))}.feature`;

  return { fileName, featureText, matchedPatternName: matchedPattern?.name ?? null };
}
