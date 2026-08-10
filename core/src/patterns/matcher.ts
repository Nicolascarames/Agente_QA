import { z } from "zod";
import type { LLMProvider } from "../llm/provider.js";
import { parseJsonResponse } from "../llm/parseJson.js";
import { patternMatchPrompt } from "../prompts/intake.js";
import type { Pattern } from "../schemas/pattern.js";

const MatchResultSchema = z.object({ matchedPatternName: z.string().nullable() });

export async function matchPattern(
  text: string,
  patterns: Pattern[],
  llm: LLMProvider
): Promise<Pattern | null> {
  if (patterns.length === 0) return null;

  const raw = await llm.generate([
    { role: "system", content: "Identificas si una petición de QA encaja con un patrón de prueba conocido." },
    { role: "user", content: patternMatchPrompt(text, patterns.map((p) => ({ name: p.name, description: p.description }))) },
  ]);

  const result = parseJsonResponse(MatchResultSchema, raw);
  if (!result.matchedPatternName) return null;
  return patterns.find((p) => p.name === result.matchedPatternName) ?? null;
}
