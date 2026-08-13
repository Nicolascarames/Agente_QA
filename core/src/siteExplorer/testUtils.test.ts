import { describe, it, expect } from "vitest";
import { FakeSiteExplorer } from "./testUtils.js";
import type { ExplorationInput } from "./siteExplorer.js";

function input(overrides: Partial<ExplorationInput> = {}): ExplorationInput {
  return {
    featureText: "Feature: Login\n",
    matchedPattern: null,
    baseUrl: "https://example.com",
    headed: false,
    ...overrides,
  };
}

describe("FakeSiteExplorer", () => {
  it("returns scripted results in order and records the input it was called with", async () => {
    const fake = new FakeSiteExplorer([
      { ok: true, screens: [] },
      { ok: false, error: "no se encontró la ruta" },
    ]);

    const first = await fake.explore(input({ baseUrl: "https://a.com" }));
    expect(first).toEqual({ ok: true, screens: [] });

    const second = await fake.explore(input());
    expect(second).toEqual({ ok: false, error: "no se encontró la ruta" });

    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0].baseUrl).toBe("https://a.com");
  });

  it("calls onStep when provided", async () => {
    const fake = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const steps: string[] = [];

    await fake.explore(input(), (message) => steps.push(message));

    expect(steps.length).toBeGreaterThan(0);
  });

  it("throws when out of scripted results", async () => {
    const fake = new FakeSiteExplorer([]);
    await expect(fake.explore(input())).rejects.toThrow();
  });
});
