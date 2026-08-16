import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { createRealCrawler } from "./realCrawler.js";
import type { CrawlLimits, CrawlResult } from "./crawler.js";

const limits: CrawlLimits = {
  maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
  loopSuspicionThreshold: 3, excludeRoutes: [],
};
const credentials = { username: "user@example.test", password: "s3cr3t-pass" };

let site: Awaited<ReturnType<typeof startFixtureSite>>;
beforeAll(async () => { site = await startFixtureSite(); });
afterAll(async () => { await site.close(); });

// A full crawl now waits for `networkidle` (short, explicit timeout) once per
// captured screen — real but bounded time client-rendered content needs to
// mount — so a multi-screen fixture crawl runs past vitest's 5s default. 20s
// matches the timeout already used for other real-browser suites in this
// project (see core/src/locatorVerify/realLocatorVerifier.test.ts).
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
  }, 20000);

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
  }, 20000);

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
  }, 20000);

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
  }, 20000);

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
  }, 20000);

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
  }, 20000);

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
  }, 20000);

  // The password field is disambiguated to region:main by the header decoy
  // sharing its label. Filling it by re-resolving the label unscoped matches
  // twice, violates strict mode, gets swallowed, and leaves the field empty —
  // so the "valid" submit never authenticates. `authenticated` above already
  // proves the fill worked; this proves the crawler does not claim to have
  // typed a value it could not type.
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
  }, 20000);

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
  }, 20000);

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
  }, 20000);

  // Clicking it would kill the session the authenticated pass depends on.
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
  }, 20000);

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
  }, 20000);

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
  }, 20000);
});
