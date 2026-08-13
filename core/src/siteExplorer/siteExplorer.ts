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

export type ExplorationResult = { ok: true; screens: ScreenEvidence[] } | { ok: false; error: string };

export type ExplorationStepCallback = (message: string) => void;

export interface SiteExplorer {
  explore(input: ExplorationInput, onStep?: ExplorationStepCallback): Promise<ExplorationResult>;
}
