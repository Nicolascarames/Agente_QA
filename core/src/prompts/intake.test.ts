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
    states: [
      { id: "invalid-submit",
        reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
        addsTexts: ["Authentication failed. Please try again."] },
      { id: "valid-submit",
        reachedBy: { action: "submit", locator: "log_in_button", data: "valid" },
        addsTexts: ["Welcome, User!"] },
    ],
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

  it("groups one locator's states by precondition instead of flattening them into one line", () => {
    const prompt = gherkinGenerationPrompt("probar login", map, "login");
    const locatorLines = prompt.split("\n").filter((line) => line.includes("log_in_button"));

    const invalidLine = locatorLines.find((line) => line.includes("Authentication failed. Please try again."));
    const validLine = locatorLines.find((line) => line.includes("Welcome, User!"));

    // Both preconditions must be represented...
    expect(invalidLine).toBeDefined();
    expect(validLine).toBeDefined();
    // ...as two DIFFERENT lines, not one flattened "hace aparecer: A, B" line — this
    // is what fails if the two states collapse back into a single undifferentiated list.
    expect(invalidLine).not.toBe(validLine);
    expect(invalidLine).not.toContain("Welcome, User!");
    expect(validLine).not.toContain("Authentication failed. Please try again.");
    // Each line names the data it required, not just the locator.
    expect(invalidLine).toMatch(/inválidos/);
    expect(validLine).toMatch(/válidos/);
    expect(validLine).not.toMatch(/inválidos/);
  });

  it("falls back to (ninguno) when a screen has no literals at all", () => {
    const emptyMap: AppMap = {
      ...map,
      screens: [{
        id: "blank", name: "Blank", className: "BlankPage", urlTemplate: "/blank",
        signature: "sha256:b", requiresAuth: false,
        texts: [], probeValues: [], locators: [], states: [], ambiguous: [],
        transitions: [], writeActions: [],
      }],
    };
    const prompt = gherkinGenerationPrompt("probar blank", emptyMap, "blank");
    // Isolate the literals block specifically — the fields block already falls back to
    // "(ninguno)" on an empty screen, so a bare toContain check would pass vacuously.
    const literalsSection = prompt
      .split("esa pantalla:")[1]
      ?.split("Campos que se pueden rellenar:")[0]
      ?.trim();
    expect(literalsSection).toBe("(ninguno)");
  });
});
