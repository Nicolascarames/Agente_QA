import { describe, it, expect } from "vitest";
import { locatorsUsedBy, checkMapFreshness } from "./mapFreshness.js";
import { FakeLocatorVerifier } from "./testUtils.js";
import type { AppMap } from "../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 2, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back"], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [
      { name: "log_in_button", kind: "button", accessibleName: "Log in",
        python: 'page.get_by_role("button", name="Log in", exact=True)', count: 1, verifiedAt: "t" },
      { name: "email_input", kind: "input", accessibleName: "Email",
        python: 'page.get_by_role("textbox", name="Email", exact=True)', count: 1, verifiedAt: "t" },
    ],
  }],
};

const feature = `Feature: F\n\n  @screen:login\n  Scenario: S\n    When I click "Log in"\n    Then I see "Welcome back"\n`;

describe("locatorsUsedBy", () => {
  it("picks only the locators the scenario actually names", () => {
    const used = locatorsUsedBy(feature, map);
    expect(used.map((u) => u.locator.name)).toEqual(["log_in_button"]);
  });

  it("returns nothing for a scenario with no screen tag", () => {
    expect(locatorsUsedBy(`Feature: F\n  Scenario: S\n    When I click "Log in"\n`, map)).toEqual([]);
  });

  it("collects the field name from an I fill step, never the data value it types", () => {
    // If the implementation ever captured the second quoted group (the data)
    // instead of the first (the field), "someone@example.com" would not
    // resolve against any locator's accessibleName/name and `used` would
    // come back empty instead of naming email_input.
    const fillFeature = `Feature: F\n\n  @screen:login\n  Scenario: S\n    When I fill "Email" with "someone@example.com"\n`;
    const used = locatorsUsedBy(fillFeature, map);
    expect(used.map((u) => u.locator.name)).toEqual(["email_input"]);
  });
});

describe("checkMapFreshness", () => {
  it("passes when every used locator still resolves to one element", async () => {
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(true);
  });

  it("reports the stale locator by name and screen when it no longer resolves", async () => {
    const verifier = new FakeLocatorVerifier([{ ok: false, errors: "log_in_button: 0 coincidencias" }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stale[0].name).toBe("log_in_button");
  });

  it("synthesizes a Page Object whose locator expression matches the map's python letter for letter", async () => {
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    const call = verifier.receivedCalls[0];
    const pageObject = call.files.find((f) => f.path === "pages/map_freshness.py");
    expect(pageObject).toBeDefined();
    // Verbatim apart from the leading `page.` -> `self.page.` rewrite: this
    // project's hardest rule is validating exactly the expression it emits.
    expect(pageObject?.content).toContain(
      'return self.page.get_by_role("button", name="Log in", exact=True)'
    );
    expect(pageObject?.content).toContain("def __init__(self, page):");
    expect(pageObject?.content).toContain("def get_log_in_button(self");
  });

  it("sends the verifier a check for get_<name> with an empty argument", async () => {
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    expect(verifier.receivedCalls[0].checks).toEqual([{ method: "get_log_in_button", argument: "" }]);
  });

  it("propagates a non-empty count=0 warning through the ok:true branch", async () => {
    const verifier = new FakeLocatorVerifier([{ ok: true, warnings: "el locator log_in_button no se encontró (0 elementos)" }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toBe("el locator log_in_button no se encontró (0 elementos)");
  });

  it("parses the stale count out of the verifier's real failure-text format", async () => {
    const verifier = new FakeLocatorVerifier([{
      ok: false,
      errors: 'El locator get_log_in_button("") resolvió a 3 elementos reales:\n1) <button>Log in</button>\nHazlo más específico para que resuelva exactamente a 1 elemento.',
    }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stale).toEqual([{ screenId: "login", name: "log_in_button", count: 3 }]);
  });

  it("defaults the stale count to 0 when the failure text carries no explicit count", async () => {
    const verifier = new FakeLocatorVerifier([{
      ok: false,
      errors: 'El locator get_log_in_button("") no se pudo verificar: Timeout 30000ms exceeded.',
    }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stale).toEqual([{ screenId: "login", name: "log_in_button", count: 0 }]);
  });

  it("resolves urlTemplate against baseUrl, dedupes, and falls back to baseUrl for a parameterised template", async () => {
    const twoScreenMap: AppMap = {
      ...map,
      screens: [
        map.screens[0],
        {
          id: "checkout", name: "Checkout", className: "CheckoutPage", urlTemplate: "/checkout",
          signature: "sha256:b", requiresAuth: false,
          texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
          locators: [
            { name: "buy_button", kind: "button", accessibleName: "Buy",
              python: 'page.get_by_role("button", name="Buy", exact=True)', count: 1, verifiedAt: "t" },
          ],
        },
        {
          id: "item", name: "Item", className: "ItemPage", urlTemplate: "/item/:id",
          signature: "sha256:c", requiresAuth: false,
          texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
          locators: [
            { name: "add_to_cart_button", kind: "button", accessibleName: "Add to cart",
              python: 'page.get_by_role("button", name="Add to cart", exact=True)', count: 1, verifiedAt: "t" },
          ],
        },
      ],
    };
    const threeScreenFeature =
      `Feature: F\n\n` +
      `  @screen:login\n  Scenario: A\n    When I click "Log in"\n\n` +
      `  @screen:checkout\n  Scenario: B\n    When I click "Buy"\n\n` +
      `  @screen:item\n  Scenario: C\n    When I click "Add to cart"\n`;

    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    await checkMapFreshness(locatorsUsedBy(threeScreenFeature, twoScreenMap), verifier, "https://example.test/", undefined);
    // The templated /item/:id screen cannot resolve to a concrete URL, so it
    // falls back to baseUrl — which is already the login screen's resolved
    // URL, so deduping collapses them into one entry rather than three.
    // Detection must use the project's real templating marker (":" — see
    // appMap/urlTemplate.ts and pageObjectEmitter.ts's own `.includes(":")`
    // check), not a "{" that no AppMap in this codebase ever produces.
    expect(verifier.receivedCalls[0].urls.sort()).toEqual([
      "https://example.test/",
      "https://example.test/checkout",
    ]);
  });

  it("does not report a healthy locator whose name is a substring of another used locator's name", async () => {
    // uniqueName() in appMap/naming.ts produces exactly this shape when two
    // elements on one screen share a base name: `submit` and `submit_2`.
    // Only `submit_2` is genuinely ambiguous here; `submit` must stay clean.
    const formMap: AppMap = {
      ...map,
      screens: [{
        id: "form", name: "Form", className: "FormPage", urlTemplate: "/",
        signature: "sha256:d", requiresAuth: false,
        texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
        locators: [
          { name: "submit", kind: "button", accessibleName: "Submit",
            python: 'page.get_by_role("button", name="Submit", exact=True)', count: 1, verifiedAt: "t" },
          { name: "submit_2", kind: "button", accessibleName: "Submit now",
            python: 'page.get_by_role("button", name="Submit now", exact=True)', count: 1, verifiedAt: "t" },
        ],
      }],
    };
    const formFeature =
      `Feature: F\n\n  @screen:form\n  Scenario: S\n    When I click "Submit"\n    And I click "Submit now"\n`;
    const verifier = new FakeLocatorVerifier([{
      ok: false,
      errors:
        'El locator get_submit_2("") resolvió a 2 elementos reales:\n' +
        "1) <button>Submit now</button>\n" +
        "2) <button>Submit now</button>\n" +
        "Hazlo más específico para que resuelva exactamente a 1 elemento.",
    }]);
    const result = await checkMapFreshness(locatorsUsedBy(formFeature, formMap), verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    // If the match stayed a plain substring test, "submit" would also match
    // inside "get_submit_2(...)" and get reported stale with submit_2's
    // count — a healthy locator flagged for a failure that isn't its own.
    if (!result.ok) {
      expect(result.stale).toEqual([{ screenId: "form", name: "submit_2", count: 2 }]);
    }
  });
});
