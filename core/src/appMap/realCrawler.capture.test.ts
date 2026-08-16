import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { captureScreen, collectWriteActions, pythonLiteral } from "./realCrawler.js";
import type { AgentEvent } from "../events/agentEvent.js";

describe("pythonLiteral", () => {
  // Carried from the Task 6 review: pageObjectEmitter interpolates
  // LocatorEntry.python verbatim into generated Python, by design, without
  // parsing it. A real py_compile run proved that an accessible name with a
  // raw newline produces `SyntaxError: unterminated string literal` and makes
  // the generated test file uncollectable. Backslashes and quotes were
  // already escaped; \r, \n and \t must be too, so the literal always stays
  // on one line.

  it("escapes a raw newline into its Python escape sequence", () => {
    expect(pythonLiteral("Line one\nLine two")).toBe('"Line one\\nLine two"');
  });

  it("escapes a raw carriage return into its Python escape sequence", () => {
    expect(pythonLiteral("Line one\rLine two")).toBe('"Line one\\rLine two"');
  });

  it("escapes a raw tab into its Python escape sequence", () => {
    expect(pythonLiteral("Line one\tLine two")).toBe('"Line one\\tLine two"');
  });

  it("never leaves a raw newline, carriage return or tab in the output", () => {
    const literal = pythonLiteral("a\nb\rc\td");
    expect(literal).not.toMatch(/[\n\r\t]/);
  });

  it("still escapes backslashes and double quotes", () => {
    expect(pythonLiteral('back\\slash "quoted"')).toBe('"back\\\\slash \\"quoted\\""');
  });

  it("does not double-escape the backslashes introduced by newline escaping", () => {
    // The \n produced for the raw newline must not itself get re-escaped by
    // an earlier backslash pass, which would turn it into \\n.
    expect(pythonLiteral("a\nb")).not.toContain("\\\\n");
  });
});

let browser: Browser | null = null;
let site: Awaited<ReturnType<typeof startFixtureSite>>;

beforeAll(async () => {
  site = await startFixtureSite();
  try {
    browser = await chromium.launch();
  } catch {
    browser = null; // sin navegadores instalados: los tests se saltan
  }
});
afterAll(async () => {
  await browser?.close();
  await site.close();
});

describe.skipIf(!process.env.CI && !chromium.executablePath())("captureScreen", () => {
  it("records every visible text of the screen", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    expect(screen.texts).toContain("Welcome back");
    expect(screen.texts).toContain("Forgot password?");
    await page.close();
  });

  it("only keeps locators that resolve to exactly one element", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    for (const locator of screen.locators) expect(locator.count).toBe(1);
    await page.close();
  });

  it("disambiguates a duplicated button by scoping it to a region", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    const logIn = screen.locators.find((l) => l.accessibleName === "Log in" && l.kind === "button");
    expect(logIn).toBeDefined();
    expect(logIn!.disambiguatedBy).toBe("region:main");
    expect(logIn!.python).toContain('get_by_role("main")');
    await page.close();
  });

  it("never disambiguates by position", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    for (const locator of screen.locators) {
      expect(locator.python).not.toMatch(/\.(first|last|nth\()/);
    }
    await page.close();
  });

  // `getByRole("form")` only matches a <form> that HAS an accessible name, so
  // the "form" entry in the ARIA landmark list never fired for an unnamed one
  // — the overwhelmingly common case, and the shape of the real application
  // where "Log in", "Sign up" and "Welcome back" each matched twice with both
  // copies visible. The login button itself was missing from the Page Object.
  it("disambiguates through an unnamed form, which exposes no ARIA form role at all", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url.replace(/\/$/, "") + "/unnamed-form.html");
    // Ground truth first: the landmark scope really cannot see this form.
    expect(await page.getByRole("form").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Log in", exact: true }).count()).toBe(2);

    const screen = await captureScreen(page, { screenId: "unnamed_form", baseUrl: site.url, secrets: [] });
    const logIn = screen.locators.find((l) => l.accessibleName === "Log in" && l.kind === "button");
    expect(logIn).toBeDefined();
    expect(logIn!.disambiguatedBy).toBe("selector:form");
    expect(logIn!.python).toBe('page.locator("form").get_by_role("button", name="Log in", exact=True)');
    await page.close();
  });

  // With several forms on the screen `page.locator("form")` is ambiguous
  // itself, so each form is addressed by a stable attribute. Never by position.
  it("scopes to an individual form by a stable attribute when the screen has several", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url.replace(/\/$/, "") + "/two-forms.html");
    const screen = await captureScreen(page, { screenId: "two_forms", baseUrl: site.url, secrets: [] });
    const signIn = screen.locators.find((l) => l.accessibleName === "Sign in" && l.kind === "button");
    expect(signIn).toBeDefined();
    expect(signIn!.disambiguatedBy).toBe("selector:form[id='signin']");
    expect(signIn!.python).toBe(
      'page.locator("form[id=\'signin\']").get_by_role("button", name="Sign in", exact=True)'
    );
    expect(signIn!.python).not.toMatch(/\.(first|last|nth\()/);
    await page.close();
  });

  it("records an irreducibly duplicated text as ambiguous instead of guessing", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    expect(screen.ambiguous.some((candidate) => candidate.candidate.includes("Email"))).toBe(true);
    await page.close();
  });

  it("redacts a secret typed into the page", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await page.goto(site.url);
    // Scoped to <main>: the header carries a decoy sharing the same label, the
    // very ambiguity `resolveCandidate` resolves by region at capture time.
    await page.getByRole("main").getByRole("textbox", { name: "Password" }).fill("s3cr3t-pass");
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: ["s3cr3t-pass"] });
    expect(JSON.stringify(screen)).not.toContain("s3cr3t-pass");
    await page.close();
  });

  // A password input is not guaranteed to expose the `textbox` ARIA role
  // across every engine/Playwright version. Whichever path finds it — the
  // generic role loop or the dedicated password/label pass — it must be
  // recorded exactly once, never twice under two different locator
  // strategies for the same underlying field.
  it("captures exactly one locator for the password field, never two", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    const passwordLocators = screen.locators.filter((l) => l.accessibleName === "Password");
    expect(passwordLocators).toHaveLength(1);
  });

  it("never records two locators with the same accessible name and kind", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    const seen = new Set<string>();
    for (const locator of screen.locators) {
      const key = `${locator.kind}:${locator.accessibleName}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  // The `count: 1` guarantee is measured with `exact: true`. Playwright
  // defaults `exact` to false, so Python emitted without it is a DIFFERENT,
  // looser matcher: `get_by_text("Email")` also matches "Email address", and
  // the recorded single match becomes a strict-mode violation in pytest
  // against an application that never changed. Every emitted locator must
  // carry it, or the map stops describing what it validated.
  it("emits the same exact matching it validated with, in every locator", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    expect(screen.locators.length).toBeGreaterThan(0);
    for (const locator of screen.locators) expect(locator.python).toContain("exact=True");
    await page.close();
  });

  // The 300-character cap is about LOCATOR candidacy — prose makes a brittle
  // get_by_text — but it also gated the <p> pass, so any paragraph over it
  // disappeared from `texts` entirely. `texts` is what the follow-up plan
  // validates expected literals against, so ordinary copy became a literal the
  // plan would reject as invented, about text the application really shows.
  it("keeps a paragraph longer than the locator cap in texts, without making it a locator", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url.replace(/\/$/, "") + "/blog/first-post");
    const screen = await captureScreen(page, { screenId: "blog", baseUrl: site.url, secrets: [] });
    const long = screen.texts.find((t) => t.startsWith("Comments on this blog are moderated"));
    expect(long).toBeDefined();
    expect(long!.length).toBeGreaterThan(300);
    expect(screen.locators.some((l) => l.accessibleName === long)).toBe(false);
    await page.close();
  });

  it("collects visible text living in a span or a div, not only in a paragraph", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url.replace(/\/$/, "") + "/blog/first-post");
    const screen = await captureScreen(page, { screenId: "blog", baseUrl: site.url, secrets: [] });
    expect(screen.texts).toContain("Every post shares this layout.");
    await page.close();
  });

  // An input with an `id` and no matching <label for> is the ordinary case in
  // a single-page application, and reading its label without a count() gate
  // paid Playwright's full default timeout — measured at 30 006 ms — once per
  // field per capture. This asserts elapsed time with a generous but finite
  // bound: the point is that the lookup never BLOCKS, not that it takes any
  // particular number of milliseconds. The test timeout is far above the
  // 30s stall on purpose, so the old behaviour fails on the assertion below
  // instead of dying as an opaque vitest timeout.
  it("does not stall on an input whose id has no matching label", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const startedAt = Date.now();
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    const elapsedMs = Date.now() - startedAt;
    expect(screen.locators.some((l) => l.accessibleName === "Search orders")).toBe(true);
    expect(elapsedMs).toBeLessThan(15_000);
    await page.close();
  }, 90_000);

  // The crawler used to RECONSTRUCT a field's accessible name from attributes
  // — `aria-label`, then `innerText`, then `<label for=…>`, then the
  // placeholder — and then emit `get_by_label` whatever the name came from.
  // On a real client-rendered login that produced
  // `get_by_label("ex. alex.s@babia.io")`, which matches nothing, so both the
  // email and the password field validated at 0 and left the map: no inputs,
  // no form fields, no write actions, no login, no private area.
  describe("field naming", () => {
    const fieldsScreen = async () => {
      const page = await (await browser!.newContext()).newPage();
      await page.goto(site.url.replace(/\/$/, "") + "/fields.html");
      const screen = await captureScreen(page, { screenId: "fields", baseUrl: site.url, secrets: [] });
      return { page, screen };
    };
    const input = (screen: Awaited<ReturnType<typeof fieldsScreen>>["screen"], name: string) =>
      screen.locators.find((l) => l.kind === "input" && l.accessibleName === name);

    it("names a field from its `for`-associated label, never from its placeholder", async () => {
      const { page, screen } = await fieldsScreen();
      const email = input(screen, "Email");
      expect(email).toBeDefined();
      expect(email!.python).not.toContain("get_by_placeholder");
      await page.close();
    });

    // `element.labels` is what an attribute read cannot replace: a wrapping
    // <label> carries no `for` and the input needs no `id`, so the old chain
    // saw no label at all and named the field after its placeholder.
    it("names a field from its WRAPPING label, which carries no `for` at all", async () => {
      const { page, screen } = await fieldsScreen();
      expect(input(screen, "Password")).toBeDefined();
      expect(screen.locators.some((l) => l.accessibleName === "At least 8 characters")).toBe(false);
      expect(input(screen, "Password")!.python).not.toContain("get_by_placeholder");
      await page.close();
    });

    // The precise bug: a placeholder-derived name emitted as `get_by_label`
    // matches nothing, so the field never reached the map.
    it("keeps a placeholder-only field and never emits get_by_label for it", async () => {
      const { page, screen } = await fieldsScreen();
      const nickname = input(screen, "How should we call you?");
      expect(nickname).toBeDefined();
      expect(nickname!.python).not.toContain("get_by_label");
      await page.close();
    });

    // Every other field on the fixture resolves by role, which is preferred
    // because it is the most stable. `<input type="date">` is the measured case
    // where the role exposes no accessible name, so the placeholder matcher is
    // the one that has to ship.
    it("emits get_by_placeholder when the name came from the placeholder and no role resolves it", async () => {
      const { page, screen } = await fieldsScreen();
      expect(input(screen, "dd/mm/yyyy")?.python).toBe('page.get_by_placeholder("dd/mm/yyyy", exact=True)');
      await page.close();
    });

    it("resolves a name that lives in another element through aria-labelledby", async () => {
      const { page, screen } = await fieldsScreen();
      expect(input(screen, "Referred by")).toBeDefined();
      await page.close();
    });

    // The end of the chain the defect broke: inputs → form fields → write
    // actions. A screen whose fields never made it into the map offers a submit
    // with nothing to fill, which is how a login became unautomatable.
    it("gives the form's submit every field of that form, so the write action has something to fill", async () => {
      const { page, screen } = await fieldsScreen();
      const save = (await collectWriteActions(page, screen, [])).find((a) => a.label === "Save");
      expect(save).toBeDefined();
      expect(save!.formFields).toHaveLength(5);
      await page.close();
    });
  });

  it("warns through the event channel for every candidate it discards as ambiguous", async () => {
    const page = await (await browser!.newContext()).newPage();
    const events: AgentEvent[] = [];
    await page.goto(site.url);
    const screen = await captureScreen(page, {
      screenId: "login", baseUrl: site.url, secrets: [], emit: (event) => events.push(event),
    });
    expect(screen.ambiguous.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.status === "warn")).toHaveLength(screen.ambiguous.length);
    await page.close();
  });

});

describe.skipIf(!process.env.CI && !chromium.executablePath())("collectWriteActions", () => {
  it("keeps each submit's form fields to its own form, never the whole screen", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url.replace(/\/$/, "") + "/two-forms.html");
    const screen = await captureScreen(page, { screenId: "two_forms", baseUrl: site.url, secrets: [] });
    const actions = await collectWriteActions(page, screen, []);

    const subscribe = actions.find((a) => a.label === "Subscribe");
    const signIn = actions.find((a) => a.label === "Sign in");
    expect(signIn).toBeDefined();
    expect(subscribe).toBeDefined();

    const nameOf = (locatorName: string) => screen.locators.find((l) => l.name === locatorName)?.accessibleName;
    expect(subscribe!.formFields.map(nameOf)).toEqual(["Newsletter email"]);
    expect(signIn!.formFields.map(nameOf).sort()).toEqual(["Account email", "Password"]);
    await page.close();
  });

  // `<input type="submit">` has no innerText, so its label fell back to
  // "Enviar", the lookup by accessible name failed, and it could never be
  // registered as a write action at all. Its accessible name is its `value`.
  it("registers an input[type=submit] as a write action, named by its value", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url.replace(/\/$/, "") + "/two-forms.html");
    const screen = await captureScreen(page, { screenId: "two_forms", baseUrl: site.url, secrets: [] });
    const actions = await collectWriteActions(page, screen, []);
    expect(actions.map((a) => a.label)).toContain("Subscribe");
    await page.close();
  });

  it("redacts a secret out of a write action's label", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: ["Log in"] });
    const actions = await collectWriteActions(page, screen, ["Log in"]);
    expect(JSON.stringify(actions)).not.toContain("Log in");
    await page.close();
  });
});
