import { describe, it, expect } from "vitest";
import { checkFeatureLiterals } from "./checkFeatureLiterals.js";
import type { AppMap } from "../../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 2, appUrl: "https://example.test/", createdAt: "t",
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

  it("recognizes a nested screen tag containing '~'", () => {
    const nestedMap: AppMap = {
      schemaVersion: 2, appUrl: "https://example.test/", createdAt: "t",
      complete: true, authenticated: false, scenarios: [],
      stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
      screens: [{
        id: "home~crear-bebe", name: "Crear bebé", className: "CreateBabyPage", urlTemplate: "/crear-bebe",
        signature: "sha256:a", requiresAuth: false,
        texts: ["Crear bebé"], probeValues: [], locators: [],
        ambiguous: [], transitions: [], writeActions: [],
        states: [],
      }],
    };
    const feature = `Feature: Create baby
  @screen:home~crear-bebe
  Scenario: Create baby
    Then I see "Crear bebé"`;
    const result = checkFeatureLiterals(feature, nestedMap);
    expect(result.screenTagFound).toBe(true);
    expect(result.missing).toEqual([]);
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

  // `realCrawler` always sets `name: screenId` (a route slug, e.g. "/" -> "home"),
  // so `screen.name` is never among a screen's own `texts` in a real crawl. The
  // prompt's own vocabulary (`prompts/intake.ts`) mandates
  // `Given I am on the "<pantalla>" screen`, which quotes exactly that slug — a
  // fully prompt-obedient feature over a map shaped like a real one, unlike every
  // other fixture above (whose screen `name` happens to be human prose). This
  // must accept zero missing literals, or the plan burns all its grounding
  // attempts on the very first, most obedient step every real crawl produces.
  it("accepts a prompt-obedient feature verbatim against a map shaped like a real crawl (name === id, a route slug absent from texts)", () => {
    const realMap: AppMap = {
      schemaVersion: 2, appUrl: "https://example.test/", createdAt: "t",
      complete: true, authenticated: false, scenarios: [],
      stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
      screens: [{
        id: "home", name: "home", className: "HomePage", urlTemplate: "/",
        signature: "sha256:a", requiresAuth: false,
        // A real crawl pushes every collected candidate's accessible name into
        // `texts` (see `captureScreen` in `realCrawler.ts`), buttons and links
        // included — "Log in" is here for the same reason "Email" is.
        texts: ["Welcome back", "Email", "Log in"], probeValues: [],
        locators: [{
          name: "log_in_button", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True)', count: 1, verifiedAt: "t",
        }],
        ambiguous: [], transitions: [], writeActions: [],
        states: [{
          id: "invalid",
          reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
          addsTexts: ["Authentication failed. Please try again."],
        }],
      }],
    };

    const promptObedientFeature =
      `Feature: Home\n\n` +
      `  @screen:home\n` +
      `  Scenario: Login fails with invalid data\n` +
      `    Given I am on the "home" screen\n` +
      `    When I fill "Email" with "nope@example.com"\n` +
      `    When I click "Log in"\n` +
      `    Then I see "Authentication failed. Please try again."\n`;

    expect(checkFeatureLiterals(promptObedientFeature, realMap).missing).toEqual([]);
  });

  // Two files decide "what may be quoted on this screen": this one and
  // `gherkinGenerationPrompt` (prompts/intake.ts), which filters probeValues out
  // of what it shows the model. Without the same filter here, the crawler's own
  // probe value (never real app copy) is technically inside `screenLiterals`
  // (map texts ∪ addsTexts) and would be silently accepted as a quotable
  // literal — and worse, echoed back to the user as a "real text" candidate in
  // the exhaustion message.
  const mapWithProbeValue: AppMap = {
    ...map,
    screens: [{
      ...map.screens[0],
      texts: [...map.screens[0].texts, "agente-qa-probe@example.invalid"],
      probeValues: ["agente-qa-probe@example.invalid"],
    }],
  };

  it("rejects a probe value even though it is technically inside the screen's texts", () => {
    const text = feature('    Then I see "agente-qa-probe@example.invalid"\n');
    expect(checkFeatureLiterals(text, mapWithProbeValue).missing).toEqual([
      { literal: "agente-qa-probe@example.invalid", screenId: "login" },
    ]);
  });

  it("never offers a probe value as a candidate", () => {
    const result = checkFeatureLiterals(feature('    Then I see "Nope"\n'), mapWithProbeValue);
    expect(result.candidates).not.toContain("agente-qa-probe@example.invalid");
  });
});
