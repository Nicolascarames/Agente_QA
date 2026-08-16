import { describe, it, expect } from "vitest";
import { findScreen, screenLiterals, textsAfterClick, findLocator } from "./mapQuery.js";
import type { AppMap } from "./schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 2, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Email", "Error"], probeValues: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [
      { name: "forgot_button", kind: "button", accessibleName: "Forgot password?",
        python: 'page.get_by_role("button", name="Forgot password?", exact=True)', count: 1, verifiedAt: "t" },
      { name: "submit_button", kind: "button", accessibleName: "Sign in",
        python: 'page.get_by_role("button", name="Sign in", exact=True)', count: 1, verifiedAt: "t" },
    ],
    states: [
      { id: "click-forgot_button",
        reachedBy: { action: "click", locator: "forgot_button", data: "none" },
        addsTexts: ["Reset password", "Send reset link"] },
      { id: "submit-sign_in_error",
        reachedBy: { action: "submit", locator: "submit_button", data: "none" },
        addsTexts: ["Error", "Invalid credentials"] },
    ],
  }],
};

describe("findScreen", () => {
  it("finds a screen by id", () => expect(findScreen(map, "login")?.name).toBe("Log in"));
  it("returns null for an unknown id", () => expect(findScreen(map, "nope")).toBeNull());
});

describe("screenLiterals", () => {
  it("returns screen's own texts first, then every state's texts, in order", () => {
    expect(screenLiterals(map, "login")).toEqual(
      ["Welcome back", "Email", "Error", "Reset password", "Send reset link", "Invalid credentials"]
    );
  });
  it("deduplicates texts while preserving first occurrence order", () => {
    // Error appears in both screen.texts and in a state's addsTexts; should appear once in first position
    const texts = screenLiterals(map, "login");
    expect(texts).toEqual(
      ["Welcome back", "Email", "Error", "Reset password", "Send reset link", "Invalid credentials"]
    );
    expect(texts.indexOf("Error")).toBe(2); // Error from screen.texts, not from state
  });
  it("returns an empty list for an unknown screen", () => expect(screenLiterals(map, "nope")).toEqual([]));
});

describe("textsAfterClick", () => {
  it("returns the texts a click produces, not the ones already on screen", () => {
    expect(textsAfterClick(map, "login", "forgot_button")).toEqual(["Reset password", "Send reset link"]);
  });
  it("distinguishes click from submit: returns nothing for submit-only locator", () => {
    // submit_button reaches a state via submit, not click, so textsAfterClick returns empty
    expect(textsAfterClick(map, "login", "submit_button")).toEqual([]);
  });
  it("includes submit texts in screenLiterals even if textsAfterClick ignores submit", () => {
    // screenLiterals includes all state texts regardless of action type
    const allLiterals = screenLiterals(map, "login");
    expect(allLiterals).toContain("Invalid credentials");
  });
  it("returns an empty list when the locator produces no state", () => {
    expect(textsAfterClick(map, "login", "unknown_button")).toEqual([]);
  });
});

describe("findLocator", () => {
  it("finds a locator by name", () => {
    expect(findLocator(map, "login", "forgot_button")?.kind).toBe("button");
  });
  it("returns null when the screen has no such locator", () => {
    expect(findLocator(map, "login", "nope")).toBeNull();
  });
});
