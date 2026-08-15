import type { Pattern } from "../schemas/pattern.js";

export interface ScreenEvidence {
  stepText: string;
  url: string;
  ariaSnapshot: string;
}

export interface ExplorationCredentials {
  username: string;
  password: string;
}

export interface ExplorationInput {
  featureText: string;
  matchedPattern: Pattern | null;
  baseUrl: string;
  credentials?: ExplorationCredentials;
  headed: boolean;
}

/**
 * `source` tells the caller which path produced a successful result:
 *  - "hints": a builtin/project pattern's navigationHints drove the exploration
 *    (exploreByHints). Deterministic given (appUrl, patternName, routes) — safe
 *    to cache and reuse across different feature requests that share those inputs.
 *  - "agentic": the LLM drove the exploration from the raw feature/request text
 *    (exploreAgentically). The result is specific to THAT text — two different
 *    feature requests with no matching pattern produce the identical cache key,
 *    so caching an agentic result would hand a later, unrelated feature the
 *    wrong app screens. Callers must never write an agentic result to the
 *    evidence cache (see evidenceCache.ts).
 */
export type ExplorationResult =
  | { ok: true; screens: ScreenEvidence[]; source: "hints" | "agentic" }
  | { ok: false; error: string };

export type ExplorationStepCallback = (message: string) => void;

export interface SiteExplorer {
  explore(input: ExplorationInput, onStep?: ExplorationStepCallback): Promise<ExplorationResult>;
}
