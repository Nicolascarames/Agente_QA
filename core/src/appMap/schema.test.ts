import { describe, it, expect } from "vitest";
import { AppMapSchema, OverridesFileSchema, ScreenSchema } from "./schema.js";

const baseScreen = {
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

const minimalScreen = baseScreen;

const baseMap = {
  schemaVersion: 2,
  appUrl: "https://example.test/",
  createdAt: "2026-08-16T10:00:00.000Z",
  complete: true,
  authenticated: false,
  screens: [baseScreen],
  scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 10 },
};

describe("ScreenSchema", () => {
  it("accepts a screen reached by a path of actions from an addressable ancestor", () => {
    const screen = {
      ...baseScreen,
      id: "home~crear-bebe",
      reachedBy: {
        entryScreenId: "home",
        path: [
          { action: "submit", locator: "log_in_button_2", data: "valid" },
          { action: "click", locator: "crear_bebe_button", data: "none" },
        ],
      },
    };
    expect(ScreenSchema.safeParse(screen).success).toBe(true);
  });
});

describe("AppMapSchema", () => {
  it("accepts a minimal complete map", () => {
    const parsed = AppMapSchema.parse({
      schemaVersion: 2,
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

  it("rejects schemaVersion 1", () => {
    const map = { ...baseMap, schemaVersion: 1 };
    expect(AppMapSchema.safeParse(map).success).toBe(false);
  });

  it("rejects a locator whose count is not exactly 1", () => {
    const result = AppMapSchema.safeParse({
      schemaVersion: 2,
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

  // A candidate that matched ZERO elements is as ambiguous as one that matched
  // five. A floor of 2 here forced the crawler to invent a count it never
  // measured just to make the entry parse.
  it("accepts an ambiguous candidate that matched nothing", () => {
    const result = AppMapSchema.safeParse({
      schemaVersion: 2,
      appUrl: "https://example.test/",
      createdAt: "2026-08-16T10:00:00.000Z",
      complete: true,
      authenticated: false,
      screens: [
        {
          ...minimalScreen,
          ambiguous: [{ candidate: 'page.get_by_text("Nope", exact=True)', count: 0, reason: "no encontrado al validar" }],
        },
      ],
      scenarios: [],
      stats: { screens: 1, locators: 0, ambiguous: 1, durationMs: 10 },
    });
    expect(result.success).toBe(true);
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
