import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { ExplorationCredentials } from "../siteExplorer/siteExplorer.js";

export interface LocatorCheck {
  method: string;
  argument: string;
}

export interface LocatorVerificationResult {
  ok: boolean;
  errors?: string;
}

export interface LocatorVerifier {
  verify(
    files: GeneratedFile[],
    checks: LocatorCheck[],
    baseUrl: string,
    credentials: ExplorationCredentials | undefined
  ): Promise<LocatorVerificationResult>;
}
