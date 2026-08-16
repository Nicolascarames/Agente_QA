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

  // An excluded route is an admin area or an endpoint with side effects on
  // load: discarding its capture after requesting it fails the whole promise
  // of the setting. A dedicated server instance keeps the recorded requests to
  // this one crawl.
  it("skips routes matched by excludeRoutes without ever requesting them", async () => {
    const dedicated = await startFixtureSite();
    try {
      const result = await createRealCrawler().crawl({
        baseUrl: dedicated.url, limits: { ...limits, excludeRoutes: ["/reset.html"] },
        callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
        emit: () => {},
      });
      if (!result.ok) throw new Error(result.error);
      expect(result.map.screens.some((s) => s.urlTemplate === "/reset.html")).toBe(false);
      expect(dedicated.requestedPaths).not.toContain("/reset.html");
      expect(dedicated.requestedPaths).toContain("/list.html");
    } finally {
      await dedicated.close();
    }
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
    const list = result.map.screens.find((s) => s.urlTemplate === "/list.html");
    expect(list).toBeDefined();
    expect(transition?.toScreenId).toBe(list!.id);
  }, 20000);

  // `toScreenId` is read against `screen.id` by every consumer. It used to
  // hold the route template, which matches no screen id at all, and exactly
  // one consumer compensated for it.
  //
  // Skipping nulls made this test blind to the defect that mattered: a
  // transition into a screen that was later renamed by the sibling collapse
  // (`/blog/first-post` → `/blog/:id`) resolved to null, and the prompt
  // builder prints null as "(externo)" — the map claimed three links out of
  // /list.html left the application. Every transition here has an internal
  // destination (the fixture links nowhere off-host, so `externalUrl` is never
  // set), so null is always a failure. The loop question is answered YES so
  // that no branch is pruned: a pruned destination is legitimately unknown and
  // would muddy what this test is about.
  it("resolves every internal transition to a real screen id, never to null", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => true, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const ids = new Set(result.map.screens.map((s) => s.id));
    const transitions = result.map.screens.flatMap((s) => s.transitions);
    expect(transitions.length).toBeGreaterThan(0);
    for (const transition of transitions) {
      if (transition.externalUrl !== undefined) continue;
      expect(transition.toScreenId).not.toBeNull();
      expect(ids.has(transition.toScreenId!)).toBe(true);
    }
  }, 20000);

  // The three /blog/<slug> links out of /list.html all lead to the one screen
  // the collapse produced. Resolving them through the concrete templates they
  // were recorded under is what keeps them from coming back null.
  it("points every link into a collapsed sibling at the screen that absorbed it", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => true, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const list = result.map.screens.find((s) => s.urlTemplate === "/list.html");
    const blog = result.map.screens.find((s) => s.urlTemplate === "/blog/:id");
    expect(blog).toBeDefined();
    const intoBlog = list!.transitions.filter((t) => t.toScreenId === blog!.id);
    expect(intoBlog.map((t) => t.locator).sort()).toEqual(["first_post", "second_post", "third_post"]);
  }, 20000);

  // `appUrl` is validated as a URL but never normalised, so a base URL with no
  // trailing slash is legal config. String concatenation turned it into
  // "https://example.comlogin"; deciding "external" by string prefix let
  // "https://example.com.evil.test/panel" pass as internal.
  //
  // The write actions are APPROVED here on purpose. The only place that
  // reloads a screen by URL is the write pass, and this test approved nothing
  // — so the very path it exists to cover never executed and the test held
  // against any URL construction at all. Credentials come with it, because
  // approval alone does not reach a form behind a login.
  //
  // The assertion is on /blog/:id, NOT on the login screen. The login screen
  // sits at "/", where concatenating a slash-less base URL with the template
  // happens to produce a working URL — the fixture's root-mounted login hid
  // the bug. "/blog/:id" is the shape that breaks: concatenation yields
  // "http://127.0.0.1:PORTblog/:id". A state is the evidence the reload really
  // landed, since a malformed URL fails the goto, which is warned and skipped.
  it("works the same when the base URL carries no trailing slash", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url.replace(/\/$/, ""), limits,
      credentials: { username: "user@example.test", password: "s3cr3t-pass" },
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const templates = result.map.screens.map((s) => s.urlTemplate);
    expect(templates).toContain("/");
    expect(templates).toContain("/list.html");

    const blog = result.map.screens.find((s) => s.urlTemplate === "/blog/:id");
    expect(blog).toBeDefined();
    expect(blog!.states.some((s) => s.reachedBy.data === "invalid")).toBe(true);
    expect(blog!.texts).toContain("Thanks for your comment.");
  }, 40000);

  // Third templating rule of the spec: two sibling URLs differing in exactly
  // one segment are one screen with different data. Without it a blog or a
  // catalogue becomes one screen — and one committed Page Object — per item.
  //
  // The THIRD post is what makes this test discriminating. Once the first pair
  // collapses, the stored template carries `:id` and `siblingTemplate` returns
  // null for any further comparison against it, so the rule used to go quiet
  // from item three onward and the map came back with both `/blog/:id` AND
  // `/blog/third-post`. Exactly one screen is the assertion, not merely the
  // presence of `/blog/:id`.
  it("collapses every sibling route that renders the same screen, not just the first pair", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.screens.filter((s) => s.urlTemplate === "/blog/:id")).toHaveLength(1);
    const templates = result.map.screens.map((s) => s.urlTemplate);
    expect(templates).not.toContain("/blog/first-post");
    expect(templates).not.toContain("/blog/second-post");
    expect(templates).not.toContain("/blog/third-post");
  }, 20000);

  // The logout guard exists to protect a session the crawl is holding. This
  // crawl holds none — no credentials — so a public control that merely looks
  // like a way out is an ordinary link, and skipping it drops a real screen
  // for nothing.
  it("follows a control that only looks like a log out when the crawl holds no session", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => true, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const reset = result.map.screens.find((s) => s.urlTemplate === "/reset.html");
    const logOut = reset?.locators.find((l) => l.accessibleName === "Log out");
    expect(logOut).toBeDefined();
    expect(reset!.transitions.some((t) => t.locator === logOut!.name)).toBe(true);
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
