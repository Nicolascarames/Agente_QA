import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateScenarioCandidates } from "./scenarioCandidates.js";
import type { AppMap } from "../../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, screens: [], scenarios: [],
  stats: { screens: 0, locators: 0, ambiguous: 0, durationMs: 0 },
};

describe("generateScenarioCandidates", () => {
  it("parses the model's JSON into candidates", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify([{ id: "login-ok", title: "Log in with valid credentials", screenId: "login", involvedScreens: ["login"], rationale: "flujo principal" }]),
    ]);
    const candidates = await generateScenarioCandidates(map, llm);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe("Log in with valid credentials");
  });

  it("drops a malformed candidate instead of failing the whole crawl", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify([{ id: "ok", title: "Fine", screenId: "login", involvedScreens: [], rationale: "r" }, { title: "missing id" }]),
    ]);
    const candidates = await generateScenarioCandidates(map, llm);
    expect(candidates).toHaveLength(1);
  });

  it("returns an empty list when the model answers with nothing usable", async () => {
    const llm = new FakeLLMProvider(["no soy JSON"]);
    await expect(generateScenarioCandidates(map, llm)).resolves.toEqual([]);
  });
});
