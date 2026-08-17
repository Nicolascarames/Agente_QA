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
    const result = locatorsUsedBy(feature, map);
    expect(result.used.map((u) => u.locator.name)).toEqual(["log_in_button"]);
  });

  it("returns nothing for a scenario with no screen tag", () => {
    expect(locatorsUsedBy(`Feature: F\n  Scenario: S\n    When I click "Log in"\n`, map).used).toEqual([]);
  });

  it("collects the field name from an I fill step, never the data value it types", () => {
    // If the implementation ever captured the second quoted group (the data)
    // instead of the first (the field), "someone@example.com" would not
    // resolve against any locator's accessibleName/name and `used` would
    // come back empty instead of naming email_input.
    const fillFeature = `Feature: F\n\n  @screen:login\n  Scenario: S\n    When I fill "Email" with "someone@example.com"\n`;
    const result = locatorsUsedBy(fillFeature, map);
    expect(result.used.map((u) => u.locator.name)).toEqual(["email_input"]);
  });
});

describe("locatorsUsedBy with two locators sharing an accessible name", () => {
  const twinsMap: AppMap = {
    ...map,
    screens: [{
      id: "home", name: "home", className: "HomePage", urlTemplate: "/",
      signature: "sha256:t", requiresAuth: false,
      texts: ["Log in"], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
      locators: [
        { name: "log_in_button", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'button\']"))',
          count: 1, verifiedAt: "t" },
        { name: "log_in_button_submit", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))',
          count: 1, verifiedAt: "t" },
      ],
    }],
  };

  const ambiguousFeature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n`;

  it("reports the ambiguity instead of silently taking the first match", () => {
    const result = locatorsUsedBy(ambiguousFeature, twinsMap);
    expect(result.used).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].quoted).toBe("Log in");
    expect(result.ambiguous[0].screenId).toBe("home");
    expect(result.ambiguous[0].candidates.map((c) => c.name)).toEqual([
      "log_in_button",
      "log_in_button_submit",
    ]);
  });

  it("resolves cleanly once the step names the locator itself", () => {
    const rewritten = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "log_in_button_submit"\n`;
    const result = locatorsUsedBy(rewritten, twinsMap);
    expect(result.ambiguous).toEqual([]);
    expect(result.used.map((u) => u.locator.name)).toEqual(["log_in_button_submit"]);
  });

  it("reports one ambiguity per quoted text, not one per step", () => {
    const twice = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n    When I click "Log in"\n`;
    expect(locatorsUsedBy(twice, twinsMap).ambiguous).toHaveLength(1);
  });

  it("treats the second quoted group of a fill step as data, never a locator", () => {
    const fill = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I fill "Log in" with "Log in"\n`;
    const result = locatorsUsedBy(fill, twinsMap);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].quoted).toBe("Log in");
  });
});

describe("checkMapFreshness", () => {
  it("passes when every used locator still resolves to one element", async () => {
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map).used, verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(true);
    // The map's login screen here has requiresAuth: false — a regression that
    // always attached the auth warning regardless of requiresAuth would still
    // pass every OTHER test in this file, since most of them never assert
    // warnings is absent.
    if (result.ok) expect(result.warnings).toBeUndefined();
  });

  it("reports the stale locator by name and screen when it no longer resolves", async () => {
    const verifier = new FakeLocatorVerifier([
      { ok: false, errors: 'El locator get_log_in_button("") no se pudo verificar: 0 coincidencias.' },
    ]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map).used, verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stale[0].name).toBe("log_in_button");
  });

  it("synthesizes a Page Object whose locator expression matches the map's python letter for letter", async () => {
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    await checkMapFreshness(locatorsUsedBy(feature, map).used, verifier, "https://example.test/", undefined);
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
    await checkMapFreshness(locatorsUsedBy(feature, map).used, verifier, "https://example.test/", undefined);
    expect(verifier.receivedCalls[0].checks).toEqual([{ method: "get_log_in_button", argument: "" }]);
  });

  it("propagates a non-empty count=0 warning through the ok:true branch", async () => {
    const verifier = new FakeLocatorVerifier([{ ok: true, warnings: "el locator log_in_button no se encontró (0 elementos)" }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map).used, verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toBe("el locator log_in_button no se encontró (0 elementos)");
  });

  it("parses the stale count out of the verifier's real failure-text format", async () => {
    const verifier = new FakeLocatorVerifier([{
      ok: false,
      errors: 'El locator get_log_in_button("") resolvió a 3 elementos reales:\n1) <button>Log in</button>\nHazlo más específico para que resuelva exactamente a 1 elemento.',
    }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map).used, verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stale).toEqual([{ screenId: "login", name: "log_in_button", count: 3 }]);
  });

  it("defaults the stale count to 0 when the failure text carries no explicit count", async () => {
    const verifier = new FakeLocatorVerifier([{
      ok: false,
      errors: 'El locator get_log_in_button("") no se pudo verificar: Timeout 30000ms exceeded.',
    }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, map).used, verifier, "https://example.test/", undefined);
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
    await checkMapFreshness(locatorsUsedBy(threeScreenFeature, twoScreenMap).used, verifier, "https://example.test/", undefined);
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
    const result = await checkMapFreshness(locatorsUsedBy(formFeature, formMap).used, verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    // If the match stayed a plain substring test, "submit" would also match
    // inside "get_submit_2(...)" and get reported stale with submit_2's
    // count — a healthy locator flagged for a failure that isn't its own.
    if (!result.ok) {
      expect(result.stale).toEqual([{ screenId: "form", name: "submit_2", count: 2 }]);
    }
  });

  it("does not misattribute a failure of a longer locator name to a shorter one it contains as a suffix", async () => {
    // The previous fix only checked the RIGHT boundary of the match (the
    // character after it must not be a word character). That is not enough:
    // with locators "submit" and "form_submit", a failure naming
    // "get_form_submit(" has "submit" match INSIDE "form_submit", and the
    // character right after that match is "(" — a non-word character — so the
    // right-boundary check alone reports "submit" as stale even though only
    // "form_submit" ever failed. A left boundary can't fix this either: the
    // real match point is "get_<name>(", whose preceding character is always
    // "_", a word character, so a symmetric boundary check would reject every
    // genuine match too. The only correct fix is to search for the literal
    // marker "get_${name}(" as a whole.
    const formMap: AppMap = {
      ...map,
      screens: [{
        id: "checkout", name: "Checkout", className: "CheckoutPage", urlTemplate: "/",
        signature: "sha256:e", requiresAuth: false,
        texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
        locators: [
          { name: "submit", kind: "button", accessibleName: "Submit",
            python: 'page.get_by_role("button", name="Submit", exact=True)', count: 1, verifiedAt: "t" },
          { name: "form_submit", kind: "button", accessibleName: "Submit form",
            python: 'page.get_by_role("button", name="Submit form", exact=True)', count: 1, verifiedAt: "t" },
        ],
      }],
    };
    const checkoutFeature =
      `Feature: F\n\n  @screen:checkout\n  Scenario: S\n    When I click "Submit"\n    And I click "Submit form"\n`;
    const verifier = new FakeLocatorVerifier([{
      ok: false,
      errors:
        'El locator get_form_submit("") resolvió a 3 elementos reales:\n' +
        "1) <button>Submit form</button>\n" +
        "2) <button>Submit form</button>\n" +
        "3) <button>Submit form</button>\n" +
        "Hazlo más específico para que resuelva exactamente a 1 elemento.",
    }]);
    const result = await checkMapFreshness(locatorsUsedBy(checkoutFeature, formMap).used, verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stale).toEqual([{ screenId: "checkout", name: "form_submit", count: 3 }]);
    }
  });

  it("reports explicitly that a screen requiring a session could not be verified, instead of silently reading as verified", async () => {
    // The generated Python this check runs exports credentials as env vars and
    // does goto + count — it never logs in. A screen behind auth renders the
    // login form during this check, every locator legitimately counts 0 (a
    // WARNING per the rule above, not a failure), and without this the result
    // is a bare `ok: true` that looks identical to a screen that was actually
    // verified.
    const authMap: AppMap = { ...map, screens: [{ ...map.screens[0], requiresAuth: true }] };
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, authMap).used, verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toContain(authMap.screens[0].name);
      expect(result.warnings).toMatch(/sesión/i);
    }
  });

  it("combines the auth warning with a genuine verifier warning instead of dropping one", async () => {
    const authMap: AppMap = { ...map, screens: [{ ...map.screens[0], requiresAuth: true }] };
    const verifier = new FakeLocatorVerifier([
      { ok: true, warnings: "el locator log_in_button no se encontró (0 elementos)" },
    ]);
    const result = await checkMapFreshness(locatorsUsedBy(feature, authMap).used, verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContain("el locator log_in_button no se encontró (0 elementos)");
      expect(result.warnings).toMatch(/sesión/i);
    }
  });
});
