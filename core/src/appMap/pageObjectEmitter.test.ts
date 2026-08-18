import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitPageObject, pageObjectMethodNamesForLocator } from "./pageObjectEmitter.js";
import type { AppMap, LocatorEntry, Screen } from "./schema.js";

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

// Every existing test's screen has no `reachedBy`, so this fixture's other
// fields (besides `screens`) are never read by `emitPageObject`/
// `pageObjectMethodNames` — it exists only to satisfy the now-required `map`
// parameter without repeating the same boilerplate at every call site.
const mapWith = (...screens: Screen[]): AppMap => ({
  schemaVersion: 2, appUrl: "https://example.test", createdAt: "2026-01-01", complete: true,
  authenticated: false, screens, scenarios: [],
  stats: { screens: screens.length, locators: 0, ambiguous: 0, durationMs: 1 },
});

describe("emitPageObject", () => {
  it("writes to pages/<id>_page.py", () => {
    expect(emitPageObject(screen, mapWith(screen)).path).toBe("pages/login_page.py");
  });

  it("carries a do-not-edit banner", () => {
    expect(emitPageObject(screen, mapWith(screen)).content).toContain("NO EDITAR A MANO");
  });

  it("emits a get_* method per locator", () => {
    const { content } = emitPageObject(screen, mapWith(screen));
    expect(content).toContain("def get_email_input(self) -> Locator:");
    expect(content).toContain("def get_log_in_button(self) -> Locator:");
    expect(content).toContain("def get_text_auth_failed(self) -> Locator:");
  });

  it("emits fill_* only for inputs and click_* only for buttons and links", () => {
    const { content } = emitPageObject(screen, mapWith(screen));
    expect(content).toContain("def fill_email_input(self, value: str) -> None:");
    expect(content).toContain("def click_log_in_button(self) -> None:");
    expect(content).not.toContain("def click_email_input");
    expect(content).not.toContain("def fill_text_auth_failed");
  });

  it("keeps the locator expression verbatim from the map", () => {
    expect(emitPageObject(screen, mapWith(screen)).content)
      .toContain('return self.page.get_by_role("main").get_by_role("button", name="Log in")');
  });

  it("notes in a comment which state a state-only locator belongs to", () => {
    expect(emitPageObject(screen, mapWith(screen)).content).toContain("# solo visible en el estado: invalid-credentials");
  });

  it("emits goto() from the route template", () => {
    const { content } = emitPageObject(screen, mapWith(screen));
    expect(content).toContain('URL_TEMPLATE = "/"');
    expect(content).toContain("def goto(self) -> None:");
    expect(content).toContain("import os");
  });

  // A templated route has no single URL: `goto()` would request the literal
  // "/item/:id" and fail against a working application.
  it("omits goto() for a route with a variable segment", () => {
    const templated: Screen = { ...screen, id: "item_id", className: "ItemIdPage", urlTemplate: "/item/:id" };
    const { content } = emitPageObject(templated, mapWith(templated));
    expect(content).toContain('URL_TEMPLATE = "/item/:id"');
    expect(content).not.toContain("def goto(");
    expect(content).not.toContain("import os");
    expect(content).toContain("segmentos variables");
  });

  it("escapes the route template like every other Python literal it emits", () => {
    const weird: Screen = { ...screen, urlTemplate: '/we"ird' };
    expect(emitPageObject(weird, mapWith(weird)).content).toContain('URL_TEMPLATE = "/we\\"ird"');
  });

  it("emits no bare page reference for an attribute-disambiguated locator", () => {
    const screen: Screen = {
      id: "home", name: "home", className: "HomePage", urlTemplate: "/",
      signature: "sha256:a", requiresAuth: false,
      texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
      locators: [
        {
          name: "log_in_button_submit", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))',
          count: 1, disambiguatedBy: "attribute:[type='submit']", verifiedAt: "t",
        },
      ],
    };
    // A bare `page.` anywhere in the emitted class is a NameError waiting to
    // happen: inside a method only `self.page` exists.
    expect(emitPageObject(screen, mapWith(screen)).content).not.toMatch(/(?<!self\.)\bpage\./);
  });

  it("keeps a text locator's own copy byte-identical even when it ends in 'page.'", () => {
    // Verbatim shape realCrawler.ts produces for a `kind: "text"` locator: the
    // app's own words, which end in a lowercase "page." often enough in real
    // UI copy. A literal-blind `page.` rewrite corrupts this into a string
    // the crawler never validated and Playwright can never match.
    const screen: Screen = {
      id: "denied", name: "Access denied", className: "AccessDeniedPage", urlTemplate: "/denied",
      signature: "sha256:a", requiresAuth: false,
      texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
      locators: [
        {
          name: "text_no_permission", kind: "text",
          python: 'page.get_by_text("You do not have permission to view this page.", exact=True)',
          count: 1, verifiedAt: "t",
        },
      ],
    };
    expect(emitPageObject(screen, mapWith(screen)).content).toContain(
      'return self.page.get_by_text("You do not have permission to view this page.", exact=True)'
    );
  });

  it("emits a goto() that replays a login-then-click path using env credentials, with no parameters", () => {
    const loginScreen: Screen = {
      id: "home", name: "home", className: "HomePage", urlTemplate: "/", signature: "s",
      requiresAuth: false, texts: [], probeValues: [],
      locators: [
        { name: "email_input", kind: "input", accessibleName: "Email", python: 'page.get_by_label("Email")', count: 1, verifiedAt: "2026-01-01" },
        { name: "password_input", kind: "input", accessibleName: "Password", python: 'page.get_by_label("Password")', count: 1, verifiedAt: "2026-01-01" },
        { name: "log_in_button", kind: "button", accessibleName: "Log in", python: 'page.get_by_role("button", name="Log in")', count: 1, verifiedAt: "2026-01-01" },
        { name: "crear_bebe_button", kind: "button", accessibleName: "Crear bebé", python: 'page.get_by_role("button", name="Crear bebé")', count: 1, verifiedAt: "2026-01-01", stateId: "path-log_in_button" },
      ],
      states: [], ambiguous: [], transitions: [],
      writeActions: [{ locator: "log_in_button", label: "Log in", kind: "submit", formFields: ["email_input", "password_input"] }],
    };
    const babyScreen: Screen = {
      id: "home~crear-bebe", name: "home~crear-bebe", className: "HomeCrearBebePage", urlTemplate: "/",
      signature: "s2", requiresAuth: true, texts: [], probeValues: [],
      locators: [{ name: "name_input", kind: "input", accessibleName: "Name", python: 'page.get_by_label("Name")', count: 1, verifiedAt: "2026-01-01" }],
      states: [], ambiguous: [], transitions: [], writeActions: [],
      reachedBy: {
        entryScreenId: "home",
        path: [
          { action: "submit", locator: "log_in_button", data: "valid" },
          { action: "click", locator: "crear_bebe_button", data: "none" },
        ],
      },
    };
    const map: AppMap = {
      schemaVersion: 2, appUrl: "https://example.test", createdAt: "2026-01-01", complete: true,
      authenticated: true, screens: [loginScreen, babyScreen], scenarios: [],
      stats: { screens: 2, locators: 5, ambiguous: 0, durationMs: 1 },
    };

    const { content } = emitPageObject(babyScreen, map);
    expect(content).toContain("def goto(self) -> None:");
    expect(content).toContain("entry = HomePage(self.page)");
    expect(content).toContain("entry.goto()");
    expect(content).toContain('entry.fill_email_input(os.environ["AGENTE_QA_TEST_USERNAME"])');
    expect(content).toContain('entry.fill_password_input(os.environ["AGENTE_QA_TEST_PASSWORD"])');
    expect(content).toContain("entry.click_log_in_button()");
    expect(content).toContain("entry.click_crear_bebe_button()");
    expect(content).not.toMatch(/def goto\(self, /); // sin parámetros
  });

  it("emits a goto() with a str parameter per field when the path's submit is not a login", () => {
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
    const map: AppMap = {
      schemaVersion: 2, appUrl: "https://example.test", createdAt: "2026-01-01", complete: true,
      authenticated: false, screens: [listScreen, resultsScreen], scenarios: [],
      stats: { screens: 2, locators: 2, ambiguous: 0, durationMs: 1 },
    };

    const { content } = emitPageObject(resultsScreen, map);
    expect(content).toContain("def goto(self, search_input: str) -> None:");
    expect(content).toContain("entry.fill_search_input(search_input)");
    expect(content).not.toContain("os.environ");
  });
});

describe("pageObjectMethodNamesForLocator", () => {
  // Pins this helper to the exact same kind->prefix rule `emitPageObject`
  // uses, so a caller outside this module (the CLI's ambiguity prompt, in
  // particular) can never advertise a method the emitted Page Object doesn't
  // actually define.
  const of = (kind: LocatorEntry["kind"]): LocatorEntry => ({
    name: "x", kind, python: "page.x", count: 1, verifiedAt: "t",
  });

  it("gives an input get_ and fill_, never click_ or select_", () => {
    expect(pageObjectMethodNamesForLocator(of("input"))).toEqual(["get_x", "fill_x"]);
  });

  it("gives a button get_ and click_, never fill_ or select_", () => {
    expect(pageObjectMethodNamesForLocator(of("button"))).toEqual(["get_x", "click_x"]);
  });

  it("gives a link get_ and click_, never fill_ or select_", () => {
    expect(pageObjectMethodNamesForLocator(of("link"))).toEqual(["get_x", "click_x"]);
  });

  it("gives a select get_ and select_, never fill_ or click_", () => {
    expect(pageObjectMethodNamesForLocator(of("select"))).toEqual(["get_x", "select_x"]);
  });

  it("gives text only get_ — no fill_, click_, or select_", () => {
    expect(pageObjectMethodNamesForLocator(of("text"))).toEqual(["get_x"]);
  });

  it("gives a heading only get_ — no fill_, click_, or select_", () => {
    expect(pageObjectMethodNamesForLocator(of("heading"))).toEqual(["get_x"]);
  });
});

const hasPython = spawnSync("python", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasPython)("emitted Page Object executes", () => {
  it("resolves an attribute-disambiguated getter without NameError", async () => {
    const screen: Screen = {
      id: "home", name: "home", className: "HomePage", urlTemplate: "/",
      signature: "sha256:a", requiresAuth: false,
      texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
      locators: [
        {
          name: "log_in_button_submit", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))',
          count: 1, disambiguatedBy: "attribute:[type='submit']", verifiedAt: "t",
        },
      ],
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-emit-"));
    const emitted = emitPageObject(screen, mapWith(screen));
    const modulePath = path.join(dir, "page_object.py");
    await fs.writeFile(modulePath, emitted.content, "utf-8");

    // A fake page: every call returns the fake, so the only way this fails is
    // a name that does not exist in the method's scope.
    const driver = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("po", ${JSON.stringify(modulePath).replace(/\\/g, "/")})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Fake:
    def __getattr__(self, _name):
        return lambda *a, **k: self

po = mod.HomePage(Fake())
po.get_log_in_button_submit()
print("OK")
`;
    const driverPath = path.join(dir, "driver.py");
    await fs.writeFile(driverPath, driver, "utf-8");

    const run = spawnSync("python", [driverPath], { encoding: "utf-8" });
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/NameError/);
    expect(run.stdout).toContain("OK");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
