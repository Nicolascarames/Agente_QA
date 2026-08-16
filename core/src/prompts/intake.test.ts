import { describe, it, expect } from "vitest";
import { gherkinGenerationPrompt } from "./intake.js";
import type { AppMap } from "../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: true, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Email", "Password"],
    probeValues: ["agente-qa-probe@example.invalid"],
    ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "log_in_button", kind: "button", accessibleName: "Log in",
      python: 'page.get_by_role("button", name="Log in", exact=True)', count: 1, verifiedAt: "t" }],
    states: [{ id: "invalid-submit",
      reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
      addsTexts: ["Authentication failed. Please try again."] }],
  }],
};

describe("gherkinGenerationPrompt", () => {
  it("demands English", () => {
    expect(gherkinGenerationPrompt("probar login", map, "login")).toMatch(/English|inglés/);
  });

  it("offers the screen's own texts and its states' texts as the only quotable literals", () => {
    const prompt = gherkinGenerationPrompt("probar login", map, "login");
    expect(prompt).toContain("Welcome back");
    expect(prompt).toContain("Authentication failed. Please try again.");
  });

  it("says which text each click produces, so a Then can assert the destination", () => {
    const prompt = gherkinGenerationPrompt("probar login", map, "login");
    expect(prompt).toMatch(/log_in_button[\s\S]*Authentication failed/);
  });

  it("never leaks the crawler's own probe values", () => {
    expect(gherkinGenerationPrompt("probar login", map, "login")).not.toContain("agente-qa-probe@example.invalid");
  });

  it("declares the screen tag the scenario must carry", () => {
    expect(gherkinGenerationPrompt("probar login", map, "login")).toContain("@screen:login");
  });

  it("forbids quoting anything that is not in the list", () => {
    expect(gherkinGenerationPrompt("probar login", map, "login")).toMatch(/no inventes|do not invent/i);
  });
});
