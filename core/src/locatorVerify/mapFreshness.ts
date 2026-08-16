import type { AppMap, LocatorEntry } from "../appMap/schema.js";
import { findScreen } from "../appMap/mapQuery.js";
import type { LocatorCheck, LocatorVerifier } from "./locatorVerifier.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { ExplorationCredentials } from "../siteExplorer/siteExplorer.js";

export interface UsedLocator {
  screenId: string;
  locator: LocatorEntry;
  /** The screen's route template, carried along so `checkMapFreshness` can build `urls` without needing the map again. */
  urlTemplate: string;
}

export type MapFreshnessResult =
  | { ok: true; warnings?: string }
  | { ok: false; stale: { screenId: string; name: string; count: number }[] };

const SCREEN_TAG = /@screen:([\p{L}\p{N}_-]+)/u;

/**
 * A `fill` step's second quoted group is test DATA the tester invented (an
 * email, a password) — never app copy, same rule `checkFeatureLiterals`
 * applies. Only the first quoted group (the field name) is a UI literal.
 */
const FILL_STEP = /I fill "([^"]*)" with "([^"]*)"/;
const CLICK_STEP = /I click "([^"]*)"/;

/**
 * Every locator a scenario names, resolved against the map screen its
 * `@screen:` tag declares. This is the SMALL set of locators worth
 * revalidating in a real browser before code generation — not the whole map.
 */
export function locatorsUsedBy(featureText: string, map: AppMap): UsedLocator[] {
  const used: UsedLocator[] = [];
  const seen = new Set<string>();
  let currentScreenId: string | null = null;

  for (const rawLine of featureText.split(/\r?\n/)) {
    const line = rawLine.trim();

    const tag = line.match(SCREEN_TAG);
    if (tag) {
      currentScreenId = tag[1];
      continue;
    }
    if (/^Feature:/i.test(line)) {
      currentScreenId = null;
      continue;
    }
    if (currentScreenId === null) continue;

    const fillMatch = line.match(FILL_STEP);
    const name = fillMatch ? fillMatch[1] : line.match(CLICK_STEP)?.[1];
    if (!name) continue;

    const screen = findScreen(map, currentScreenId);
    if (!screen) continue;

    const locator =
      screen.locators.find((l) => l.accessibleName === name) ??
      screen.locators.find((l) => l.name === name);
    if (!locator) continue;

    const key = `${currentScreenId}::${locator.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    used.push({ screenId: currentScreenId, locator, urlTemplate: screen.urlTemplate });
  }

  return used;
}

/** `page.get_by_role(...)` -> `self.page.get_by_role(...)`, letter for letter beyond that. */
function toSelfPageExpression(python: string): string {
  return python.startsWith("page.") ? `self.page.${python.slice("page.".length)}` : python;
}

const PAGE_OBJECT_PATH = "pages/map_freshness.py";

/**
 * Synthesizes a throwaway Page Object for the existing `LocatorVerifier`,
 * which resolves each check by calling a method on an instantiated Page
 * Object (`getattr(instance, check["method"])(check["argument"])`) — this
 * task cannot touch that shared script, so it must speak its protocol.
 * One `get_<name>` method per DISTINCT locator name, returning the map's
 * `python` expression unchanged apart from the `self.page` rewrite.
 */
function buildPageObject(used: UsedLocator[]): { file: GeneratedFile; checks: LocatorCheck[] } {
  const byName = new Map<string, UsedLocator>();
  for (const entry of used) {
    if (!byName.has(entry.locator.name)) byName.set(entry.locator.name, entry);
  }

  const checks: LocatorCheck[] = [];
  const methods: string[] = [];
  for (const [name, entry] of byName) {
    const method = `get_${name}`;
    checks.push({ method, argument: "" });
    methods.push(
      `    def ${method}(self, _arg=None):\n        return ${toSelfPageExpression(entry.locator.python)}\n`
    );
  }

  const content = `class MapFreshnessCheck:\n    def __init__(self, page):\n        self.page = page\n\n${methods.join("\n")}`;

  return { file: { path: PAGE_OBJECT_PATH, content }, checks };
}

/** `os.environ["AGENTE_QA_APP_URL"].rstrip("/") + URL_TEMPLATE`, the same rule the generated Page Objects use to navigate. */
function resolveUrl(baseUrl: string, urlTemplate: string): string {
  return baseUrl.replace(/\/+$/, "") + urlTemplate;
}

/** Extracts the "resolvió a N elementos" count for one locator's segment of the verifier's error text; 0 when the failure text carries no count (e.g. an exception). */
function staleCountFor(errors: string, locatorName: string): number {
  const idx = errors.indexOf(locatorName);
  if (idx === -1) return 0;
  const tail = errors.slice(idx);
  const boundary = tail.indexOf("\n\n");
  const segment = boundary === -1 ? tail : tail.slice(0, boundary);
  const match = segment.match(/resolvió a (\d+) elementos/);
  return match ? Number(match[1]) : 0;
}

/**
 * Revalidates, in a real browser, only the locators a Gherkin scenario
 * actually uses — never the whole map — so a scenario built from a map that
 * has drifted from the live app is caught here with a clear message instead
 * of producing a test that only fails later in pytest.
 *
 * `count === 0` is a WARNING from the underlying verifier, never a failure:
 * an element that only appears after an action legitimately counts 0 on a
 * clean navigation. Only `ok: false` produces stale locators.
 */
export async function checkMapFreshness(
  used: UsedLocator[],
  verifier: LocatorVerifier,
  baseUrl: string,
  credentials: ExplorationCredentials | undefined
): Promise<MapFreshnessResult> {
  if (used.length === 0) return { ok: true };

  const { file, checks } = buildPageObject(used);

  const urls = Array.from(
    new Set(
      used.map((entry) =>
        entry.urlTemplate.includes("{") ? baseUrl : resolveUrl(baseUrl, entry.urlTemplate)
      )
    )
  );

  const result = await verifier.verify([file], checks, urls, credentials);

  if (result.ok) {
    return result.warnings === undefined ? { ok: true } : { ok: true, warnings: result.warnings };
  }

  const errors = result.errors ?? "";
  const byName = new Map<string, UsedLocator>();
  for (const entry of used) {
    if (!byName.has(entry.locator.name)) byName.set(entry.locator.name, entry);
  }

  const stale: { screenId: string; name: string; count: number }[] = [];
  for (const [name, entry] of byName) {
    if (!errors.includes(name)) continue;
    stale.push({ screenId: entry.screenId, name, count: staleCountFor(errors, name) });
  }

  return { ok: false, stale };
}
