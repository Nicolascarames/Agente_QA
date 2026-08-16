import { describe, it, expect } from "vitest";
import { findScreen, screenLiterals, textsAfterClick, findLocator } from "./mapQuery.js";
import type { AppMap } from "./schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Email"], probeValues: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "forgot_button", kind: "button", accessibleName: "Forgot password?",
      python: 'page.get_by_role("button", name="Forgot password?", exact=True)', count: 1, verifiedAt: "t" }],
    states: [{ id: "click-forgot_button",
      reachedBy: { action: "click", locator: "forgot_button", data: "none" },
      addsTexts: ["Reset password", "Send reset link"] }],
  }],
};

describe("findScreen", () => {
  it("finds a screen by id", () => expect(findScreen(map, "login")?.name).toBe("Log in"));
  it("returns null for an unknown id", () => expect(findScreen(map, "nope")).toBeNull());
});

describe("screenLiterals", () => {
  it("includes the screen's own texts and every state's texts", () => {
    expect(screenLiterals(map, "login")).toEqual(
      expect.arrayContaining(["Welcome back", "Email", "Reset password", "Send reset link"])
    );
  });
  it("returns an empty list for an unknown screen", () => expect(screenLiterals(map, "nope")).toEqual([]));
});

describe("textsAfterClick", () => {
  it("returns the texts a click produces, not the ones already on screen", () => {
    expect(textsAfterClick(map, "login", "forgot_button")).toEqual(["Reset password", "Send reset link"]);
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
