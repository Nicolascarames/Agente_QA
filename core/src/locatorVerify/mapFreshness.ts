import type { AppMap, LocatorEntry } from "../appMap/schema.js";
import { SCREEN_TAG } from "../appMap/schema.js";
import { findScreen } from "../appMap/mapQuery.js";
import { toSelfPageExpression } from "../appMap/pythonExpression.js";
import type { LocatorCheck, LocatorVerifier, ExplorationCredentials } from "./locatorVerifier.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

export interface UsedLocator {
  screenId: string;
  screenName: string;
  locator: LocatorEntry;
  /** The screen's route template, carried along so `checkMapFreshness` can build `urls` without needing the map again. */
  urlTemplate: string;
  /** Carried from `Screen.requiresAuth` so `checkMapFreshness` can be honest about what it could not verify — see the warning it builds below. */
  requiresAuth: boolean;
}

export type MapFreshnessResult =
  | { ok: true; warnings?: string }
  | { ok: false; stale: { screenId: string; name: string; count: number }[] };

export interface AmbiguousStep {
  screenId: string;
  screenName: string;
  quoted: string;
  candidates: LocatorEntry[];
}

export interface UsedLocatorsResult {
  used: UsedLocator[];
  ambiguous: AmbiguousStep[];
}

/**
 * A `fill` step's second quoted group is test DATA the tester invented (an
 * email, a password) — never app copy, same rule `checkFeatureLiterals`
 * applies. Only the first quoted group (the field name) is a UI literal.
 * The `the test username`/`the test password` forms carry no second quoted
 * group — valid credentials come from `.env`, never a literal — and still
 * match here so the field still gets revalidated in a real browser and still
 * takes part in ambiguity detection below.
 */
const FILL_STEP = /I fill "([^"]*)" with (?:"([^"]*)"|the test (?:username|password))/;
const CLICK_STEP = /I click "([^"]*)"/;

/**
 * Every locator a scenario names, resolved against the map screen its
 * `@screen:` tag declares. This is the SMALL set of locators worth
 * revalidating in a real browser before code generation — not the whole map.
 */
export function locatorsUsedBy(featureText: string, map: AppMap): UsedLocatorsResult {
  const used: UsedLocator[] = [];
  const ambiguous: AmbiguousStep[] = [];
  const seen = new Set<string>();
  const asked = new Set<string>();
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

    const byAccessibleName = screen.locators.filter((l) => l.accessibleName === name);
    if (byAccessibleName.length > 1) {
      // Taking the first match here is how a login scenario ends up clicking
      // the button that does not submit. The caller has to decide, so report
      // it: once per (screen, quoted text), because every step quoting the
      // same text on the same screen means the same element.
      const key = `${currentScreenId}::${name}`;
      if (asked.has(key)) continue;
      asked.add(key);
      ambiguous.push({
        screenId: currentScreenId,
        screenName: screen.name,
        quoted: name,
        candidates: byAccessibleName,
      });
      continue;
    }

    const locator = byAccessibleName[0] ?? screen.locators.find((l) => l.name === name);
    if (!locator) continue;

    const key = `${currentScreenId}::${locator.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    used.push({
      screenId: currentScreenId,
      screenName: screen.name,
      locator,
      urlTemplate: screen.urlTemplate,
      requiresAuth: screen.requiresAuth,
    });
  }

  return { used, ambiguous };
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

/**
 * Index of the locator `name`'s OWN failure segment in `errors` — not merely
 * a substring of a longer locator's name. `uniqueName()` (appMap/naming.ts)
 * produces sibling names like `submit` and `submit_2`, or `submit` and
 * `form_submit`, and a plain substring test would let `submit` match inside
 * `get_submit_2(...)` or `get_form_submit(...)`.
 *
 * A right-boundary check alone (next character not a word character) is not
 * enough: `submit` inside `form_submit` is immediately followed by `(` in
 * `get_form_submit(`, which passes a right-only check. A symmetric left+right
 * boundary check doesn't work either — the real match point is always
 * `get_<name>(`, whose preceding character is `_`, a word character, so
 * requiring a non-word character on the left would reject every genuine
 * match too. The only expression that is actually specific to `name` is the
 * verifier's own check method call, `get_${name}(` — searched for as a whole
 * literal string, not `name` alone. Returns -1 when no such occurrence exists.
 */
function indexOfLocatorName(errors: string, name: string): number {
  return errors.indexOf(`get_${name}(`);
}

/** Extracts the "resolvió a N elementos" count for one locator's segment of the verifier's error text; 0 when the failure text carries no count (e.g. an exception). */
function staleCountFor(errors: string, locatorName: string): number {
  const idx = indexOfLocatorName(errors, locatorName);
  if (idx === -1) return 0;
  const tail = errors.slice(idx);
  const boundary = tail.indexOf("\n\n");
  const segment = boundary === -1 ? tail : tail.slice(0, boundary);
  const match = segment.match(/resolvió a (\d+) elementos/);
  return match ? Number(match[1]) : 0;
}

/**
 * The generated Python this check runs only exports `credentials` as
 * environment variables and then does `goto` + `count` — it never actually
 * logs in. A screen behind auth therefore renders the login form during this
 * check: every locator legitimately counts 0 (a WARNING per the rule above,
 * never a failure), and the result reads as a bare `ok: true` indistinguishable
 * from a screen that was genuinely verified. This does not implement a login
 * flow — it only makes the result honest by naming, in Spanish, every
 * auth-required screen among `used` that this check could not really verify.
 */
function authWarningFor(used: UsedLocator[]): string | undefined {
  const screens = new Map<string, string>();
  for (const entry of used) {
    if (entry.requiresAuth && !screens.has(entry.screenId)) screens.set(entry.screenId, entry.screenName);
  }
  if (screens.size === 0) return undefined;

  const names = Array.from(screens.values()).map((name) => `"${name}"`).join(", ");
  const plural = screens.size > 1;
  return `No se ${plural ? "han" : "ha"} podido verificar de verdad ${plural ? "las pantallas" : "la pantalla"} ${names}: ${
    plural ? "requieren" : "requiere"
  } sesión iniciada y este chequeo no la inicia, así que sus localizadores pueden estar contando sobre el formulario de login en vez de sobre la pantalla real.`;
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

  // Same detection `pageObjectEmitter.ts`'s `pageObjectMethodNames`/`emitPageObject`
  // use for a parameterised route (":" — see appMap/urlTemplate.ts's VARIABLE):
  // a screen behind `/item/:id` has no single concrete URL to visit, so it
  // falls back to baseUrl rather than requesting a literal, non-navigable URL.
  const urls = Array.from(
    new Set(
      used.map((entry) =>
        entry.urlTemplate.includes(":") ? baseUrl : resolveUrl(baseUrl, entry.urlTemplate)
      )
    )
  );

  const result = await verifier.verify([file], checks, urls, credentials);

  if (result.ok) {
    const authWarning = authWarningFor(used);
    const warnings = [result.warnings, authWarning].filter((w): w is string => Boolean(w)).join("\n\n");
    return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
  }

  const errors = result.errors ?? "";
  const byName = new Map<string, UsedLocator>();
  for (const entry of used) {
    if (!byName.has(entry.locator.name)) byName.set(entry.locator.name, entry);
  }

  const stale: { screenId: string; name: string; count: number }[] = [];
  for (const [name, entry] of byName) {
    if (indexOfLocatorName(errors, name) === -1) continue;
    stale.push({ screenId: entry.screenId, name, count: staleCountFor(errors, name) });
  }

  return { ok: false, stale };
}
