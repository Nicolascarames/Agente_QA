import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { createRealCrawler } from "./realCrawler.js";
import type { CrawlLimits } from "./crawler.js";

const limits: CrawlLimits = {
  maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
  loopSuspicionThreshold: 3, excludeRoutes: [],
};

let site: Awaited<ReturnType<typeof startFixtureSite>>;
beforeAll(async () => { site = await startFixtureSite(); });
afterAll(async () => { await site.close(); });

// A full crawl now waits for `networkidle` (short, explicit timeout) once per
// captured screen — real but bounded time client-rendered content needs to
// mount — so a multi-screen fixture crawl runs past vitest's 5s default. 20s
// matches the timeout already used for other real-browser suites in this
// project (see core/src/locatorVerify/realLocatorVerifier.test.ts).
describe.skipIf(!chromium.executablePath())("createRealCrawler — first pass", () => {
  it("discovers the routes reachable by clicking", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const templates = result.map.screens.map((s) => s.urlTemplate).sort();
    expect(templates).toContain("/");
    expect(templates).toContain("/reset.html");
  }, 20000);

  it("collapses /item/1 and /item/2 into a single templated screen", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.screens.filter((s) => s.urlTemplate === "/item/:id")).toHaveLength(1);
  }, 20000);

  it("records a transition for each click that changed screen", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.transitions.some((t) => t.urlChanged)).toBe(true);
  }, 20000);

  it("asks before continuing down a suspected loop and honours a no", async () => {
    // /loop-a, /loop-b and /loop-c are three DIFFERENT routes with identical
    // structure: URL templating cannot dedupe them, so the signature is the
    // only thing that can spot the repetition.
    let asked = 0;
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits: { ...limits, loopSuspicionThreshold: 2 },
      callbacks: { confirmContinueOnLoop: async () => { asked += 1; return false; }, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(asked).toBeGreaterThan(0);
    expect(result.map.screens.filter((s) => s.urlTemplate.startsWith("/loop-")).length).toBeLessThan(3);
  }, 20000);

  it("skips routes matched by excludeRoutes", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits: { ...limits, excludeRoutes: ["/reset.html"] },
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.screens.some((s) => s.urlTemplate === "/reset.html")).toBe(false);
  }, 20000);

  it("marks the map incomplete when a safety limit stops the crawl", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits: { ...limits, maxScreens: 1 },
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.complete).toBe(false);
  }, 20000);

  it("emits a start and an ok event per visited screen", async () => {
    const events: string[] = [];
    await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: (event) => events.push(`${event.status}:${event.message}`),
    });
    expect(events.some((e) => e.startsWith("ok:"))).toBe(true);
  }, 20000);

  it("does not submit any form during the first pass", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.states).toHaveLength(0);
    expect(login?.writeActions.length).toBeGreaterThan(0);
  }, 20000);

  // Review finding (Task 12-13 review, post-Task-14): the login page has a
  // "Help" link duplicated in the header and in <main>, pointing at DIFFERENT
  // destinations (/reset.html and /list.html respectively). `resolveCandidate`
  // disambiguates it to the <main> one at capture time (region:main comes
  // before region:banner in REGIONS). A click loop that re-resolves the name
  // unscoped and takes `.first()` would hit the header's twin instead — DOM
  // order puts <header> before <main> — and record a transition to the wrong
  // screen.
  it("clicks the region-scoped element recorded at capture time, not the first DOM match", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    const help = login?.locators.find((l) => l.accessibleName === "Help");
    expect(help?.disambiguatedBy).toBe("region:main");
    const transition = login?.transitions.find((t) => t.locator === help?.name);
    expect(transition?.toScreenId).toBe("/list.html");
  }, 20000);

  // Review finding: /order-history.html and /order/history.html both
  // normalize, via pythonIdentifier, to the same "order_history_html" — a
  // genuine screen-id collision that nothing before this test caught.
  it("gives every screen a unique id even when two routes normalize to the same identifier", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const dash = result.map.screens.find((s) => s.urlTemplate === "/order-history.html");
    const slash = result.map.screens.find((s) => s.urlTemplate === "/order/history.html");
    expect(dash).toBeDefined();
    expect(slash).toBeDefined();
    expect(dash!.id).not.toBe(slash!.id);

    const ids = result.map.screens.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 20000);
});
