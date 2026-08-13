import type { SiteExplorer, ExplorationInput, ExplorationResult, ExplorationStepCallback } from "./siteExplorer.js";

export class FakeSiteExplorer implements SiteExplorer {
  private results: ExplorationResult[];
  public receivedCalls: ExplorationInput[] = [];

  constructor(results: ExplorationResult[]) {
    this.results = [...results];
  }

  async explore(input: ExplorationInput, onStep?: ExplorationStepCallback): Promise<ExplorationResult> {
    this.receivedCalls.push(input);
    onStep?.("explorando (fake)");
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("FakeSiteExplorer: no hay más resultados programados");
    }
    return next;
  }
}
