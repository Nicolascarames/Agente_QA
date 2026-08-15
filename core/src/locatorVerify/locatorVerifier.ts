import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { ExplorationCredentials } from "../siteExplorer/siteExplorer.js";

export interface LocatorCheck {
  method: string;
  argument: string;
}

export interface LocatorVerificationResult {
  ok: boolean;
  errors?: string;
  warnings?: string;
}

export interface LocatorVerifier {
  verify(
    files: GeneratedFile[],
    checks: LocatorCheck[],
    urls: string[],
    credentials: ExplorationCredentials | undefined
  ): Promise<LocatorVerificationResult>;
}
