import { describe, it, expect } from "vitest";
import { checkExpectedLiterals, formatMissingLiterals, candidateTexts } from "./checkExpectedLiterals.js";
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

  it("reports a cross-language literal with null closest, lists actual texts in message", () => {
    const missing = checkExpectedLiterals(
      [{ method: "get_heading", argument: "Dream and Growth" }],
      screens
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].argument).toBe("Dream and Growth");
    expect(missing[0].closest).toBeNull();

    const candidates = ["Welcome back", "Log in", "Authentication failed. Please try again.", "Sueño y crecimiento"];
    const message = formatMissingLiterals(missing, candidates);
    expect(message).toContain("Dream and Growth");
    expect(message).toContain("Sueño y crecimiento");
  });

  it("finds a close match when expected text is a near-miss (e.g., Log In Now vs Log in)", () => {
    const missing = checkExpectedLiterals(
      [{ method: "get_button", argument: "Log In Now" }],
      screens
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].argument).toBe("Log In Now");
    expect(missing[0].closest).toBe("Log in");
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

  it("end-to-end: derives candidates from screens and formats without hand-typed arrays", () => {
    const missing = checkExpectedLiterals(
      [{ method: "get_heading", argument: "Dream and Growth" }],
      screens
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].closest).toBeNull();

    // Use exported candidateTexts to derive candidates the way the next task will
    const extracted = candidateTexts(screens);
    const message = formatMissingLiterals(missing, extracted);

    expect(message).toContain("Dream and Growth");
    expect(message).toContain("Welcome back");
    expect(message).toContain("Log in");
    expect(message).toContain("Authentication failed");
    expect(message).toContain("Sueño y crecimiento");
  });

  it("does not emit garbled candidates from lines with embedded text: labels", () => {
    const screensWithEmbedded: ScreenEvidence[] = [
      {
        stepText: "screen with listitem containing Alt text label",
        url: "https://app.test/",
        ariaSnapshot: `- listitem "Alt text: photo of a cat"
- text: Image metadata loaded.`,
      },
    ];

    const candidates = candidateTexts(screensWithEmbedded);

    // Should extract "Alt text: photo of a cat" from quoted string (correct)
    expect(candidates).toContain("Alt text: photo of a cat");
    // Should extract "Image metadata loaded." from - text: line (correct)
    expect(candidates).toContain("Image metadata loaded.");
    // Should NOT extract garbled "photo of a cat\"" fragment (the regex bug)
    expect(candidates).not.toContain('photo of a cat"');
    // Should NOT extract the literal "text:" as a candidate
    expect(candidates).not.toContain("text:");
  });
});
