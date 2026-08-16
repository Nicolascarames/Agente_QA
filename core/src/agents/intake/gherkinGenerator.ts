import { z } from "zod";
import type { LLMProvider } from "../../llm/provider.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import type { AppMap } from "../../appMap/schema.js";
import { gherkinGenerationPrompt } from "../../prompts/intake.js";
import { parseJsonResponse } from "../../llm/parseJson.js";

const GherkinResponseSchema = z.object({
  fileName: z.string().min(1),
  featureText: z.string().min(1),
});

export async function generateGherkin(
  text: string,
  llm: LLMProvider,
  map: AppMap,
  screenId: string
): Promise<GherkinPlan> {
  const raw = await llm.generate([
    { role: "system", content: "Eres un analista de QA experto en especificaciones Gherkin." },
    { role: "user", content: gherkinGenerationPrompt(text, map, screenId) },
  ]);

  const { fileName, featureText } = parseJsonResponse(GherkinResponseSchema, raw);

  if (!/^\s*(@\S+\s*)*Feature:/.test(featureText)) {
    throw new Error(
      `La respuesta del modelo no parece un archivo Gherkin válido (no empieza por "Feature:"): ${featureText.slice(0, 80)}...`
    );
  }

  return { fileName, featureText };
}
