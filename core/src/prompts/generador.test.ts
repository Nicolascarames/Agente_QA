import { describe, it, expect } from "vitest";
import { codeGenerationPrompt } from "./generador.js";
import type { AppMap, Screen } from "../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 2, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 3, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Email"], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [
      { name: "email_input", kind: "input", accessibleName: "Email",
        python: 'page.get_by_role("textbox", name="Email")', count: 1, verifiedAt: "t" },
      { name: "log_in_button", kind: "button", accessibleName: "Log in",
        python: 'page.get_by_role("button", name="Log in", exact=True)', count: 1, verifiedAt: "t" },
      { name: "text_auth_failed", kind: "text",
        python: 'page.get_by_text("Authentication failed. Please try again.")',
        count: 1, stateId: "invalid-credentials", verifiedAt: "t" },
    ],
  }],
};

const naming = { slug: "login", featureFileName: "login.feature" };
const featureText = "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n";

describe("codeGenerationPrompt", () => {
  it("lists the Page Object's methods, so the model can only call methods that exist", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming);
    expect(prompt).toContain("get_email_input");
    expect(prompt).toContain("fill_email_input");
    expect(prompt).toContain("get_log_in_button");
    expect(prompt).toContain("click_log_in_button");
    expect(prompt).toContain("goto");
    expect(prompt).toContain("get_text_auth_failed");
    // text_auth_failed is neither fillable nor clickable: only its get_* exists.
    expect(prompt).not.toContain("fill_text_auth_failed");
    expect(prompt).not.toContain("click_text_auth_failed");
  });

  it("states that pages/ already exists and must never be written or edited", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming);
    expect(prompt).toMatch(/NUNCA escribas ni edites/i);
    expect(prompt).toContain("pages/");
    expect(prompt).toMatch(/se genera/i);
  });

  it("forbids page.get_by_* and page.locator(...) directly in step definitions, but keeps page-level assertions allowed", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming);
    expect(prompt).toContain("page.get_by_");
    expect(prompt).toContain("page.locator(");
    expect(prompt).toMatch(/NUNCA construye su propio localizador/i);
    expect(prompt).toContain("expect(page).to_have_url(");
  });

  // The lint (checkNoDirectPageUse, core/src/codeCheck/pageFixtureLint.ts) rejects
  // far more than these two spellings — page.click, page.fill,
  // page.wait_for_selector, page.query_selector, and other selector-taking
  // methods. The old prompt only named the two the lint used to check, so a
  // fully prompt-obedient model could still write `page.click("...")` and pass
  // the prompt's own stated rule while failing the lint. The prompt must widen
  // together with the lint so the two describe the same rule.
  it("names selector-taking page methods beyond get_by_*/locator(...) as forbidden too, matching the widened lint", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming);
    expect(prompt).toContain("page.click(");
    expect(prompt).toContain("page.fill(");
    expect(prompt).toContain("page.wait_for_selector(");
    expect(prompt).toContain("page.query_selector(");
  });

  it("keeps page.goto and page.url explicitly legal, next to the widened prohibition", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming);
    expect(prompt).toContain("page.goto(");
    expect(prompt).toContain("page.url");
  });

  it("names the exact module and class to import the Page Object from", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming);
    expect(prompt).toContain("from pages.login_page import LoginPage");
  });

  it("includes the feature text to implement, at the path it will be generated under", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming);
    expect(prompt).toContain(featureText);
    expect(prompt).toContain("features/login.feature");
  });

  it("asks for exactly one file: the step definitions module named after the slug", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming);
    expect(prompt).toContain("tests/test_login.py");
    expect(prompt).toMatch(/EXACTAMENTE un bloque/);
  });

  it("includes the previous attempt's code and the retry feedback when retrying", () => {
    const prompt = codeGenerationPrompt(featureText, map, "login", naming, {
      previousFiles: [{ path: "tests/test_login.py", content: "broken code here\n" }],
      feedback: "SyntaxError: unexpected token",
    });
    expect(prompt).toContain("SyntaxError: unexpected token");
    expect(prompt).toContain("broken code here");
  });

  it("throws a clear error when the screen doesn't exist in the map", () => {
    expect(() => codeGenerationPrompt(featureText, map, "ghost", naming)).toThrow(/ghost/);
  });

  // Mirrors the fixture in pageObjectEmitter.test.ts ("emits a goto() with a
  // str parameter per field when the path's submit is not a login"): a
  // non-login submit on the way to a nested screen makes that screen's
  // goto() take one str per form field, so the prompt's fixed convention
  // paragraph must not contradict the methods list it just printed.
  it("does not claim goto() takes no arguments when this screen's goto is parameterized", () => {
    const listScreen: Screen = {
      id: "home", name: "home", className: "HomePage", urlTemplate: "/", signature: "s",
      requiresAuth: false, texts: [], probeValues: [],
      locators: [
        { name: "search_input", kind: "input", accessibleName: "Search", python: 'page.get_by_label("Search")', count: 1, verifiedAt: "2026-01-01" },
        { name: "search_button", kind: "button", accessibleName: "Search", python: 'page.get_by_role("button", name="Search")', count: 1, verifiedAt: "2026-01-01" },
      ],
      states: [], ambiguous: [], transitions: [],
      writeActions: [{ locator: "search_button", label: "Search", kind: "submit", formFields: ["search_input"] }],
    };
    const resultsScreen: Screen = {
      id: "home~search-results", name: "home~search-results", className: "HomeSearchResultsPage", urlTemplate: "/",
      signature: "s2", requiresAuth: false, texts: [], probeValues: [], locators: [],
      states: [], ambiguous: [], transitions: [], writeActions: [],
      reachedBy: { entryScreenId: "home", path: [{ action: "submit", locator: "search_button", data: "valid" }] },
    };
    const searchMap: AppMap = {
      schemaVersion: 2, appUrl: "https://example.test", createdAt: "2026-01-01", complete: true,
      authenticated: false, screens: [listScreen, resultsScreen], scenarios: [],
      stats: { screens: 2, locators: 2, ambiguous: 0, durationMs: 1 },
    };

    const prompt = codeGenerationPrompt("Feature: x", searchMap, resultsScreen.id, {
      slug: "x",
      featureFileName: "x.feature",
    });
    expect(prompt).toContain("goto(search_input: str)");
    expect(prompt).not.toMatch(/"goto" no reciben ningún argumento/);
  });

  // Mirrors the fixture in pageObjectEmitter.test.ts ("emits a goto() that
  // replays a login-then-click path..."): the screen under test is itself a
  // nested view, so its `~`-bearing id must not leak into the Python module
  // name the prompt tells the model to import from.
  it("derives a valid Python module name for a nested screen id", () => {
    const loginScreen: Screen = {
      id: "home", name: "home", className: "HomePage", urlTemplate: "/", signature: "s",
      requiresAuth: false, texts: [], probeValues: [],
      locators: [
        { name: "email_input", kind: "input", accessibleName: "Email", python: 'page.get_by_label("Email")', count: 1, verifiedAt: "2026-01-01" },
        { name: "password_input", kind: "input", accessibleName: "Password", python: 'page.get_by_label("Password")', count: 1, verifiedAt: "2026-01-01" },
        { name: "log_in_button", kind: "button", accessibleName: "Log in", python: 'page.get_by_role("button", name="Log in")', count: 1, verifiedAt: "2026-01-01" },
      ],
      states: [], ambiguous: [], transitions: [],
      writeActions: [{ locator: "log_in_button", label: "Log in", kind: "submit", formFields: ["email_input", "password_input"] }],
    };
    const babyScreen: Screen = {
      id: "home~crear-bebe", name: "Crear bebé", className: "HomeCrearBebePage", urlTemplate: "/",
      signature: "s2", requiresAuth: true, texts: [], probeValues: [], locators: [],
      states: [], ambiguous: [], transitions: [], writeActions: [],
      reachedBy: {
        entryScreenId: "home",
        path: [{ action: "submit", locator: "log_in_button", data: "valid" }],
      },
    };
    const nestedMap: AppMap = {
      schemaVersion: 2, appUrl: "https://example.test", createdAt: "2026-01-01", complete: true,
      authenticated: true, screens: [loginScreen, babyScreen], scenarios: [],
      stats: { screens: 2, locators: 3, ambiguous: 0, durationMs: 1 },
    };

    const prompt = codeGenerationPrompt("Feature: x", nestedMap, babyScreen.id, {
      slug: "x",
      featureFileName: "x.feature",
    });
    expect(prompt).toContain("from pages.home_crear_bebe_page import");
    expect(prompt).not.toContain("~");
  });
});
