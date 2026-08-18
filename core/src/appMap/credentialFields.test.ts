import { describe, it, expect } from "vitest";
import { hasPasswordField, looksLikeEmailField, PASSWORD_NAME } from "./credentialFields.js";
import type { Screen, WriteAction } from "./schema.js";

const baseScreen = (locators: Screen["locators"]): Screen => ({
  id: "home", name: "home", className: "HomePage", urlTemplate: "/",
  signature: "sig", requiresAuth: false, texts: [], probeValues: [],
  locators, states: [], ambiguous: [], transitions: [], writeActions: [],
});

describe("hasPasswordField", () => {
  it("is true when a form field's accessible name looks like a password", () => {
    const screen = baseScreen([
      { name: "password_input", kind: "input", accessibleName: "Password", python: "page.get_by_label(\"Password\")", count: 1, verifiedAt: "2026-01-01" },
    ]);
    const action: WriteAction = { locator: "submit_button", label: "Log in", kind: "submit", formFields: ["password_input"] };
    expect(hasPasswordField(screen, action)).toBe(true);
  });

  it("is false when no form field is a password", () => {
    const screen = baseScreen([
      { name: "name_input", kind: "input", accessibleName: "Nombre", python: "page.get_by_label(\"Nombre\")", count: 1, verifiedAt: "2026-01-01" },
    ]);
    const action: WriteAction = { locator: "crear_button", label: "Crear", kind: "submit", formFields: ["name_input"] };
    expect(hasPasswordField(screen, action)).toBe(false);
  });
});

describe("looksLikeEmailField", () => {
  it("matches common email/username field names", () => {
    expect(looksLikeEmailField("Email")).toBe(true);
    expect(looksLikeEmailField("Usuario")).toBe(true);
    expect(looksLikeEmailField("Nombre")).toBe(false);
  });
});
