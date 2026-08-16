import { describe, it, expect } from "vitest";
import { checkFeatureLiterals } from "./checkFeatureLiterals.js";
import type { AppMap } from "../../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Email"], probeValues: [], locators: [],
    ambiguous: [], transitions: [], writeActions: [],
    states: [{ id: "invalid", reachedBy: { action: "submit", locator: "b", data: "invalid" },
      addsTexts: ["Authentication failed. Please try again."] }],
  }],
};

const feature = (body: string) => `Feature: Log in\n\n  @screen:login\n  Scenario: S\n${body}`;

describe("checkFeatureLiterals", () => {
  it("accepts a literal present in the screen's texts", () => {
    expect(checkFeatureLiterals(feature('    Then I see "Welcome back"\n'), map).missing).toEqual([]);
  });

  it("accepts a literal that only exists in one of the screen's states", () => {
    const text = feature('    Then I see "Authentication failed. Please try again."\n');
    expect(checkFeatureLiterals(text, map).missing).toEqual([]);
  });

  it("rejects a literal the map does not contain", () => {
    const result = checkFeatureLiterals(feature('    Then I see "Invalid email or password"\n'), map);
    expect(result.missing).toEqual([{ literal: "Invalid email or password", screenId: "login" }]);
  });

  it("offers the real texts as candidates so the caller can show them", () => {
    const result = checkFeatureLiterals(feature('    Then I see "Nope"\n'), map);
    expect(result.candidates).toContain("Welcome back");
  });

  it("reports a scenario whose declared screen is not in the map", () => {
    const text = `Feature: X\n\n  @screen:ghost\n  Scenario: S\n    Then I see "Anything"\n`;
    expect(checkFeatureLiterals(text, map).missing).toEqual([{ literal: "Anything", screenId: "ghost" }]);
  });

  it("ignores a scenario with no screen tag rather than crashing", () => {
    const text = `Feature: X\n\n  Scenario: S\n    Then I see "Anything"\n`;
    expect(checkFeatureLiterals(text, map).missing).toEqual([]);
  });

  it("reports screenTagFound: false when the feature carries no @screen: tag at all", () => {
    const text = `Feature: X\n\n  Scenario: S\n    Then I see "Anything"\n`;
    expect(checkFeatureLiterals(text, map).screenTagFound).toBe(false);
  });

  it("reports screenTagFound: true once at least one scenario carries the tag", () => {
    const text = feature('    Then I see "Welcome back"\n');
    expect(checkFeatureLiterals(text, map).screenTagFound).toBe(true);
  });

  it("accepts a fill step whose data value is not in the map — the value is test data, not app copy", () => {
    const text = feature('    When I fill "Email" with "nope@example.com"\n');
    expect(checkFeatureLiterals(text, map).missing).toEqual([]);
  });

  it("still rejects an invented literal elsewhere in the file even when a fill step's data value is absent from the map", () => {
    const text = feature(
      '    When I fill "Email" with "nope@example.com"\n' +
        '    Then I see "Invalid email or password"\n'
    );
    expect(checkFeatureLiterals(text, map).missing).toEqual([
      { literal: "Invalid email or password", screenId: "login" },
    ]);
  });
});
