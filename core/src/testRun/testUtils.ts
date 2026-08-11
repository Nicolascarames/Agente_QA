import type { TestRunner, TestRunOptions, TestRunResult } from "./testRunner.js";

export class FakeTestRunner implements TestRunner {
  private results: TestRunResult[];
  public receivedCalls: TestRunOptions[] = [];

  constructor(results: TestRunResult[]) {
    this.results = [...results];
  }

  async run(options: TestRunOptions): Promise<TestRunResult> {
    this.receivedCalls.push(options);
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("FakeTestRunner: no hay más resultados programados");
    }
    return next;
  }
}
