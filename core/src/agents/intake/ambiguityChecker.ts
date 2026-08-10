import { z } from "zod";
import type { LLMProvider } from "../../llm/provider.js";
import { parseJsonResponse } from "../../llm/parseJson.js";
import { ambiguityCheckPrompt } from "../../prompts/intake.js";

const AmbiguityCheckSchema = z.object({
  ambiguous: z.boolean(),
  questions: z.array(z.string()),
});
export type AmbiguityCheck = z.infer<typeof AmbiguityCheckSchema>;

export async function checkAmbiguity(text: string, llm: LLMProvider): Promise<AmbiguityCheck> {
  const raw = await llm.generate([
    { role: "system", content: "Eres un analista de QA experto en escribir especificaciones Gherkin precisas." },
    { role: "user", content: ambiguityCheckPrompt(text) },
  ]);
  return parseJsonResponse(AmbiguityCheckSchema, raw);
}
