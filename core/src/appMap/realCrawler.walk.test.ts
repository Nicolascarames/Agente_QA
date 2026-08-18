import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { createRealCrawler } from "./realCrawler.js";
import type { CrawlLimits } from "./crawler.js";

const limits: CrawlLimits = {
  maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
  loopSuspicionThreshold: 3, excludeRoutes: [], maxViewDepth: 4,
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

  // A click that changes the view without changing the URL is the primary
  // target class of this tool, and the walk used to produce NOTHING for it: a
  // transition was only recorded, and a destination only enqueued, when the URL
  // changed. On a real client-rendered login — where "Forgot password?" leaves
  // `page.url()` identical and swaps the panel — the crawl found exactly one
  // screen and stopped. The design already had the right concept: a content
  // change without a route change is a STATE of the same screen, which is what
  // keeps "one Page Object per route" intact. Only the write pass ever produced
  // one.
  //
  // /state.html is the crawl's base URL so the screen count is unambiguous.
  describe("a click that changes the view without changing the route", () => {
    const crawlStateFixture = () =>
      createRealCrawler().crawl({
        baseUrl: site.url.replace(/\/$/, "") + "/state.html", limits,
        callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
        emit: () => {},
      });

    it("records the swapped view as a state of the same screen, leaving the screen count alone", async () => {
      const result = await crawlStateFixture();
      if (!result.ok) throw new Error(result.error);
      expect(result.map.screens).toHaveLength(1);
      const screen = result.map.screens[0];
      const state = screen.states.find((s) => s.reachedBy.action === "click");
      expect(state).toBeDefined();
      const forgot = screen.locators.find((l) => l.accessibleName === "Forgot password?");
      expect(state!.reachedBy.locator).toBe(forgot!.name);
      expect(screen.texts).toContain("We will email you a reset link.");
    }, 20000);

    it("tags a locator that only exists in that state with its stateId", async () => {
      const result = await crawlStateFixture();
      if (!result.ok) throw new Error(result.error);
      const screen = result.map.screens[0];
      const sendLink = screen.locators.find((l) => l.accessibleName === "Send reset link");
      expect(sendLink).toBeDefined();
      expect(sendLink!.stateId).toBe(screen.states.find((s) => s.reachedBy.action === "click")!.id);
    }, 20000);

    // Two controls open the SAME panel. The second must add nothing, or a
    // toggle would grow one state per click.
    it("does not record a second state for a view it has already recorded", async () => {
      const result = await crawlStateFixture();
      if (!result.ok) throw new Error(result.error);
      expect(result.map.screens[0].states).toHaveLength(1);
    }, 20000);
  });

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

  // The bug this plan exists to fix, in miniature: a login that swaps the DOM
  // in place (no route change) followed by a button whose own content reveals
  // a REAL form. Before this rewrite, nothing inside a same-route state was
  // ever clicked — the click loop's locator list was snapshotted once, before
  // any state existed — so the "Create baby" button was invisible past the
  // login, let alone the form it opens.
  describe("a click inside a same-route login state that reveals a real form", () => {
    const crawlNestedFixture = () =>
      createRealCrawler().crawl({
        baseUrl: site.url.replace(/\/$/, "") + "/spa-nested.html",
        limits,
        credentials: { username: "user@example.test", password: "secret" },
        callbacks: {
          confirmContinueOnLoop: async () => false,
          approveWriteActions: async (pending) => pending.map((p) => ({ screenId: p.screenId, locator: p.action.locator })),
        },
        emit: () => {},
      });

    it("promotes the baby-creation form to its own screen with a reachedBy path", async () => {
      const result = await crawlNestedFixture();
      if (!result.ok) throw new Error(result.error);
      const babyScreen = result.map.screens.find((s) => s.reachedBy !== undefined);
      expect(babyScreen).toBeDefined();
      expect(babyScreen!.reachedBy).toEqual({
        entryScreenId: result.map.screens[0].id,
        path: [
          { action: "submit", locator: expect.any(String), data: "valid" },
          { action: "click", locator: "create_baby_button", data: "none" },
        ],
      });
      const nameInput = babyScreen!.locators.find((l) => l.kind === "input");
      expect(nameInput).toBeDefined();
    }, 20000);

    // 3, not 2: the login screen, the promoted baby-form screen, and (Tarea
    // 11) the "Nursery" screen the Dashboard's real link reaches — a normal,
    // addressable screen like any other, discovered down the same same-route
    // dashboard state as the promoted baby-form.
    it("keeps screen count at 3: the login screen, the promoted baby-form screen and the nursery screen", async () => {
      const result = await crawlNestedFixture();
      if (!result.ok) throw new Error(result.error);
      expect(result.map.screens).toHaveLength(3);
    }, 20000);

    // The fixture's "Show tips" button lives on the ALREADY-PROMOTED baby-form
    // screen, not on the dashboard. Clicking it is a second hop past the
    // promotion boundary (path length 3): what it reveals must be recorded
    // against the promoted screen, never against the dashboard entry.
    it("records a second hop through an already-promoted screen against that screen, not the entry", async () => {
      const result = await crawlNestedFixture();
      if (!result.ok) throw new Error(result.error);
      const entry = result.map.screens[0];
      const babyScreen = result.map.screens.find((s) => s.reachedBy !== undefined);
      expect(babyScreen).toBeDefined();

      const showTips = babyScreen!.locators.find((l) => l.accessibleName === "Show tips");
      expect(showTips).toBeDefined();
      expect(babyScreen!.states.some((s) => s.reachedBy.locator === showTips!.name)).toBe(true);
      expect(babyScreen!.texts).toContain("Keep skin to skin contact.");

      expect(entry.texts).not.toContain("Keep skin to skin contact.");
      expect(entry.locators.some((l) => l.accessibleName === "Show tips")).toBe(false);
    }, 20000);

    // Tarea 11: the nursery form's "Save" is a write action nested behind an
    // already-approved write action (the login submit) — it does not exist
    // in any `screen.writeActions` until the login's submit already ran and
    // a following drain already followed the "Nursery" link the login
    // revealed. A single approval pass can never see it; only a loop that
    // keeps asking until a round finds nothing new does.
    it("asks approval again for a write action only discovered after an earlier one ran, and runs it", async () => {
      let approveCalls = 0;
      const result = await createRealCrawler().crawl({
        baseUrl: site.url.replace(/\/$/, "") + "/spa-nested.html",
        limits,
        credentials: { username: "user@example.test", password: "secret" },
        callbacks: {
          confirmContinueOnLoop: async () => false,
          approveWriteActions: async (pending) => {
            approveCalls++;
            return pending.map((p) => ({ screenId: p.screenId, locator: p.action.locator }));
          },
        },
        emit: () => {},
      });
      if (!result.ok) throw new Error(result.error);

      // Proves the loop actually iterated more than once, not that a single
      // call happened to see everything.
      expect(approveCalls).toBeGreaterThan(1);

      const nurseryScreen = result.map.screens.find((s) => s.urlTemplate === "/nursery.html");
      expect(nurseryScreen).toBeDefined();
      const created = nurseryScreen!.texts.includes("Baby created!")
        || nurseryScreen!.states.some((s) => s.addsTexts.includes("Baby created!"));
      expect(created).toBe(true);
    }, 20000);
  });
});
