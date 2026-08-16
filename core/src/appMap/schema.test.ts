import { describe, it, expect } from "vitest";
import { AppMapSchema, OverridesFileSchema } from "./schema.js";

const minimalScreen = {
  id: "login",
  name: "Log in",
  className: "LoginPage",
  urlTemplate: "/",
  signature: "sha256:abc",
  requiresAuth: false,
  texts: ["Welcome back"],
  probeValues: [],
  locators: [],
  states: [],
  ambiguous: [],
  transitions: [],
  writeActions: [],
};

describe("AppMapSchema", () => {
  it("accepts a minimal complete map", () => {
    const parsed = AppMapSchema.parse({
      schemaVersion: 1,
      appUrl: "https://example.test/",
      createdAt: "2026-08-16T10:00:00.000Z",
      complete: true,
      authenticated: false,
      screens: [minimalScreen],
      scenarios: [],
      stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 10 },
    });
    expect(parsed.screens[0].id).toBe("login");
  });

  it("rejects a locator whose count is not exactly 1", () => {
    const result = AppMapSchema.safeParse({
      schemaVersion: 1,
      appUrl: "https://example.test/",
      createdAt: "2026-08-16T10:00:00.000Z",
      complete: true,
      authenticated: false,
      screens: [
        {
          ...minimalScreen,
          locators: [{ name: "x", kind: "button", python: "page.get_by_role(\"button\")", count: 2, verifiedAt: "2026-08-16T10:00:00.000Z" }],
        },
      ],
      scenarios: [],
      stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 10 },
    });
    expect(result.success).toBe(false);
  });
});

describe("OverridesFileSchema", () => {
  it("accepts a manual locator correction", () => {
    const parsed = OverridesFileSchema.parse({
      schemaVersion: 1,
      locators: [{ screenId: "login", name: "error_message", python: "page.get_by_text(\"Nope\")" }],
    });
    expect(parsed.locators).toHaveLength(1);
  });
});
