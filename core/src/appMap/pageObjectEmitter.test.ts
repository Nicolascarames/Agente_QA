import { describe, it, expect } from "vitest";
import { emitPageObject } from "./pageObjectEmitter.js";
import type { Screen } from "./schema.js";

const screen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
  locators: [
    { name: "email_input", kind: "input", accessibleName: "Email",
      python: 'page.get_by_role("textbox", name="Email")', count: 1, verifiedAt: "t" },
    { name: "log_in_button", kind: "button", accessibleName: "Log in",
      python: 'page.get_by_role("main").get_by_role("button", name="Log in")',
      count: 1, disambiguatedBy: "region:main", verifiedAt: "t" },
    { name: "text_auth_failed", kind: "text",
      python: 'page.get_by_text("Authentication failed. Please try again.")',
      count: 1, stateId: "invalid-credentials", verifiedAt: "t" },
  ],
};

describe("emitPageObject", () => {
  it("writes to pages/<id>_page.py", () => {
    expect(emitPageObject(screen).path).toBe("pages/login_page.py");
  });

  it("carries a do-not-edit banner", () => {
    expect(emitPageObject(screen).content).toContain("NO EDITAR A MANO");
  });

  it("emits a get_* method per locator", () => {
    const { content } = emitPageObject(screen);
    expect(content).toContain("def get_email_input(self) -> Locator:");
    expect(content).toContain("def get_log_in_button(self) -> Locator:");
    expect(content).toContain("def get_text_auth_failed(self) -> Locator:");
  });

  it("emits fill_* only for inputs and click_* only for buttons and links", () => {
    const { content } = emitPageObject(screen);
    expect(content).toContain("def fill_email_input(self, value: str) -> None:");
    expect(content).toContain("def click_log_in_button(self) -> None:");
    expect(content).not.toContain("def click_email_input");
    expect(content).not.toContain("def fill_text_auth_failed");
  });

  it("keeps the locator expression verbatim from the map", () => {
    expect(emitPageObject(screen).content)
      .toContain('return self.page.get_by_role("main").get_by_role("button", name="Log in")');
  });

  it("notes in a comment which state a state-only locator belongs to", () => {
    expect(emitPageObject(screen).content).toContain("# solo visible en el estado: invalid-credentials");
  });

  it("emits goto() from the route template", () => {
    const { content } = emitPageObject(screen);
    expect(content).toContain('URL_TEMPLATE = "/"');
    expect(content).toContain("def goto(self) -> None:");
    expect(content).toContain("import os");
  });

  // A templated route has no single URL: `goto()` would request the literal
  // "/item/:id" and fail against a working application.
  it("omits goto() for a route with a variable segment", () => {
    const { content } = emitPageObject({ ...screen, id: "item_id", className: "ItemIdPage", urlTemplate: "/item/:id" });
    expect(content).toContain('URL_TEMPLATE = "/item/:id"');
    expect(content).not.toContain("def goto(");
    expect(content).not.toContain("import os");
    expect(content).toContain("segmentos variables");
  });

  it("escapes the route template like every other Python literal it emits", () => {
    const { content } = emitPageObject({ ...screen, urlTemplate: '/we"ird' });
    expect(content).toContain('URL_TEMPLATE = "/we\\"ird"');
  });
});
