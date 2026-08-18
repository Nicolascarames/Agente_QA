import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { createRealCrawler } from "./realCrawler.js";
import type { CrawlLimits, CrawlResult } from "./crawler.js";

const limits: CrawlLimits = {
  maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
  loopSuspicionThreshold: 3, excludeRoutes: [], maxViewDepth: 4,
};
const credentials = { username: "user@example.test", password: "s3cr3t-pass" };

let site: Awaited<ReturnType<typeof startFixtureSite>>;
beforeAll(async () => { site = await startFixtureSite(); });
afterAll(async () => { await site.close(); });

// A full crawl waits for `networkidle` (short, explicit timeout) once per
// captured screen — real but bounded time client-rendered content needs to
// mount — so a multi-screen fixture crawl runs past vitest's 5s default.
//
// 40s, not the 20s the unauthenticated walk suite uses: every crawl in THIS
// file carries credentials, and a credentialed crawl now ends with the
// session-less `requiresAuth` derivation, one extra request per screen.
// Measured on this fixture: ~9.6s of walk plus ~4.6s of derivation over 10
// screens (~460ms each), against a 14.2s total.
describe.skipIf(!chromium.executablePath())("createRealCrawler — write pass", () => {
  it("does not execute any write action when the user approves none", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.states).toHaveLength(0);
  }, 40000);

  it("captures the error message only reachable by submitting invalid data", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.texts).toContain("Authentication failed. Please try again.");
    expect(login?.states.some((s) => s.reachedBy.data === "invalid")).toBe(true);
  }, 40000);

  it("keeps the error message as a state of the same screen, not a new screen", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.screens.filter((s) => s.urlTemplate === "/")).toHaveLength(1);
  }, 40000);

  it("records the values it typed in probeValues and keeps them out of texts", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.probeValues.length).toBeGreaterThan(0);
    for (const value of login!.probeValues) expect(login!.texts).not.toContain(value);
  }, 40000);

  it("marks the map as authenticated when the login succeeds", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.authenticated).toBe(true);
  }, 40000);

  it("never leaks the real password into the map", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(JSON.stringify(result.map)).not.toContain("s3cr3t-pass");
  }, 40000);

  // Review finding: the submit click used to re-resolve the button by
  // `getByRole("button", { name, exact }).last()` — DOM position, not the
  // `disambiguatedBy` region `resolveCandidate` already established at
  // capture time. It only worked because the header's decoy "Log in" button
  // happens to precede the form's submit button. index.html also carries a
  // SECOND decoy, placed AFTER the form, precisely so `.last()` would click
  // it instead of the real submit button under the old code: the real submit
  // would never fire, the login would never navigate, and the merge branch
  // would push the user's real typed password into `screen.probeValues`
  // without ever setting `authenticated`. This proves the write pass reuses
  // the region scope instead, regardless of where decoys sit in the DOM.
  it("resolves the submit button by its recorded region scope, not by DOM position, with a decoy on both sides", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.authenticated).toBe(true);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.probeValues).not.toContain(credentials.password);
  }, 40000);

  // `probeValues` is the crawler's record of what it TYPED, and the whole map
  // trusts it: `texts` is filtered against it, and the prompt builder treats
  // anything containing a probe value as tainted. Asserting only that the
  // invalid password is present passed just as well under the old
  // push-before-fill ordering, which recorded a value the moment it decided to
  // type it — before knowing whether the field took it.
  //
  // The login form carries a file input, which `fill()` refuses outright: a
  // field that resolves to exactly one element and still cannot be written.
  // Its value must therefore be absent — "agente-qa" on the valid pass, the
  // empty string on the invalid one — while the values that really were typed
  // are present. That is the ordering, and the old code violates it.
  it("only records a probe value once the field really took it", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.probeValues).toContain("agente-qa-invalid-password");
    expect(login?.probeValues).not.toContain("agente-qa");
    expect(login?.probeValues).not.toContain("");
  }, 40000);

  // `requiresAuth` used to be stamped from the crawl's single `authenticated`
  // flag, so a credentialed crawl marked EVERY screen private — the login
  // screen, the password-reset screen and every public listing included.
  // Consumers read this flag to decide whether a generated test needs a
  // logged-in fixture, so the follow-up plan would have wrapped a login around
  // every test, including the test for the login screen itself. The spec's own
  // example map shows the login screen as `requiresAuth: false`.
  it("marks only the screens that really need a session, not every screen of a credentialed crawl", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.authenticated).toBe(true);

    const at = (template: string) => result.map.screens.find((s) => s.urlTemplate === template);
    expect(at("/")).toBeDefined();
    expect(at("/")!.requiresAuth).toBe(false);
    expect(at("/reset.html")!.requiresAuth).toBe(false);
    expect(at("/list.html")!.requiresAuth).toBe(false);
    expect(at("/dashboard.html")).toBeDefined();
    expect(at("/dashboard.html")!.requiresAuth).toBe(true);
  }, 40000);

  // The crawl proceeds authenticated: nothing on the public surface links to
  // /dashboard.html, so it can only enter the map through a real login.
  it("maps the area behind the login and marks those screens as private", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async () => [],
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const dashboard = result.map.screens.find((s) => s.urlTemplate === "/dashboard.html");
    expect(dashboard).toBeDefined();
    expect(dashboard!.requiresAuth).toBe(true);
    expect(result.map.authenticated).toBe(true);
  }, 40000);

  it("leaves the map unauthenticated and public when there are no credentials", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.authenticated).toBe(false);
    expect(result.map.screens.some((s) => s.urlTemplate === "/dashboard.html")).toBe(false);
    expect(result.map.screens.every((s) => s.requiresAuth === false)).toBe(true);
  }, 40000);

  // Clicking it would kill the session the authenticated pass depends on.
  //
  // The fixture's log out button now has a REAL handler that clears the
  // session cookie and navigates. Without one this test passed with the guard
  // deleted: the click did nothing, so no transition was recorded either way
  // and the assertion could not fail. Proving the control still WOULD navigate
  // is what makes "no transition" mean "the crawler refused", and the walk
  // reaching /list.html afterwards is what proves the session survived.
  it("never follows the log out control while walking", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const dashboard = result.map.screens.find((s) => s.urlTemplate === "/dashboard.html");
    const logOut = dashboard?.locators.find((l) => l.accessibleName === "Log out");
    expect(logOut).toBeDefined();
    expect(dashboard!.transitions.some((t) => t.locator === logOut!.name)).toBe(false);
    // The session outlived the walk: /dashboard.html is served only with the
    // cookie, and the write pass reloads it.
    expect(dashboard!.requiresAuth).toBe(true);
  }, 40000);

  // The same control recognised by where it GOES. The fixture's "Exit" link
  // points at /logout and is named nothing a name test could catch, so only
  // the resolved href gives it away. The server is dedicated so the assertion
  // can be about the REQUEST: /logout must never be fetched at all.
  it("never follows a control whose href is a logout route, whatever it is called", async () => {
    const dedicated = await startFixtureSite();
    try {
      const result = await createRealCrawler().crawl({
        baseUrl: dedicated.url, limits, credentials,
        callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
        emit: () => {},
      });
      if (!result.ok) throw new Error(result.error);
      const dashboard = result.map.screens.find((s) => s.urlTemplate === "/dashboard.html");
      const exit = dashboard?.locators.find((l) => l.accessibleName === "Exit");
      expect(exit).toBeDefined();
      expect(dashboard!.transitions.some((t) => t.locator === exit!.name)).toBe(false);
      expect(dedicated.requestedPaths).not.toContain("/logout");
    } finally {
      await dedicated.close();
    }
  }, 40000);

  // A route template with a variable segment is not a URL. The write pass used
  // to rebuild one from the template, which makes the crawler ask the server
  // for a literal "/blog/:id" — the same defect already fixed in the Page
  // Object emitter. The assertion is on the REQUEST, not on the map: the
  // fixture server serves blog.html for anything under /blog/, so a literal
  // ":id" request would succeed and leave no trace anywhere else.
  it("never requests a literal route template when submitting on a templated screen", async () => {
    const dedicated = await startFixtureSite();
    try {
      const result = await createRealCrawler().crawl({
        baseUrl: dedicated.url, limits, credentials,
        callbacks: {
          confirmContinueOnLoop: async () => false,
          approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
        },
        emit: () => {},
      });
      if (!result.ok) throw new Error(result.error);
      const blog = result.map.screens.find((s) => s.urlTemplate === "/blog/:id");
      expect(blog).toBeDefined();
      // The submit really ran on that screen...
      expect(blog!.states.some((s) => s.reachedBy.data === "invalid")).toBe(true);
      // ...without the literal template ever reaching the server.
      expect(dedicated.requestedPaths.filter((p) => p.includes(":"))).toEqual([]);
    } finally {
      await dedicated.close();
    }
  }, 40000);

  // The event channel is a third consumer of the same data the two redaction
  // nets protect, and it reaches the terminal and CI logs. A form submitting
  // by GET puts the credentials straight into `page.url()`, which several
  // messages interpolate. Any string configured as a credential must come out
  // redacted, wherever in a message it appears.
  it("never lets a configured credential out through the event channel", async () => {
    const messages: string[] = [];
    await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      credentials: { username: "list.html", password: "s3cr3t-pass" },
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: (event) => messages.push(`${event.message}|${event.detail ?? ""}`),
    });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("[REDACTED]"))).toBe(true);
    for (const message of messages) {
      expect(message).not.toContain("list.html");
      expect(message).not.toContain("s3cr3t-pass");
    }
  }, 40000);

  // Review finding: the write pass's own `page.goto` (reloading the screen
  // before each submit attempt) had no try/catch and sat inside the
  // `try { ... } finally { browser.close() }` region with no enclosing
  // `catch` — the browser closed, but the throw still propagated past
  // `crawl()`, rejecting the whole promise instead of resolving
  // `{ ok: false, error }`, breaking the contract every caller relies on.
  // A dedicated fixture server is closed right at the walk/write-pass
  // boundary (inside `approveWriteActions`, the last callback before the
  // write pass starts) so the write pass's own `goto` is the one that fails.
  it("resolves instead of rejecting when the write pass cannot reload a screen", async () => {
    const dedicated = await startFixtureSite();
    const events: string[] = [];
    let result: CrawlResult;
    try {
      result = await createRealCrawler().crawl({
        baseUrl: dedicated.url, limits, credentials,
        callbacks: {
          confirmContinueOnLoop: async () => false,
          approveWriteActions: async (actions) => {
            await dedicated.close();
            return actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator }));
          },
        },
        emit: (event) => events.push(`${event.status}:${event.message}`),
      });
    } finally {
      await dedicated.close().catch(() => undefined);
    }
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.startsWith("warn:"))).toBe(true);
  }, 40000);

  it("marks the crawl authenticated after a login that swaps the view without changing the URL", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url.replace(/\/$/, "") + "/spa-login-only.html",
      limits,
      credentials: { username: "user@example.test", password: "secret" },
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.authenticated).toBe(true);
  }, 20000);
});
