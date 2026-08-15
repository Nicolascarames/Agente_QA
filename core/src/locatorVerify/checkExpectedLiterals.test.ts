import { describe, it, expect } from "vitest";
import { checkExpectedLiterals, formatMissingLiterals } from "./checkExpectedLiterals.js";
import type { ScreenEvidence } from "../siteExplorer/siteExplorer.js";

const screens: ScreenEvidence[] = [
  {
    stepText: "pantalla en /",
    url: "https://app.test/",
    ariaSnapshot: `- heading "Welcome back" [level=1]
- button "Log in"
- text: Authentication failed. Please try again.`,
  },
  {
    stepText: "tras iniciar sesión",
    url: "https://app.test/",
    ariaSnapshot: `- heading "Sueño y crecimiento" [level=1]`,
  },
];

describe("checkExpectedLiterals", () => {
  it("accepts a literal present in any screen", () => {
    expect(
      checkExpectedLiterals([{ method: "get_heading", argument: "Sueño y crecimiento" }], screens)
    ).toEqual([]);
  });

  it("ignores case and collapsed whitespace, like Playwright does", () => {
    expect(checkExpectedLiterals([{ method: "get_button", argument: "Log In" }], screens)).toEqual([]);
  });

  it("reports a literal missing from every screen, with the closest real text", () => {
    const missing = checkExpectedLiterals(
      [{ method: "get_heading", argument: "Dream and Growth" }],
      screens
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].argument).toBe("Dream and Growth");
    expect(missing[0].closest).not.toBeNull();
  });

  it("returns nothing when there is no evidence to compare against", () => {
    expect(checkExpectedLiterals([{ method: "get_heading", argument: "lo que sea" }], [])).toEqual([]);
  });

  it("skips empty arguments (Scenario Outline empty cells assert nothing textual)", () => {
    expect(checkExpectedLiterals([{ method: "get_validation_message", argument: "" }], screens)).toEqual(
      []
    );
  });

  it("formats a message naming both the expected and the real text", () => {
    const message = formatMissingLiterals([
      { method: "get_heading", argument: "Dream and Growth", closest: "Sueño y crecimiento" },
    ]);
    expect(message).toContain("Dream and Growth");
    expect(message).toContain("Sueño y crecimiento");
  });
});
