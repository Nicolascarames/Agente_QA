import type { LocatorVerifier, LocatorCheck, LocatorVerificationResult } from "./locatorVerifier.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { ExplorationCredentials } from "../siteExplorer/siteExplorer.js";

export interface FakeLocatorVerifierCall {
  files: GeneratedFile[];
  checks: LocatorCheck[];
  urls: string[];
  credentials: ExplorationCredentials | undefined;
}

export class FakeLocatorVerifier implements LocatorVerifier {
  private results: LocatorVerificationResult[];
  public receivedCalls: FakeLocatorVerifierCall[] = [];

  constructor(results: LocatorVerificationResult[]) {
    this.results = [...results];
  }

  async verify(
    files: GeneratedFile[],
    checks: LocatorCheck[],
    urls: string[],
    credentials: ExplorationCredentials | undefined
  ): Promise<LocatorVerificationResult> {
    this.receivedCalls.push({ files, checks, urls, credentials });
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("FakeLocatorVerifier: no hay más resultados programados");
    }
    return next;
  }
}
