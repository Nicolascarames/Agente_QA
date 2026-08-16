import { describe, it, expect } from "vitest";
import { scenarioCandidatesPrompt } from "./explorador.js";
import type { AppMap } from "../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: true, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Authentication failed. Please try again."],
    probeValues: ["agente-qa-probe@example.invalid"],
    states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "log_in_button", kind: "button", accessibleName: "Log in", python: "x", count: 1, verifiedAt: "t" }],
  }],
};

describe("scenarioCandidatesPrompt", () => {
  it("includes each screen id and its texts", () => {
    const prompt = scenarioCandidatesPrompt(map);
    expect(prompt).toContain("login");
    expect(prompt).toContain("Authentication failed. Please try again.");
  });

  it("never includes the crawler's own probe values", () => {
    expect(scenarioCandidatesPrompt(map)).not.toContain("agente-qa-probe@example.invalid");
  });

  it("asks for JSON only", () => {
    expect(scenarioCandidatesPrompt(map)).toMatch(/JSON/);
  });
});
