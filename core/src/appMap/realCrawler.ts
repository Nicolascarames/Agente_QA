import { chromium } from "playwright";
import type { Locator, Page } from "playwright";
import type { AmbiguousCandidate, AppMap, LocatorEntry, Screen, WriteAction } from "./schema.js";
import { screenSignature, isSuspectedLoop } from "./signature.js";
import { toUrlTemplate } from "./urlTemplate.js";
import { pythonIdentifier, uniqueName } from "./naming.js";
import { redactText } from "./redact.js";
import { elementKey } from "./elementIdentity.js";
import type { Crawler, CrawlInput, CrawlResult } from "./crawler.js";
import { MissingCrawlerToolError } from "./crawler.js";

const REGIONS = ["main", "form", "navigation", "banner", "contentinfo", "dialog"] as const;

interface CaptureContext {
  screenId: string;
  baseUrl: string;
  secrets: string[];
}

interface Candidate {
  kind: LocatorEntry["kind"];
  role: string | null;
  accessibleName: string;
  build: (scope: Locator | Page) => Locator;
  python: (scopePrefix: string) => string;
}

/**
 * Builds a Python double-quoted string literal. Backslashes and double quotes
 * are escaped so the value cannot break out of the literal; `\r`, `\n` and
 * `\t` are escaped too so an accessible name that contains a raw newline (a
 * multi-line button label, for instance) can never split the emitted string
 * across lines. `pageObjectEmitter` interpolates this output verbatim into a
 * generated Python file without parsing it, so an unescaped newline here
 * produces `SyntaxError: unterminated string literal` in the generated test
 * and makes the whole file uncollectable — proven with a real `py_compile`
 * run during the Task 6 review.
 */
export function pythonLiteral(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

async function collectCandidates(page: Page): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const roleKinds: { role: string; kind: LocatorEntry["kind"] }[] = [
    { role: "textbox", kind: "input" },
    { role: "button", kind: "button" },
    { role: "link", kind: "link" },
    { role: "combobox", kind: "select" },
    { role: "heading", kind: "heading" },
  ];

  for (const { role, kind } of roleKinds) {
    const names = new Set<string>();
    for (const handle of await page.getByRole(role as never).all()) {
      const name = (await handle.getAttribute("aria-label")) ?? (await handle.innerText().catch(() => "")) ?? "";
      const trimmed = name.trim();
      if (trimmed.length === 0 || names.has(trimmed)) continue;
      names.add(trimmed);
      candidates.push({
        kind,
        role,
        accessibleName: trimmed,
        build: (scope) => scope.getByRole(role as never, { name: trimmed, exact: true }),
        python: (prefix) => `${prefix}get_by_role(${pythonLiteral(role)}, name=${pythonLiteral(trimmed)})`,
      });
    }
  }

  // A password input is not guaranteed to expose the `textbox` role in ARIA
  // (this varies by engine/Playwright version — empirically, this build DOES
  // surface a labelled one via the role loop above, contradicting the
  // assumption this block was originally written under; see task-12-report.md).
  // This pass stays anyway: it is what covers a Playwright/browser build that
  // follows the ARIA spec literally and hides the role, and any other
  // labelled field that fails to expose a role for some other reason.
  // Without it, on such a build, no login screen would get a fill_password
  // method and the whole point of the map would be missed. These are
  // addressed by label, which is what Playwright offers for a labelled field
  // of any type.
  //
  // Dedup against the role loop by accessible name: if the role loop above
  // already produced an "input" candidate with this name, the role-based
  // locator wins and this pass must not add a second, redundant one for the
  // same field (same failure mode `mergeScreenState` guards against one
  // layer down — see Task 5 — except here the duplicate would otherwise be
  // created earlier, inside a single capture).
  const inputNamesFromRoleLoop = new Set(candidates.filter((c) => c.kind === "input").map((c) => c.accessibleName));

  for (const handle of await page.locator('input[type="password"]').all()) {
    const id = await handle.getAttribute("id");
    const label = id ? (await page.locator(`label[for="${id}"]`).innerText().catch(() => "")) : "";
    const name = (label || (await handle.getAttribute("aria-label")) || (await handle.getAttribute("placeholder")) || "").trim();
    if (name.length === 0 || inputNamesFromRoleLoop.has(name)) continue;
    candidates.push({
      kind: "input",
      role: null,
      accessibleName: name,
      build: (scope) => scope.getByLabel(name, { exact: true }),
      python: (prefix) => `${prefix}get_by_label(${pythonLiteral(name)})`,
    });
  }

  for (const text of await page.getByRole("paragraph").allInnerTexts()) {
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    candidates.push({
      kind: "text",
      role: null,
      accessibleName: trimmed,
      build: (scope) => scope.getByText(trimmed, { exact: true }),
      python: (prefix) => `${prefix}get_by_text(${pythonLiteral(trimmed)})`,
    });
  }

  return candidates;
}

/**
 * A candidate that matches more than one element is NOT discarded on the spot:
 * it is first scoped to the nearest meaningful region. The reference app has
 * "Log in" twice (header and form), so a rule that dropped every duplicate
 * would leave the screen's main element out of the map. Position (.first,
 * .nth()) is never used to disambiguate: it survives any reordering of the
 * interface without failing, which is the worst way to fail.
 */
async function resolveCandidate(
  page: Page,
  candidate: Candidate
): Promise<{ python: string; disambiguatedBy?: string } | { ambiguous: AmbiguousCandidate }> {
  const plainPython = candidate.python("page.");
  const plainCount = await candidate.build(page).count();
  if (plainCount === 1) return { python: plainPython };
  if (plainCount === 0) return { ambiguous: { candidate: plainPython, count: 2, reason: "no encontrado al validar" } };

  for (const region of REGIONS) {
    const scope = page.getByRole(region as never);
    if ((await scope.count()) !== 1) continue;
    if ((await candidate.build(scope).count()) !== 1) continue;
    return {
      python: `page.get_by_role(${pythonLiteral(region)}).${candidate.python("")}`,
      disambiguatedBy: `region:${region}`,
    };
  }

  return {
    ambiguous: {
      candidate: plainPython,
      count: plainCount,
      reason: "aparece varias veces y ninguna región lo deja en 1",
    },
  };
}

export async function captureScreen(page: Page, context: CaptureContext): Promise<Screen> {
  const ariaSnapshot = redactText(await page.locator("body").ariaSnapshot(), context.secrets);
  const verifiedAt = new Date().toISOString();
  const locators: LocatorEntry[] = [];
  const ambiguous: AmbiguousCandidate[] = [];
  const taken = new Set<string>();
  const texts: string[] = [];

  for (const candidate of await collectCandidates(page)) {
    const cleanName = redactText(candidate.accessibleName, context.secrets);
    if (!texts.includes(cleanName)) texts.push(cleanName);

    const resolved = await resolveCandidate(page, candidate);
    if ("ambiguous" in resolved) {
      ambiguous.push({ ...resolved.ambiguous, candidate: redactText(resolved.ambiguous.candidate, context.secrets) });
      continue;
    }
    const prefix = candidate.kind === "text" ? "text_" : candidate.kind === "input" ? "" : "";
    const suffix = candidate.kind === "input" ? "_input" : candidate.kind === "button" ? "_button" : "";
    const name = uniqueName(`${prefix}${pythonIdentifier(cleanName)}${suffix}`, taken);
    taken.add(name);
    locators.push({
      name,
      kind: candidate.kind,
      accessibleName: cleanName,
      python: redactText(resolved.python, context.secrets),
      count: 1,
      ...(resolved.disambiguatedBy ? { disambiguatedBy: resolved.disambiguatedBy } : {}),
      verifiedAt,
    });
  }

  const urlTemplate = toUrlTemplate(page.url(), context.baseUrl);
  return {
    id: context.screenId,
    name: context.screenId,
    className: `${pythonIdentifier(context.screenId).replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())}Page`,
    urlTemplate,
    signature: screenSignature(ariaSnapshot),
    requiresAuth: false,
    texts,
    probeValues: [],
    locators,
    states: [],
    ambiguous,
    transitions: [],
    writeActions: [],
  };
}

function matchesExcluded(urlTemplate: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return regex.test(urlTemplate);
  });
}

async function collectWriteActions(page: Page, screen: Screen): Promise<WriteAction[]> {
  const actions: WriteAction[] = [];
  for (const submit of await page.locator("form button[type=submit], form input[type=submit]").all()) {
    const label = (await submit.innerText().catch(() => "")).trim() || "Enviar";
    const locator = screen.locators.find((l) => l.accessibleName === label && l.kind === "button");
    if (!locator) continue;
    actions.push({
      locator: locator.name,
      label,
      kind: "submit",
      formFields: screen.locators.filter((l) => l.kind === "input").map((l) => l.name),
    });
  }
  return actions;
}

/**
 * The first pass walks the app breadth-first, from `baseUrl` outward, never
 * clicking the same element twice and never repeating a screen it has
 * already visited by its route template. The numeric limits in
 * `input.limits` are a safety net, not the primary stopping mechanism.
 *
 * Every screen's `id` is derived here, and only here, from its URL template:
 * Tasks 15 and 16 look it up on the resulting `Screen.id`, so a second
 * derivation anywhere else in this file would risk drifting from this one.
 */
export function createRealCrawler(): Crawler {
  return {
    async crawl(input: CrawlInput): Promise<CrawlResult> {
      const startedAt = Date.now();
      let browser;
      try {
        browser = await chromium.launch({ headless: input.headed !== true });
      } catch (err) {
        return {
          ok: false,
          error: new MissingCrawlerToolError(
            'No se pudo abrir el navegador. Ejecuta "npx playwright install chromium" e inténtalo de nuevo.'
          ).message,
        };
      }

      const context = await browser.newContext();
      const page = await context.newPage();
      const screens: Screen[] = [];
      const visitedTemplates = new Set<string>();
      const clickedElements = new Set<string>();
      const recentSignatures: string[] = [];
      const prunedTemplates = new Set<string>();
      let complete = true;

      const deadline = startedAt + input.limits.maxDurationMinutes * 60_000;
      const queue: { url: string; depth: number }[] = [{ url: input.baseUrl, depth: 0 }];

      try {
        while (queue.length > 0) {
          if (screens.length >= input.limits.maxScreens || Date.now() > deadline) {
            complete = false;
            input.emit({ agent: "explorador", status: "warn", depth: 0, message: "Límite de seguridad alcanzado, el mapa queda incompleto" });
            break;
          }

          const next = queue.shift()!;
          if (next.depth > input.limits.maxDepth) { complete = false; continue; }

          const stepStart = Date.now();
          await page.goto(next.url, { waitUntil: "domcontentloaded" });
          const template = toUrlTemplate(page.url(), input.baseUrl);
          if (visitedTemplates.has(template) || matchesExcluded(template, input.limits.excludeRoutes)) continue;
          if (prunedTemplates.has(template)) continue;
          visitedTemplates.add(template);

          const screenId = template === "/" ? "home" : pythonIdentifier(template).replace(/^_+/, "");
          const screen = await captureScreen(page, { screenId, baseUrl: input.baseUrl, secrets: secretsOf(input) });
          recentSignatures.push(screen.signature);

          if (isSuspectedLoop(recentSignatures, input.limits.loopSuspicionThreshold)) {
            const keepGoing = await input.callbacks.confirmContinueOnLoop({
              urlTemplate: template,
              repeats: input.limits.loopSuspicionThreshold,
            });
            if (!keepGoing) {
              prunedTemplates.add(template);
              input.emit({ agent: "explorador", status: "warn", depth: 1, message: `Rama podada por bucle: ${template}` });
              continue;
            }
            recentSignatures.length = 0;
          }

          screen.writeActions = await collectWriteActions(page, screen);
          screens.push(screen);
          input.emit({
            agent: "explorador", status: "ok", depth: 0,
            message: `${template} · pantalla ${screens.length}`,
            detail: `${screen.texts.length} textos · ${screen.locators.length} localizadores`,
            durationMs: Date.now() - stepStart,
          });

          // First pass: navigation only. Submits are recorded, never clicked.
          for (const locator of screen.locators.filter((l) => l.kind === "link" || l.kind === "button")) {
            if (screen.writeActions.some((action) => action.locator === locator.name)) continue;
            const key = elementKey({
              screenId: screen.id, role: locator.kind, accessibleName: locator.accessibleName ?? locator.name, index: 0,
            });
            if (clickedElements.has(key)) continue;
            clickedElements.add(key);

            await page.goto(next.url, { waitUntil: "domcontentloaded" });
            const before = page.url();
            await page.getByRole(locator.kind === "link" ? "link" : "button", {
              name: locator.accessibleName ?? "", exact: true,
            }).first().click({ timeout: 5_000 }).catch(() => undefined);
            await page.waitForLoadState("domcontentloaded").catch(() => undefined);
            const after = page.url();
            if (after === before) continue;

            const targetTemplate = toUrlTemplate(after, input.baseUrl);
            const external = !after.startsWith(input.baseUrl);
            screen.transitions.push({
              locator: locator.name,
              action: "click",
              toScreenId: external ? null : targetTemplate,
              urlChanged: true,
              ...(external ? { externalUrl: after } : {}),
            });
            if (!external && !visitedTemplates.has(targetTemplate)) queue.push({ url: after, depth: next.depth + 1 });
          }
        }
      } finally {
        await browser.close();
      }

      const map: AppMap = {
        schemaVersion: 1,
        appUrl: input.baseUrl,
        createdAt: new Date().toISOString(),
        complete,
        authenticated: false,
        screens,
        scenarios: [],
        stats: {
          screens: screens.length,
          locators: screens.reduce((sum, s) => sum + s.locators.length, 0),
          ambiguous: screens.reduce((sum, s) => sum + s.ambiguous.length, 0),
          durationMs: Date.now() - startedAt,
        },
      };
      return { ok: true, map };
    },
  };
}

function secretsOf(input: CrawlInput): string[] {
  return input.credentials ? [input.credentials.username, input.credentials.password] : [];
}
