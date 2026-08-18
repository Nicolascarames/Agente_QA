import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitPageObject, pageObjectMethodNamesForLocator } from "./pageObjectEmitter.js";
import type { LocatorEntry, Screen } from "./schema.js";

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
    expect(emitPageObject(screen).content).not.toMatch(/(?<!self\.)\bpage\./);
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
    const emitted = emitPageObject(screen);
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
