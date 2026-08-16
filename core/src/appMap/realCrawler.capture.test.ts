import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { captureScreen, pythonLiteral } from "./realCrawler.js";

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
    await page.getByRole("textbox", { name: "Password" }).fill("s3cr3t-pass");
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: ["s3cr3t-pass"] });
    expect(JSON.stringify(screen)).not.toContain("s3cr3t-pass");
    await page.close();
  });
});
