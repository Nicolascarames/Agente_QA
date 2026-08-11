import { describe, it, expect } from "vitest";
import { FakeTestRunner } from "./testUtils.js";
import type { TestRunOptions } from "./testRunner.js";

function options(overrides: Partial<TestRunOptions> = {}): TestRunOptions {
  return {
    cwd: "/tmp/project/tests",
    markerExpression: null,
    screenshotMode: "off",
    videoMode: "off",
    junitXmlPath: "/tmp/project/tests/results/latest.xml",
    onOutput: () => {},
    ...overrides,
  };
}

describe("FakeTestRunner", () => {
  it("returns scripted results in order and records the options it was called with", async () => {
    const fake = new FakeTestRunner([{ exitCode: 1 }, { exitCode: 0 }]);

    const first = await fake.run(options({ markerExpression: "smoke" }));
    expect(first).toEqual({ exitCode: 1 });

    const second = await fake.run(options());
    expect(second).toEqual({ exitCode: 0 });

    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0].markerExpression).toBe("smoke");
  });

  it("throws when out of scripted results", async () => {
    const fake = new FakeTestRunner([]);
    await expect(fake.run(options())).rejects.toThrow();
  });
});
