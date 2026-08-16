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
