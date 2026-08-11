import type { CodeChecker, CodeFile, CodeCheckResult } from "./codeChecker.js";

export class FakeCodeChecker implements CodeChecker {
  private results: CodeCheckResult[];
  public receivedCalls: CodeFile[][] = [];

  constructor(results: CodeCheckResult[]) {
    this.results = [...results];
  }

  async check(files: CodeFile[]): Promise<CodeCheckResult> {
    this.receivedCalls.push([...files]);
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("FakeCodeChecker: no hay más resultados programados");
    }
    return next;
  }
}
