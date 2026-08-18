import { describe, it, expect } from "vitest";
import { rewriteStepLocator } from "./rewriteStepLocator.js";

describe("rewriteStepLocator", () => {
  it("replaces the quoted literal in a click step under the given screen", () => {
    const feature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit")).toBe(
      `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "log_in_button_submit"\n`
    );
  });

  it("replaces every step that quotes the same text under that screen", () => {
    const feature =
      `Feature: F\n\n  @screen:home\n  Scenario: A\n    When I click "Log in"\n\n  @screen:home\n  Scenario: B\n    When I click "Log in"\n`;
    const out = rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit");
    expect(out.match(/log_in_button_submit/g)).toHaveLength(2);
    expect(out).not.toContain('I click "Log in"');
  });

  it("rewrites only the field of a fill step, never the value", () => {
    const feature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I fill "Log in" with "Log in"\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "log_in_input")).toBe(
      `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I fill "log_in_input" with "Log in"\n`
    );
  });

  it("leaves another screen's identical step alone", () => {
    const feature =
      `Feature: F\n\n  @screen:home\n  Scenario: A\n    When I click "Log in"\n\n  @screen:other\n  Scenario: B\n    When I click "Log in"\n`;
    const out = rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit");
    expect(out).toContain(`@screen:other\n  Scenario: B\n    When I click "Log in"`);
  });

  it("leaves a Then step that merely asserts the same text alone", () => {
    const feature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    Then I see "Log in"\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit")).toBe(feature);
  });

  it("preserves CRLF line endings", () => {
    const feature = `Feature: F\r\n\r\n  @screen:home\r\n  Scenario: S\r\n    When I click "Log in"\r\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit")).toBe(
      `Feature: F\r\n\r\n  @screen:home\r\n  Scenario: S\r\n    When I click "log_in_button_submit"\r\n`
    );
  });

  it("treats a $-bearing locator name as a literal, not String.replace syntax", () => {
    // map.json is user-editable (LocatorEntrySchema.name is only z.string().min(1)),
    // so a hand-written name containing "$&" or "$1" must not be interpreted as
    // replacement syntax and corrupt the rest of the line.
    const feature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "weird_$&_$1_name")).toBe(
      `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "weird_$&_$1_name"\n`
    );
  });
});
