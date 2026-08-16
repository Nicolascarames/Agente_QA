import { z } from "zod";
import type { LLMProvider } from "../../llm/provider.js";
import { parseJsonResponse } from "../../llm/parseJson.js";
import { ScenarioCandidateSchema, type AppMap, type ScenarioCandidate } from "../../appMap/schema.js";
import { scenarioCandidatesPrompt } from "../../prompts/explorador.js";

/**
 * Candidate scenarios are a convenience, not the product: a malformed answer
 * must never throw away a map that took minutes of real browsing to build.
 */
export async function generateScenarioCandidates(map: AppMap, llm: LLMProvider): Promise<ScenarioCandidate[]> {
  let raw: unknown;
  try {
    raw = parseJsonResponse(z.array(z.unknown()), await llm.generate([{ role: "user", content: scenarioCandidatesPrompt(map) }]));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const candidates: ScenarioCandidate[] = [];
  for (const item of raw) {
    const parsed = ScenarioCandidateSchema.safeParse(item);
    if (parsed.success) candidates.push(parsed.data);
  }
  return candidates;
}
