import { chromium } from "playwright";
import type { Browser, Locator, Page } from "playwright";
import type { EmitEvent } from "../events/agentEvent.js";
import type { AmbiguousCandidate, AppMap, LocatorEntry, Screen, WriteAction } from "./schema.js";
import { screenSignature, isSuspectedLoop } from "./signature.js";
import { toUrlTemplate, siblingTemplate, matchesTemplate } from "./urlTemplate.js";
import { disambiguatedName, pythonIdentifier, uniqueName } from "./naming.js";
import { pythonLiteral } from "./pythonLiteral.js";
import { redactText } from "./redact.js";
import { elementKey, mergeScreenState } from "./elementIdentity.js";
import type { Crawler, CrawlCredentials, CrawlInput, CrawlResult } from "./crawler.js";
import { MissingCrawlerToolError } from "./crawler.js";
import { PASSWORD_NAME, looksLikeEmailField, hasPasswordField } from "./credentialFields.js";

export { pythonLiteral } from "./pythonLiteral.js";

const REGIONS = ["main", "form", "navigation", "banner", "contentinfo", "dialog"] as const;

/**
 * The `form` ARIA landmark above only matches a `<form>` that HAS an accessible
 * name: an unnamed `<form>` — the overwhelmingly common case, and what a real
 * login application turned out to have — exposes no `form` role at all, so
 * `getByRole("form")` answered 0 and the one scope that could have separated
 * that application's duplicates was never really tried. Measured there: "Log
 * in", "Sign up" and "Welcome back" each matched twice with both copies
 * visible, and the login button itself was therefore missing from the Page
 * Object. These CSS scopes reach the same element the landmark cannot see.
 */
const FORM_SELECTOR = "form";

/** Fields the crawler treats as fillable form inputs, everywhere in this file. */
const FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])';

/**
 * Logging out mid-crawl would kill the session the whole authenticated pass
 * depends on, so a control with one of these names is never clicked during the
 * walk — the spec classifies it as a write action, not as navigation.
 */
const LOGOUT_NAME = /log\s*-?\s*out|logout|sign\s*-?\s*out|cerrar\s+sesi[oó]n|desconectar/i;

/**
 * The same control, recognised by where it GOES rather than by what it is
 * called. A link labelled "Exit", "Salir" or an icon with no text at all still
 * ends the session if it points at /logout, and the name test cannot see that.
 */
const LOGOUT_PATH = /(^|\/)(log-?out|sign-?out|cerrar-sesi[oó]n|desconectar)(\/|$)/i;

/**
 * A single text node long enough to be a paragraph is copy, not a locator
 * target: `get_by_text` on 400 characters of prose is a brittle assertion
 * nobody wants in a Page Object.
 *
 * This is a cap on LOCATOR CANDIDACY only, never on capture. It used to gate
 * the `<p>` pass as well, so a paragraph over 300 characters vanished from
 * `screen.texts` altogether — and `texts` is exactly what the follow-up plan
 * validates expected literals against, so ordinary copy (a terms-and-
 * conditions line, an empty-state explanation, a long error message) silently
 * became a literal the plan would reject as invented.
 */
const MAX_TEXT_CANDIDATE_LENGTH = 300;

/**
 * The ceiling on what enters `texts` at all. Far above ordinary copy, and
 * present only so a pathological node — a minified blob in a stray `<div>` —
 * cannot dump kilobytes into every map.
 */
const MAX_TEXT_CAPTURE_LENGTH = 5_000;

/**
 * Reading an attribute or the text of an element the crawler ALREADY holds a
 * handle for is a memory lookup, not an interaction: it either answers at once
 * or the element is gone. Playwright's 30s default belongs to actions that wait
 * for an application to settle, and paying it per read is what turned one
 * missing `<label for>` into 30 006 ms of dead time — three times per screen on
 * an ordinary single-page application, until `maxDurationMinutes` truncated the
 * map. Every read in this file carries this bound instead.
 */
const SHORT_READ_TIMEOUT_MS = 2_000;

interface CaptureContext {
  screenId: string;
  baseUrl: string;
  secrets: string[];
  /** Optional so tests can capture a screen without wiring an event channel. */
  emit?: EmitEvent;
}

/**
 * One way of addressing an element: the Playwright locator that gets validated
 * live, and the Python that ships, built from the very same matcher.
 */
interface LocatorForm {
  build: (scope: Locator | Page) => Locator;
  python: (scopePrefix: string) => string;
}

interface Candidate {
  kind: LocatorEntry["kind"];
  accessibleName: string;
  /**
   * Every way this element may be addressed, most stable first. The FIRST form
   * that validates to exactly one element is the one recorded — which is what
   * keeps the emitted matcher tied to the source the name came from: a field
   * named after its placeholder carries a `get_by_placeholder` form and never
   * a `get_by_label` one, because `get_by_label` does not match placeholders.
   */
  forms: LocatorForm[];
  /** Copy too long to be worth a locator: recorded in `texts`, never validated. */
  textOnly?: boolean;
}

/**
 * `exact: true` is not a detail of the validation, it is part of the locator.
 * Playwright defaults `exact` to false, which makes `get_by_text` and
 * `get_by_label` substring AND case-insensitive matches and `get_by_role`'s
 * name case-insensitive. Validating with `exact: true` and emitting Python
 * without it would measure the `count: 1` guarantee with a strictly stricter
 * matcher than the one that ships: a screen with `<p>Email</p>` and
 * `<p>Email address</p>` records a locator that resolves to one element here
 * and to two in pytest, against an application that never changed. Both sides
 * of every candidate below must therefore carry `exact`.
 */
function exactRolePython(role: string, name: string): (prefix: string) => string {
  return (prefix) => `${prefix}get_by_role(${pythonLiteral(role)}, name=${pythonLiteral(name)}, exact=True)`;
}

function roleForm(role: string, name: string): LocatorForm {
  return {
    build: (scope) => scope.getByRole(role as never, { name, exact: true }),
    python: exactRolePython(role, name),
  };
}

function labelForm(name: string): LocatorForm {
  return {
    build: (scope) => scope.getByLabel(name, { exact: true }),
    python: (prefix) => `${prefix}get_by_label(${pythonLiteral(name)}, exact=True)`,
  };
}

function placeholderForm(name: string): LocatorForm {
  return {
    build: (scope) => scope.getByPlaceholder(name, { exact: true }),
    python: (prefix) => `${prefix}get_by_placeholder(${pythonLiteral(name)}, exact=True)`,
  };
}

function textForm(text: string): LocatorForm {
  return {
    build: (scope) => scope.getByText(text, { exact: true }),
    python: (prefix) => `${prefix}get_by_text(${pythonLiteral(text)}, exact=True)`,
  };
}

/**
 * Name of an interactive control, in the same priority order Playwright uses
 * to compute an accessible name for the cases this crawler meets. `value` is
 * only consulted for buttons: on an `<input type="submit">` it IS the
 * accessible name, while on a text input it is the field's content and would
 * name the field after whatever happens to be typed in it.
 */
async function controlName(handle: Locator, options: { useValue: boolean }): Promise<string> {
  const aria = (await attribute(handle, "aria-label")).trim();
  if (aria.length > 0) return aria;
  const inner = (await handle.innerText({ timeout: SHORT_READ_TIMEOUT_MS }).catch(() => "")).trim();
  if (inner.length > 0) return inner;
  if (!options.useValue) return "";
  return (await attribute(handle, "value")).trim();
}

/** One bounded attribute read, used everywhere this file reads an attribute. */
async function attribute(handle: Locator, name: string): Promise<string> {
  return (await handle.getAttribute(name, { timeout: SHORT_READ_TIMEOUT_MS }).catch(() => null)) ?? "";
}

/**
 * Attributes allowed to say what an element IS, never how it looks: a class is
 * rewritten by any restyle without a single behavioural change, and under
 * utility CSS it is not even unique, so a locator built on one fails for
 * reasons that have nothing to do with the application. `class` and `style`
 * must never appear here.
 */
const SEMANTIC_ATTRIBUTES = ["type", "name", "id", "role", "data-testid"] as const;

/**
 * Every semantic attribute the element carries, read through the same bounded
 * `attribute()` helper every other read in this file uses — a second,
 * unbounded way to read an attribute is exactly what once cost a measured 30s
 * per field.
 */
async function semanticAttributes(handle: Locator): Promise<Record<string, string> | undefined> {
  const found: Record<string, string> = {};
  for (const name of SEMANTIC_ATTRIBUTES) {
    const value = (await attribute(handle, name)).trim();
    if (value.length > 0) found[name] = value;
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

/** Where a field's name came from. It decides which matcher may be emitted for it. */
type NameSource = "label" | "aria" | "labelledby" | "placeholder";

interface FieldNaming {
  name: string;
  source: NameSource;
  /** The ARIA role the control exposes, or "" when it exposes none worth a role locator. */
  role: string;
  /** Every name the field could be recorded under, most specific first. */
  names: string[];
}

/**
 * The name a form field really answers to, ASKED OF THE DOM in one round trip
 * instead of reconstructed from attributes, together with the source it came
 * from.
 *
 * `element.labels` is the whole reason this is an `evaluate`: it resolves a
 * WRAPPING `<label>Email <input …></label>` — which carries no `for` and needs
 * no `id` — exactly as it resolves a `for`-associated one. Attribute-sniffing
 * saw neither, so on a real client-rendered login the chain fell through to the
 * placeholder, the field was named after it, and the name that shipped was the
 * hint text rather than the label the user reads.
 *
 * The source travels with the name because `get_by_label` does NOT match
 * placeholders: naming a field from its placeholder and emitting `get_by_label`
 * produces a locator that validates at 0 matches, and both fields of a login
 * form vanished from the map that way — no inputs, therefore no form fields, no
 * write actions and no login at all.
 *
 * One `evaluate` also removes the stall the old `label[for=…]` lookup could
 * cost: reading the DOM inside the page never waits for an element to appear.
 */
async function fieldNaming(handle: Locator): Promise<FieldNaming | null> {
  const raw = await handle
    .evaluate((element) => {
      const control = element as HTMLInputElement;
      const labels = control.labels;
      const type = (control.getAttribute("type") ?? "text").toLowerCase();
      return {
        label: labels !== null && labels !== undefined && labels.length > 0 ? (labels[0].textContent ?? "") : "",
        aria: control.getAttribute("aria-label") ?? "",
        labelledby: (control.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .filter((id) => id.length > 0)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
        placeholder: control.getAttribute("placeholder") ?? "",
        role:
          element.tagName === "TEXTAREA"
            ? "textbox"
            : type === "search"
              ? "searchbox"
              : type === "number"
                ? "spinbutton"
                : ["", "text", "email", "password", "tel", "url"].includes(type)
                  ? "textbox"
                  : "",
      };
    }, undefined, { timeout: SHORT_READ_TIMEOUT_MS })
    .catch(() => null);
  if (raw === null) return null;

  const sources: { source: NameSource; value: string }[] = (
    [
      ["label", raw.label],
      ["aria", raw.aria],
      ["labelledby", raw.labelledby],
      ["placeholder", raw.placeholder],
    ] as [NameSource, string][]
  ).map(([source, value]) => ({ source, value: value.replace(/\s+/g, " ").trim() }));

  const primary = sources.find((entry) => entry.value.length > 0);
  if (primary === undefined) return null;
  return {
    name: primary.value,
    source: primary.source,
    role: raw.role,
    names: Array.from(new Set(sources.map((entry) => entry.value).filter((value) => value.length > 0))),
  };
}

/** Every name a form field could be recorded under, most specific first. */
async function fieldNames(handle: Locator): Promise<string[]> {
  return (await fieldNaming(handle))?.names ?? [];
}

/**
 * How a field may be addressed, most stable first.
 *
 * The role form leads because a role+name locator is the one that survives a
 * refactor of the markup — but it is only ever RECORDED if it validates to
 * exactly one element, so a field whose role exposes no accessible name (an
 * `<input type="date">` named by its placeholder, measured against Chromium)
 * falls through to the matcher for the source its name really came from. There
 * is deliberately no path from a placeholder-derived name to `get_by_label`.
 */
function fieldForms(naming: FieldNaming): LocatorForm[] {
  const forms: LocatorForm[] = [];
  if (naming.role.length > 0) forms.push(roleForm(naming.role, naming.name));
  forms.push(naming.source === "placeholder" ? placeholderForm(naming.name) : labelForm(naming.name));
  return forms;
}

/**
 * Visible text that lives outside `<p>` and outside any element with an
 * accessible name — `<span>`, `<div>`, `<li>`, `<td>`… In a typical SPA that is
 * where most of the copy is, and a map missing it makes the follow-up plan's
 * literal check reject correct test plans for texts the application really
 * shows. Only leaf elements are read, so a container never contributes the
 * concatenation of everything below it; interactive tags and headings are
 * skipped because the role pass above already names them.
 */
async function leafTexts(page: Page): Promise<string[]> {
  return page.evaluate((maxCaptureLength: number) => {
    const skip = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "IFRAME", "SVG", "PATH",
      "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "LABEL",
      "H1", "H2", "H3", "H4", "H5", "H6",
    ]);
    const found: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll("*"))) {
      if (skip.has(element.tagName)) continue;
      if (element.children.length > 0) continue;
      const text = (element.textContent ?? "").trim();
      if (text.length === 0 || text.length > maxCaptureLength) continue;
      const candidate = element as HTMLElement & { checkVisibility?: () => boolean };
      const visible =
        typeof candidate.checkVisibility === "function"
          ? candidate.checkVisibility()
          : candidate.offsetParent !== null;
      if (!visible) continue;
      found.push(text);
    }
    return found;
  }, MAX_TEXT_CAPTURE_LENGTH);
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
      const trimmed = await controlName(handle, { useValue: role === "button" });
      if (trimmed.length === 0 || names.has(trimmed)) continue;
      names.add(trimmed);
      candidates.push({ kind, accessibleName: trimmed, forms: [roleForm(role, trimmed)] });
    }
  }

  // The role loop above names a candidate from `aria-label`, `innerText` or —
  // for buttons only — `value`. An <input> never has `innerText` (it has no
  // text content, labelled or not) and rarely carries `aria-label`, so EVERY
  // plain form field — email, text, password alike — comes out of that loop
  // with an empty name and gets dropped there, `textbox` role or no `textbox`
  // role. Confirmed empirically against this fixture: both the email and the
  // password field match `getByRole("textbox")`, and both report
  // `innerText: ""`. This pass asks the DOM for their real name instead —
  // wrapping label, `for`-associated label, `aria-label`, `aria-labelledby` or
  // placeholder, in that order — and emits the matcher that fits whichever of
  // those the name came from. Without it, no login screen would get a fillable
  // input at all and the whole point of the map would be missed.
  //
  // Dedup against the role loop by accessible name: if the role loop above
  // already produced an "input" candidate with this name, the role-based
  // locator wins and this pass must not add a second, redundant one for the
  // same field (same failure mode `mergeScreenState` guards against one
  // layer down — see Task 5 — except here the duplicate would otherwise be
  // created earlier, inside a single capture).
  const inputNamesFromRoleLoop = new Set(candidates.filter((c) => c.kind === "input").map((c) => c.accessibleName));

  for (const handle of await page.locator(FIELD_SELECTOR).all()) {
    const naming = await fieldNaming(handle);
    if (naming === null || inputNamesFromRoleLoop.has(naming.name)) continue;
    inputNamesFromRoleLoop.add(naming.name);
    candidates.push({ kind: "input", accessibleName: naming.name, forms: fieldForms(naming) });
  }

  const seenTexts = new Set<string>();
  const paragraphs = await page.getByRole("paragraph").allInnerTexts();
  for (const text of [...paragraphs, ...(await leafTexts(page))]) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_CAPTURE_LENGTH || seenTexts.has(trimmed)) continue;
    seenTexts.add(trimmed);
    candidates.push({
      kind: "text",
      accessibleName: trimmed,
      forms: [textForm(trimmed)],
      // Over the cap it is copy, not a target: it still belongs in `texts`,
      // which is what expected literals are checked against, but validating a
      // locator for it would put 400 characters of prose in a Page Object.
      textOnly: trimmed.length > MAX_TEXT_CANDIDATE_LENGTH,
    });
  }

  return candidates;
}

/**
 * A container a duplicated candidate can be narrowed to. `id` is what lands in
 * `disambiguatedBy`, and it is the whole scope: `scopedBy` rebuilds the very
 * same container from it later, so the walk and the write pass interact with
 * exactly the element the map recorded.
 */
interface Scope {
  id: string;
  locator: Locator;
  pythonPrefix: string;
}

/** A CSS attribute selector value, safe to sit inside single quotes. */
function cssValue(value: string): string {
  return value.replace(/['\\]/g, "\\$&");
}

/**
 * Attributes allowed to separate two elements no container can, most
 * intentional first. Each one says what the element IS: a `data-testid` is a
 * contract written for tests, a `name` is the key the form submits the value
 * under, a `type` is the control's own behaviour. That is precisely what makes
 * them admissible where position is not — if one of them disappears the test
 * SHOULD break, whereas `.first()`/`.nth()` survives any reordering of the
 * interface without ever failing, which is the worst way to fail.
 *
 * A class is deliberately absent: it describes how the element LOOKS, a restyle
 * rewrites it without changing anything the user can do, and under utility CSS
 * it is not even unique. So is any positional pseudo-class, for the same reason.
 */
const NARROWING_ATTRIBUTES = ["data-testid", "name", "type"];

/**
 * Values that identify nothing durable: a content hash or a CSS-module suffix,
 * a framework-issued id (React's `useId` renders `:r3:`, different on the next
 * render), a bare counter, a name that is really an index. Narrowing by one of
 * these READS as semantic and BEHAVES like position — it breaks on the next
 * deploy without the interface having changed at all.
 *
 * Rejecting one is always the safe direction: the candidate simply falls
 * through to `ambiguous`, which is this crawler's honest answer, instead of
 * entering the map as a locator that will rot.
 */
const GENERATED_VALUE_PATTERNS = [
  /[0-9a-f]{8,}/i,
  /^:[a-z0-9]+:$/i,
  /^\d+$/,
  /^[a-z]+[_-]?\d{3,}$/i,
];

/** Above this, a value is a payload rather than a name. */
const MAX_NARROWING_VALUE_LENGTH = 40;

/**
 * What `disambiguatedBy` prefixes an attribute condition with, alongside the
 * `region:` and `selector:` a scope uses. Everything after it is the CSS
 * condition itself, so `narrowedBy` rebuilds exactly what was validated.
 */
const ATTRIBUTE_PREFIX = "attribute:";

function isStableAttributeValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_NARROWING_VALUE_LENGTH) return false;
  return !GENERATED_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Every scope that resolves to exactly one element on this screen, in the order
 * they are tried: the ARIA landmarks first — a named region is the most
 * meaningful container an application can declare — then the CSS ones, from the
 * least specific to the most.
 *
 * The form scopes exist because `getByRole("form")` cannot see an unnamed
 * `<form>`. `page.locator("form")` fires when the screen has exactly one form;
 * when it has several, each is addressed by a STABLE ATTRIBUTE, never by
 * position — `.nth()` would resolve today and quietly point at another form the
 * day one is added above it.
 *
 * Computed once per capture rather than per candidate: the DOM does not change
 * underneath a capture, and this used to cost six `count()` round trips for
 * every ambiguous candidate on the screen.
 */
async function singleMatchScopes(page: Page): Promise<Scope[]> {
  const selectors = [FORM_SELECTOR];
  for (const { id, name } of await page.evaluate((selector: string) =>
    Array.from(document.querySelectorAll(selector)).map((form) => ({
      id: form.getAttribute("id") ?? "",
      name: form.getAttribute("name") ?? "",
    })), FORM_SELECTOR
  )) {
    if (id.length > 0) selectors.push(`${FORM_SELECTOR}[id='${cssValue(id)}']`);
    else if (name.length > 0) selectors.push(`${FORM_SELECTOR}[name='${cssValue(name)}']`);
  }

  const candidates: Scope[] = [
    ...REGIONS.map((region) => ({
      id: `region:${region}`,
      locator: page.getByRole(region as never),
      pythonPrefix: `page.get_by_role(${pythonLiteral(region)}).`,
    })),
    ...selectors.map((selector) => ({
      id: `selector:${selector}`,
      locator: page.locator(selector),
      pythonPrefix: `page.locator(${pythonLiteral(selector)}).`,
    })),
  ];

  const scopes: Scope[] = [];
  for (const scope of candidates) {
    if ((await scope.locator.count().catch(() => 0)) === 1) scopes.push(scope);
  }
  return scopes;
}

/**
 * One CSS attribute condition per element this form matches — the most
 * intentional attribute that singles that element out from its twins, or
 * nothing when no allowed attribute does.
 *
 * Read in ONE `evaluateAll` round trip, from the DOM the form already matched,
 * so the elements compared are exactly the ones that made the candidate
 * ambiguous. Uniqueness is judged WITHIN that matched set, which is the only
 * set that matters: `type='submit'` is shared by every form on a big screen and
 * still separates these two siblings perfectly.
 *
 * At most one condition per element, first attribute in `NARROWING_ATTRIBUTES`
 * order wins. Without that, an element carrying both a `data-testid` and a
 * `type` would come back twice, be recorded under two names, and the map would
 * claim the screen has two of a control it has one of.
 */
async function attributeNarrowings(page: Page, form: LocatorForm): Promise<string[]> {
  const rows = await form
    .build(page)
    .evaluateAll(
      (elements, names: string[]) => elements.map((element) => names.map((name) => element.getAttribute(name) ?? "")),
      NARROWING_ATTRIBUTES
    )
    .catch(() => [] as string[][]);

  const byElement = new Map<number, string>();
  NARROWING_ATTRIBUTES.forEach((name, column) => {
    const values = rows.map((row) => row[column] ?? "");
    values.forEach((value, element) => {
      if (byElement.has(element) || !isStableAttributeValue(value)) return;
      if (values.filter((other) => other === value).length !== 1) return;
      byElement.set(element, `[${name}='${cssValue(value)}']`);
    });
  });

  return rows.map((_row, element) => byElement.get(element)).filter((selector): selector is string => selector !== undefined);
}

/** One validated way of addressing an element, plus what narrowed it, if anything. */
interface Resolution {
  python: string;
  disambiguatedBy?: string;
  /** The very locator that was validated at count 1, reused to read its semantic attributes. */
  handle: Locator;
}

/**
 * The same candidate, split into one resolution per element an ATTRIBUTE can
 * separate. Each is validated live at exactly one match, like every other
 * candidate, and on the very expression that ships: `and()` here, `and_()`
 * there, the same two matchers composed the same way. Validating a stricter (or
 * merely different) expression than the one emitted is how this project already
 * shipped a Critical once.
 */
async function attributeResolutions(page: Page, form: LocatorForm): Promise<Resolution[]> {
  const resolutions: Resolution[] = [];
  for (const selector of await attributeNarrowings(page, form)) {
    const handle = form.build(page).and(page.locator(selector));
    if ((await handle.count().catch(() => 0)) !== 1) continue;
    resolutions.push({
      python: `${form.python("page.")}.and_(page.locator(${pythonLiteral(selector)}))`,
      disambiguatedBy: `${ATTRIBUTE_PREFIX}${selector}`,
      handle,
    });
  }
  return resolutions;
}

/**
 * A candidate that matches more than one element is NOT discarded on the spot:
 * it is first scoped to the nearest meaningful container. The reference app has
 * "Log in" twice (header and form), so a rule that dropped every duplicate
 * would leave the screen's main element out of the map.
 *
 * When no container separates them, an attribute of the elements themselves is
 * tried before giving up. Measured on the real target application, the tab that
 * switches panel and the submit that actually logs in are SIBLINGS inside the
 * same unnamed `<form>` — `form > div > button[type=button]` and
 * `form > button[type=submit]` — sharing every ancestor there is. No scope can
 * ever split those, so the login button was absent from the map, the app
 * yielded zero write actions, and the one flow this tool exists to automate
 * could not be tested at all. `type` separates them, and an attribute is the
 * opposite kind of thing from position: it describes what the element IS, and
 * if it disappears the test SHOULD break.
 *
 * Position (.first, .last, .nth()) is never used, at any stage: it survives any
 * reordering of the interface without failing, which is the worst way to fail.
 */
async function resolveCandidate(
  page: Page,
  candidate: Candidate,
  scopes: Scope[]
): Promise<{ resolutions: Resolution[] } | { ambiguous: AmbiguousCandidate }> {
  let reportedPython = candidate.forms[0].python("page.");
  let reportedCount = -1;

  for (const form of candidate.forms) {
    const plainHandle = form.build(page);
    const plainCount = await plainHandle.count().catch(() => 0);
    if (plainCount === 1) return { resolutions: [{ python: form.python("page."), handle: plainHandle }] };
    if (reportedCount < 0) {
      reportedCount = plainCount;
      reportedPython = form.python("page.");
    }
    // Nothing to scope down: this way of addressing the element does not reach
    // it at all, so the next form gets its turn.
    if (plainCount === 0) continue;

    for (const scope of scopes) {
      const scopedHandle = form.build(scope.locator);
      if ((await scopedHandle.count().catch(() => 0)) !== 1) continue;
      return {
        resolutions: [{ python: `${scope.pythonPrefix}${form.python("")}`, disambiguatedBy: scope.id, handle: scopedHandle }],
      };
    }

    // Last resort before discarding: an attribute of the elements themselves.
    // Every element it separates is recorded — a tab and a submit sharing a
    // name are two real controls, and keeping only one of them would leave the
    // map lying about the screen.
    const narrowed = await attributeResolutions(page, form);
    if (narrowed.length > 0) return { resolutions: narrowed };

    // A form that matched several elements is the more informative report: it
    // says the element IS there and could not be pinned down, which is a
    // different problem from a matcher that never reached it.
    reportedCount = plainCount;
    reportedPython = form.python("page.");
  }

  return {
    ambiguous: {
      candidate: reportedPython,
      count: Math.max(reportedCount, 0),
      reason: reportedCount > 1 ? "aparece varias veces y ningún ámbito lo deja en 1" : "no encontrado al validar",
    },
  };
}

export async function captureScreen(page: Page, context: CaptureContext): Promise<Screen> {
  // `domcontentloaded` alone is not enough for a client-rendered app — the
  // primary target of this whole feature: content mounted afterwards is not
  // there yet when the role queries below run, producing a thin or empty
  // screen. `networkidle` with NO timeout is a known trap in this project (see
  // core/src/locatorVerify/buildVerificationScript.ts): it hangs up to
  // Playwright's 30s default on any app with a websocket, a chat widget or an
  // analytics beacon that never goes quiet, with no recognisable failure
  // signature. A short explicit timeout, swallowed on failure, costs a chatty
  // app a moment instead of stalling the whole crawl.
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);

  const ariaSnapshot = redactText(await page.locator("body").ariaSnapshot(), context.secrets);
  const verifiedAt = new Date().toISOString();
  const locators: LocatorEntry[] = [];
  const ambiguous: AmbiguousCandidate[] = [];
  const taken = new Set<string>();
  const texts: string[] = [];
  const scopes = await singleMatchScopes(page);

  for (const candidate of await collectCandidates(page)) {
    const cleanName = redactText(candidate.accessibleName, context.secrets);
    if (!texts.includes(cleanName)) texts.push(cleanName);
    // Captured, deliberately not validated: it is copy, and it is already in
    // `texts` above, which is the only thing this pass owed it.
    if (candidate.textOnly === true) continue;

    const resolved = await resolveCandidate(page, candidate, scopes);
    if ("ambiguous" in resolved) {
      const entry = { ...resolved.ambiguous, candidate: redactText(resolved.ambiguous.candidate, context.secrets) };
      ambiguous.push(entry);
      // The spec asks for this discard to be visible: a locator silently
      // missing from the Page Object is indistinguishable from one the crawler
      // never saw.
      context.emit?.({
        agent: "explorador", status: "warn", depth: 1,
        message: `${entry.candidate} → ${entry.reason} (${entry.count} coincidencias), queda fuera del Page Object`,
      });
      continue;
    }
    const prefix = candidate.kind === "text" ? "text_" : "";
    const suffix = candidate.kind === "input" ? "_input" : candidate.kind === "button" ? "_button" : "";
    // Usually one. Several when an attribute separated twins that share an
    // accessible name, in which case they also share the identifier the name
    // normalises to — and `disambiguatedName` is exactly the helper that
    // already settles that, naming the second after what distinguishes it
    // (`log_in_button_submit`) instead of after a counter that would encode
    // crawl order and silently move when the app changes.
    for (const resolution of resolved.resolutions) {
      const base = `${prefix}${pythonIdentifier(cleanName)}${suffix}`;
      const name = disambiguatedName(base, resolution.disambiguatedBy, resolution.python, taken);
      taken.add(name);
      const rawAttributes = await semanticAttributes(resolution.handle);
      // Every string that reaches a Screen passes through the capture's
      // redaction, attribute values included: a credential leaked into a
      // `value` or `name` attribute must not survive into the map either.
      const attributes = rawAttributes
        ? Object.fromEntries(
            Object.entries(rawAttributes).map(([key, value]) => [key, redactText(value, context.secrets)])
          )
        : undefined;
      locators.push({
        name,
        kind: candidate.kind,
        accessibleName: cleanName,
        python: redactText(resolution.python, context.secrets),
        count: 1,
        ...(resolution.disambiguatedBy ? { disambiguatedBy: resolution.disambiguatedBy } : {}),
        ...(attributes ? { attributes } : {}),
        verifiedAt,
      });
    }
  }

  const urlTemplate = toUrlTemplate(page.url(), context.baseUrl);
  return {
    ...screenIdentity(context.screenId),
    urlTemplate,
    signature: screenSignature(ariaSnapshot),
    // Always public at capture time. Whether a screen really needs a session
    // is decided afterwards, by `derivePrivateScreens`, from a context that
    // holds no session — the walk itself cannot tell.
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

/**
 * The screen's fingerprint as it stands right now, without paying for a full
 * capture. Used to ask the one question a click raises on a client-rendered
 * application — "did the view change?" — before deciding whether a capture is
 * worth running at all, so a click that does nothing costs one aria snapshot
 * instead of a whole screen capture.
 *
 * The `networkidle` wait matches the one `captureScreen` opens with, or a view
 * still mounting would read as a different state and then as the same one a
 * moment later. Bounded and swallowed, for the reasons documented there.
 */
async function currentSignature(page: Page, secrets: string[]): Promise<string | null> {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  const snapshot = await page.locator("body").ariaSnapshot({ timeout: SHORT_READ_TIMEOUT_MS }).catch(() => "");
  return snapshot.length > 0 ? screenSignature(redactText(snapshot, secrets)) : null;
}

/** `id`, `name` and `className` all derive from the same slug, in one place. */
export function screenIdentity(screenId: string): { id: string; name: string; className: string } {
  const pythonSafeSlug = screenId.replace(/~/g, "_");
  return {
    id: screenId,
    name: screenId,
    className: `${pythonIdentifier(pythonSafeSlug).replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())}Page`,
  };
}

function matchesExcluded(urlTemplate: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return regex.test(urlTemplate);
  });
}

/**
 * Only the ORIGIN of `appUrl` is walked. String prefixes cannot decide this:
 * with `baseUrl = "https://example.com"` (no trailing slash, perfectly legal
 * config), `https://example.com.evil.test/panel` starts with the base URL and
 * would be crawled as if it were part of the application.
 *
 * Module-private on purpose: it was exported alongside a `resolveScreenUrl`
 * that no longer exists — nothing outside this file ever imported either, and
 * an export with no importer is a promise to callers who are not there.
 */
function isExternalUrl(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin !== new URL(baseUrl).origin;
  } catch {
    return true;
  }
}

/**
 * The write actions of a screen are the submit buttons it contains, each with
 * the fields OF ITS OWN FORM — not every input on the screen. A screen with a
 * login form and a newsletter form would otherwise make approving the
 * newsletter submit fill the password field with the real credential and post
 * it, and would make every submit on that screen look like a login.
 */
/**
 * Which of the recorded entries for this label is the SUBMIT one.
 *
 * While a duplicated name could only ever produce one entry, the first match
 * was necessarily the right one. Attribute narrowing changed that: a tab and a
 * submit sharing a name are now both in the map, in DOM order, so taking the
 * first would hang the write action on the tab — it would fill the form and
 * then click the control that only switches panel, and the login would never be
 * exercised. Decided by asking the page, not by reading `disambiguatedBy`: the
 * question is "does this recorded locator address a submit?", and the recorded
 * locator itself is what answers it.
 */
async function submitEntry(page: Page, screen: Screen, label: string): Promise<LocatorEntry | undefined> {
  const candidates = screen.locators.filter((l) => l.accessibleName === label && l.kind === "button");
  if (candidates.length <= 1) return candidates[0];
  for (const candidate of candidates) {
    const target = narrowedBy(
      page,
      scopedBy(page, candidate).getByRole("button", { name: label, exact: true }),
      candidate
    );
    const isSubmit = await target.and(page.locator(SUBMIT_SELECTOR)).count().catch(() => 0);
    if (isSubmit === 1) return candidate;
  }
  return candidates[0];
}

/** Every control that submits a form, used both to find them and to recognise one. */
const SUBMIT_SELECTOR = "form button[type=submit], form input[type=submit]";

export async function collectWriteActions(page: Page, screen: Screen, secrets: string[]): Promise<WriteAction[]> {
  const actions: WriteAction[] = [];
  for (const submit of await page.locator(SUBMIT_SELECTOR).all()) {
    // `<input type="submit">` has no innerText at all: without the `value`
    // fallback its label was always "Enviar", the lookup by accessible name
    // below always failed, and such a button could never become a write action.
    const rawLabel = await controlName(submit, { useValue: true });
    const label = redactText(rawLabel.length > 0 ? rawLabel : "Enviar", secrets);
    const locator = await submitEntry(page, screen, label);
    if (!locator) continue;

    const form = await formOf(page, submit);
    const namesInForm = new Set<string>();
    if (form !== null) {
      for (const field of await form.locator(FIELD_SELECTOR).all()) {
        for (const name of await fieldNames(field)) namesInForm.add(redactText(name, secrets));
      }
    }

    actions.push({
      locator: locator.name,
      label,
      kind: "submit",
      formFields: screen.locators
        .filter((l) => l.kind === "input" && l.accessibleName !== undefined && namesInForm.has(l.accessibleName))
        .map((l) => l.name),
    });
  }
  return actions;
}

/** The form a submit button belongs to: its `form` attribute wins, else its nearest ancestor. */
async function formOf(page: Page, submit: Locator): Promise<Locator | null> {
  const formId = await submit.getAttribute("form").catch(() => null);
  if (formId !== null && formId.trim().length > 0) {
    const byAttribute = page.locator(`form[id="${formId}"]`);
    if ((await byAttribute.count().catch(() => 0)) === 1) return byAttribute;
  }
  const ancestor = submit.locator("xpath=ancestor::form[1]");
  return (await ancestor.count().catch(() => 0)) === 1 ? ancestor : null;
}

const INVALID_EMAIL = "agente-qa-probe@example.invalid";
const INVALID_PASSWORD = "agente-qa-invalid-password";

function valueFor(fieldName: string, data: "valid" | "invalid", credentials?: CrawlCredentials): string {
  const looksLikeEmail = looksLikeEmailField(fieldName);
  const looksLikePassword = PASSWORD_NAME.test(fieldName);
  if (data === "invalid") return looksLikeEmail ? INVALID_EMAIL : looksLikePassword ? INVALID_PASSWORD : "";
  if (looksLikeEmail) return credentials?.username ?? "agente-qa@example.test";
  if (looksLikePassword) return credentials?.password ?? "agente-qa-valid-password";
  return "agente-qa";
}

/**
 * The container `resolveCandidate` already validated this locator in, rebuilt
 * from what it recorded — an ARIA landmark or a CSS scope, the same two kinds
 * `singleMatchScopes` offers. Anything the crawler interacts with goes through
 * here, so it acts on exactly the element the emitted Python addresses.
 *
 * An attribute narrowing is NOT a container — it is a condition on the element
 * itself — so it falls through to the page here and is applied by `narrowedBy`
 * on the built locator instead. The two are complementary, never alternatives:
 * every interaction site applies both.
 */
function scopedBy(page: Page, entry: { disambiguatedBy?: string } | undefined): Locator | Page {
  const value = entry?.disambiguatedBy;
  if (value === undefined) return page;
  if (value.startsWith("region:")) return page.getByRole(value.slice("region:".length) as never);
  if (value.startsWith("selector:")) return page.locator(value.slice("selector:".length));
  return page;
}

/**
 * The attribute condition `resolveCandidate` validated this locator with, if
 * there was one, re-applied to a freshly built locator. `and()` here mirrors
 * the `and_()` the emitted Python carries, so the crawler goes on interacting
 * with the same single element the Page Object will address — without it, a tab
 * and a submit sharing a name are two matches again and the interaction is
 * skipped as ambiguous.
 */
function narrowedBy(page: Page, target: Locator, entry: { disambiguatedBy?: string } | undefined): Locator {
  const value = entry?.disambiguatedBy;
  if (value === undefined || !value.startsWith(ATTRIBUTE_PREFIX)) return target;
  return target.and(page.locator(value.slice(ATTRIBUTE_PREFIX.length)));
}

/**
 * The field, addressed the same ways capture is allowed to address it and in
 * the same order of preference. Re-resolving by label alone was fine while
 * every recorded field WAS a label match; now that a field may legitimately be
 * recorded by its role or by its placeholder, a label-only lookup answers 0 for
 * it, the field is skipped, and the "valid" submit that follows never
 * authenticates — the same silent-empty-field failure that made a login look
 * like the application's fault.
 *
 * Returns the first form that resolves to exactly one element, or the worst
 * count seen so the caller can say what it found instead.
 */
async function fieldTarget(
  scope: Locator | Page,
  name: string,
  narrow: (target: Locator) => Locator = (target) => target
): Promise<{ target: Locator | null; matches: number }> {
  let worst = 0;
  for (const form of [
    scope.getByRole("textbox", { name, exact: true }),
    scope.getByLabel(name, { exact: true }),
    scope.getByPlaceholder(name, { exact: true }),
  ]) {
    // Narrowed BEFORE counting, or a field recorded through an attribute
    // condition counts its twin too and the fill is skipped as ambiguous.
    const candidate = narrow(form);
    const matches = await candidate.count().catch(() => 0);
    if (matches === 1) return { target: candidate, matches: 1 };
    worst = Math.max(worst, matches);
  }
  return { target: null, matches: worst };
}

/**
 * Fills a form with the SAME scope every other resolver in this file uses: the
 * region `resolveCandidate` recorded at capture time. Re-resolving the field
 * unscoped is how a Password field disambiguated to `region:main` ends up
 * matching twice, violating strict mode, getting swallowed and leaving the
 * field empty — after which the "valid" submit never authenticates and the
 * failure looks like the application's. The value is only recorded in
 * `probeValues` once the fill actually succeeded: recording it up front claims
 * the crawler typed a password it never typed.
 */
async function fillFormFields(
  page: Page,
  screen: Screen,
  action: WriteAction,
  data: "valid" | "invalid",
  credentials: CrawlCredentials | undefined,
  emit: EmitEvent
): Promise<string[]> {
  const typed: string[] = [];
  for (const fieldName of action.formFields) {
    const field = screen.locators.find((l) => l.name === fieldName);
    if (field?.accessibleName === undefined) continue;
    const value = valueFor(field.accessibleName, data, credentials);
    const { target, matches } = await fieldTarget(scopedBy(page, field), field.accessibleName, (candidate) =>
      narrowedBy(page, candidate, field)
    );
    if (target === null) {
      emit({
        agent: "explorador", status: "warn", depth: 1,
        message: `El campo "${field.accessibleName}" ya no resuelve a un único elemento al rellenarlo (${matches} coincidencias), se omite`,
      });
      continue;
    }
    const filled = await target.fill(value, { timeout: 5_000 }).then(() => true, () => false);
    if (!filled) {
      emit({
        agent: "explorador", status: "warn", depth: 1,
        message: `No se pudo escribir en el campo "${field.accessibleName}", se omite`,
      });
      continue;
    }
    typed.push(value);
  }
  return typed;
}

/**
 * Reuse the SAME scope `resolveCandidate` already validated at capture time,
 * instead of re-resolving the label unscoped and taking `.last()`. `.last()`
 * picks by DOM position — it only worked on the fixture because the decoy
 * button in the header happens to precede the form's submit button in DOM
 * order, which is luck, not correctness.
 */
async function clickWriteAction(page: Page, screen: Screen, action: WriteAction, emit: EmitEvent): Promise<boolean> {
  const submitLocator = screen.locators.find((l) => l.name === action.locator);
  const target = narrowedBy(
    page,
    scopedBy(page, submitLocator).getByRole("button", { name: action.label, exact: true }),
    submitLocator
  );
  const matches = await target.count().catch(() => 0);
  if (matches !== 1) {
    // Still ambiguous even scoped (or the scope disappeared since capture):
    // guessing positionally is worse than skipping.
    emit({
      agent: "explorador", status: "warn", depth: 1,
      message: `"${action.label}" ya no resuelve a un único elemento al enviar (${matches} coincidencias), se omite`,
    });
    return false;
  }
  await target.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  return true;
}

/**
 * Logs in for real before the walk starts, so the crawl covers the private
 * area of the application instead of stopping at its login screen — the
 * credentials in `.env` exist for exactly this. Uses the same region-aware
 * fill and submit the write pass uses, and reports success only when the
 * submit actually navigated away. On any failure the caller carries on with
 * the public surface and the map stays `authenticated: false`.
 *
 * The login screen's signature comes back with the answer: it is what lets the
 * `requiresAuth` derivation recognise a screen that answers a session-less
 * request by rendering the login form in place of its own content.
 */
interface LoginOutcome {
  authenticated: boolean;
  loginSignature: string | null;
}

async function attemptLogin(page: Page, input: CrawlInput, emit: EmitEvent, secrets: string[]): Promise<LoginOutcome> {
  if (input.credentials === undefined) return { authenticated: false, loginSignature: null };
  try {
    await page.goto(input.baseUrl, { waitUntil: "domcontentloaded" });
  } catch {
    emit({ agent: "explorador", status: "warn", depth: 1, message: `No se pudo cargar ${input.baseUrl} para iniciar sesión` });
    return { authenticated: false, loginSignature: null };
  }

  const entry = await captureScreen(page, { screenId: "login", baseUrl: input.baseUrl, secrets });
  const action = (await collectWriteActions(page, entry, secrets)).find((a) => hasPasswordField(entry, a));
  if (action === undefined) {
    emit({ agent: "explorador", status: "info", depth: 1, message: "No se encontró formulario de login en la pantalla inicial, se mapea solo la parte pública" });
    return { authenticated: false, loginSignature: null };
  }

  const before = page.url();
  await fillFormFields(page, entry, action, "valid", input.credentials, emit);
  if (!(await clickWriteAction(page, entry, action, emit))) {
    return { authenticated: false, loginSignature: entry.signature };
  }

  const authenticated = page.url() !== before;
  emit(
    authenticated
      ? { agent: "explorador", status: "ok", depth: 1, message: `Sesión iniciada, el mapa cubrirá la zona privada → ${page.url()}` }
      : { agent: "explorador", status: "warn", depth: 1, message: "El login no cambió de pantalla, se mapea solo la parte pública" }
  );
  return { authenticated, loginSignature: entry.signature };
}

/**
 * `requiresAuth` is a property of the SCREEN, not of the crawl. Deriving it
 * from the single `authenticated` flag marked the login screen, the
 * password-reset screen and every public listing as private — and consumers
 * read this flag to decide whether a generated test needs a logged-in fixture,
 * so a credentialed crawl would have wrapped a login around every test,
 * including the test for the login screen itself. The spec's own example map
 * shows the login screen as `requiresAuth: false`.
 *
 * Derived here instead, after the walk, from a context that holds no session
 * at all: a screen is private when, asked for without credentials, it
 * redirects somewhere else, answers with a non-OK status, or renders the login
 * screen in place of its own content — the single-page-application case, where
 * nothing redirects and the status stays 200.
 *
 * Signature EQUALITY against the walk's own capture is deliberately NOT the
 * test. A public page almost always renders differently once logged in — the
 * header alone says "Log out" where it said "Log in" — so "the signature
 * changed" would mark every public page private and recreate this very defect
 * through another door. Only the LOGIN screen's signature is compared, which
 * is the one comparison that means what it says.
 */
async function derivePrivateScreens(
  browser: Browser,
  screens: Screen[],
  concreteUrls: Map<Screen, string>,
  loginSignature: string | null,
  input: CrawlInput,
  secrets: string[],
  emit: EmitEvent
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    for (const screen of screens) {
      const url = concreteUrls.get(screen);
      if (url === undefined) continue;

      let status: number;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded" });
        status = response?.status() ?? 200;
      } catch {
        // Cannot tell without a session: leave the screen public rather than
        // invent a flag a generated test would then obey.
        continue;
      }
      // Bounded, and swallowed: a client-side redirect needs a moment, a chatty
      // app never goes quiet, and the redirect check only needs the final URL.
      await page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => undefined);

      const redirected = toUrlTemplate(page.url(), input.baseUrl) !== toUrlTemplate(url, input.baseUrl);
      const rejected = status === 401 || status === 403;
      const isLoginScreen = loginSignature !== null && screen.signature === loginSignature;
      let showsLoginInstead = false;
      if (!redirected && !rejected && loginSignature !== null && !isLoginScreen) {
        const snapshot = await page
          .locator("body")
          .ariaSnapshot({ timeout: SHORT_READ_TIMEOUT_MS })
          .catch(() => "");
        showsLoginInstead =
          snapshot.length > 0 && screenSignature(redactText(snapshot, secrets)) === loginSignature;
      }

      screen.requiresAuth = redirected || rejected || showsLoginInstead;
      if (screen.requiresAuth) {
        emit({
          agent: "explorador", status: "info", depth: 1,
          message: `${screen.urlTemplate} necesita sesión: sin credenciales no se muestra`,
        });
      }
    }
  } finally {
    await context.close();
  }
}

/**
 * Every approved write action runs TWICE, with different data, because the two
 * outcomes are different screens and both are needed. Without the invalid
 * variant the map would not contain the app's error messages at all — those
 * texts do not exist until somebody submits the form wrong, and that is exactly
 * the literal that was missing when a generated test invented
 * get_by_role("alert").
 *
 * Returns true when a valid submit of an action that includes a password-like
 * field navigated away from its screen — that is what logging in looks like
 * from here, and `crawl` uses it to set `AppMap.authenticated`.
 */
async function runWritePass(
  page: Page,
  screens: Screen[],
  approved: { screenId: string; locator: string }[],
  concreteUrls: Map<Screen, string>,
  input: CrawlInput,
  emit: EmitEvent
): Promise<boolean> {
  const secrets = secretsOf(input);
  let authenticated = false;
  for (const { screenId, locator: locatorName } of approved) {
    const index = screens.findIndex((s) => s.id === screenId);
    if (index < 0) continue;
    const screen = screens[index];
    const action = screen.writeActions.find((a) => a.locator === locatorName);
    if (!action) continue;

    const isLoginAction = hasPasswordField(screen, action);

    // The concrete URL the walk really captured this screen at — never a URL
    // rebuilt from the route template. A template with a variable segment is
    // not addressable: `/item/:id` is not a URL, and asking the server for that
    // literal path is the same defect already fixed in the Page Object emitter.
    // Rebuilding is not merely wrong for templated screens either — it was
    // string concatenation against a base URL that may carry no trailing slash,
    // which is how "https://example.com" + "/reset" became
    // "https://example.comreset".
    const url = concreteUrls.get(screen);
    if (url === undefined) {
      emit({
        agent: "explorador", status: "warn", depth: 1,
        message: `No se conoce la URL concreta de ${screen.urlTemplate}, no se prueba "${action.label}"`,
      });
      continue;
    }

    for (const data of ["invalid", "valid"] as const) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch {
        // A dead link or a reset connection here must not reject `crawl()`:
        // every caller relies on it resolving `{ ok: false, error }` at
        // worst, never throwing. Guarded the same way the walk's own `goto`
        // calls are above: emit a warning and skip this write action.
        emit({
          agent: "explorador", status: "warn", depth: 1,
          message: `No se pudo cargar ${screen.urlTemplate} antes de probar "${action.label}", se omite`,
        });
        continue;
      }

      const probeValues = await fillFormFields(page, screen, action, data, input.credentials, emit);

      const before = page.url();
      if (!(await clickWriteAction(page, screen, action, emit))) continue;

      if (page.url() !== before) {
        // A successful submit navigates: that destination is an ordinary screen
        // and was, or will be, captured by the walk. Nothing to merge here.
        if (data === "valid") {
          emit({ agent: "explorador", status: "ok", depth: 1, message: `Envío válido de "${action.label}" → ${page.url()}` });
          if (isLoginAction) authenticated = true;
        }
        continue;
      }

      const after = await captureScreen(page, { screenId: screen.id, baseUrl: input.baseUrl, secrets });
      // Merged IN PLACE. `screens`, `concreteUrls` and `absorbedBy` all hold
      // this exact object; swapping in the fresh one `mergeScreenState`
      // returns would silently orphan every lookup keyed on its identity.
      Object.assign(
        screen,
        mergeScreenState(screen, {
          id: `${data}-submit-${action.locator}`,
          reachedBy: { action: "submit", locator: action.locator, data },
          texts: after.texts.filter((t) => !probeValues.includes(t)),
          locators: after.locators.filter((l) => !screen.locators.some((existing) => existing.python === l.python)),
        }),
        { probeValues: Array.from(new Set([...screen.probeValues, ...probeValues])) }
      );
      emit({
        agent: "explorador", status: "ok", depth: 1,
        message: `Envío ${data === "invalid" ? "inválido" : "válido"} de "${action.label}"`,
        detail: `${screen.states.at(-1)?.addsTexts.length ?? 0} textos nuevos`,
      });
    }
  }
  return authenticated;
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

      // One redacting wrapper, used for EVERY event this file emits. The event
      // channel is a third consumer of the same data the two redaction nets
      // (capture, and the pass before writing the map) already protect, and it
      // reaches the terminal, CI logs and any future surface: a form that
      // submits by GET puts `?email=…&password=…` straight into `page.url()`,
      // and a reset link found during the crawl carries its token in the URL.
      const secrets = secretsOf(input);
      const emit: EmitEvent = (event) =>
        input.emit({
          ...event,
          message: redactText(event.message, secrets),
          ...(event.detail !== undefined ? { detail: redactText(event.detail, secrets) } : {}),
        });

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

      const screens: Screen[] = [];
      const visitedTemplates = new Set<string>();
      const clickedElements = new Set<string>();
      const assignedScreenIds = new Set<string>();
      const recentSignatures: string[] = [];
      const prunedTemplates = new Set<string>();
      // Every concrete route that ended up represented by another screen, and
      // the screen that absorbed it. Transitions are recorded during the walk
      // against the template the browser had at hand (`/blog/first-post`), but
      // the screen that answers for it may since have been renamed to
      // `/blog/:id` — without this the resolution below found nothing and the
      // transition came back `toScreenId: null`, which every consumer reads as
      // "leaves the application". The value is the Screen object, not its id:
      // a collapse rewrites the id in place, and holding the reference means
      // the lookup always reads the current one.
      const absorbedBy = new Map<string, Screen>();
      // The concrete URL each screen was really captured at. A route template
      // is not addressable — `/item/:id` is not a URL — so anything that needs
      // to request a screen again later (the session-less `requiresAuth`
      // derivation, the write pass) reads it from here instead of rebuilding
      // one from the template.
      const concreteUrls = new Map<Screen, string>();
      let complete = true;
      let authenticated = false;
      let loginSignature: string | null = null;

      const deadline = startedAt + input.limits.maxDurationMinutes * 60_000;
      const queue: { url: string; depth: number }[] = [{ url: input.baseUrl, depth: 0 }];

      try {
        // `newContext`/`newPage` run inside the guarded region on purpose: the
        // browser was already launched above, and only the `finally` below
        // closes it. Creating the context and page before this `try` would
        // leak a running browser process if either of those calls threw.
        const context = await browser.newContext();
        const page = await context.newPage();

        // Log in BEFORE the walk, so the walk runs inside the session and the
        // map covers the private area. The screen the login lands on is queued
        // as a second entry point: nothing on the public surface links to it.
        const login = await attemptLogin(page, input, emit, secrets);
        authenticated = login.authenticated;
        loginSignature = login.loginSignature;
        if (authenticated) {
          const landed = page.url();
          if (toUrlTemplate(landed, input.baseUrl) !== toUrlTemplate(input.baseUrl, input.baseUrl)) {
            queue.push({ url: landed, depth: 0 });
          }
        }

        while (queue.length > 0) {
          if (screens.length >= input.limits.maxScreens || Date.now() > deadline) {
            complete = false;
            emit({ agent: "explorador", status: "warn", depth: 0, message: "Límite de seguridad alcanzado, el mapa queda incompleto" });
            break;
          }

          const next = queue.shift()!;
          if (next.depth > input.limits.maxDepth) { complete = false; continue; }

          // Excluded BEFORE navigating. A safety net whose whole promise is
          // "do not go there" — admin areas, endpoints with side effects on
          // load — fails that promise if the request is made and only the
          // capture is thrown away. The post-navigation check below stays, to
          // catch a redirect into an excluded route.
          if (matchesExcluded(toUrlTemplate(next.url, input.baseUrl), input.limits.excludeRoutes)) continue;

          const stepStart = Date.now();
          try {
            await page.goto(next.url, { waitUntil: "domcontentloaded" });
          } catch {
            // A dead link, a DNS failure or a reset connection must not
            // reject `crawl()` — every caller relies on it resolving
            // `{ ok: false, error }` at worst, never throwing.
            complete = false;
            emit({ agent: "explorador", status: "warn", depth: next.depth, message: `No se pudo cargar ${next.url}, se omite` });
            continue;
          }
          const template = toUrlTemplate(page.url(), input.baseUrl);
          if (visitedTemplates.has(template) || matchesExcluded(template, input.limits.excludeRoutes)) continue;
          if (prunedTemplates.has(template)) continue;
          visitedTemplates.add(template);

          // Two different routes can normalize to the same identifier
          // (`/order-history` and `/order/history` both collapse to
          // `order_history`): route it through `uniqueName`, the same helper
          // that already keeps locator names unique within a screen, but
          // against a set scoped to the whole crawl. Without this, one
          // screen's Page Object would silently overwrite another's in the
          // generated suite and a screen present in map.json would vanish
          // from the generated tests.
          const rawScreenId = template === "/" ? "home" : pythonIdentifier(template).replace(/^_+/, "");
          const screenId = uniqueName(rawScreenId, assignedScreenIds);
          assignedScreenIds.add(screenId);
          // No `requiresAuth` here: the walk cannot know whether a screen it
          // reached inside a session would also have rendered without one.
          // Every screen starts public and `derivePrivateScreens` flips the
          // ones that really need a session, after the walk.
          const screen = await captureScreen(page, { screenId, baseUrl: input.baseUrl, secrets, emit });
          concreteUrls.set(screen, page.url());

          // Third templating rule of the spec: two sibling URLs that differ in
          // exactly one segment are the same screen with different data. The
          // signature decides — /settings/profile and /settings/billing are
          // siblings by shape but different screens, and their accessibility
          // trees say so. Without this rule a catalogue or a blog explodes into
          // hundreds of screens and hundreds of committed Page Objects, with
          // `maxScreens` as the only brake.
          // Third and later siblings. The first pair already collapsed into a
          // template, and `siblingTemplate` deliberately refuses a side that
          // carries `:id`, so from here on only a pattern match can recognise
          // the same screen. The signature still decides, exactly as it does
          // for the first pair: shape alone would let `/settings/:id` swallow
          // any route of that shape.
          const absorbing = screens.find(
            (s) => s.signature === screen.signature && matchesTemplate(s.urlTemplate, template)
          );
          if (absorbing !== undefined) {
            absorbedBy.set(template, absorbing);
            emit({
              agent: "explorador", status: "info", depth: 0,
              message: `${template} ya está representada por ${absorbing.urlTemplate}, no se añade otra pantalla`,
            });
            continue;
          }

          const sibling = screens.find(
            (s) => s.signature === screen.signature && siblingTemplate(s.urlTemplate, template) !== null
          );
          if (sibling !== undefined) {
            const previous = sibling.urlTemplate;
            const collapsed = siblingTemplate(previous, template)!;
            visitedTemplates.add(collapsed);
            const collapsedId = uniqueName(pythonIdentifier(collapsed).replace(/^_+/, ""), assignedScreenIds);
            assignedScreenIds.add(collapsedId);
            Object.assign(sibling, screenIdentity(collapsedId), { urlTemplate: collapsed });
            // Both concrete routes now answer to the collapsed screen: the one
            // just visited AND the one that was already in the map under its
            // own name, which transitions recorded earlier still point at.
            absorbedBy.set(previous, sibling);
            absorbedBy.set(template, sibling);
            emit({
              agent: "explorador", status: "info", depth: 0,
              message: `${template} es la misma pantalla que ${previous} con otros datos, se unifican en ${collapsed}`,
            });
            continue;
          }

          recentSignatures.push(screen.signature);

          if (isSuspectedLoop(recentSignatures, input.limits.loopSuspicionThreshold)) {
            const keepGoing = await input.callbacks.confirmContinueOnLoop({
              urlTemplate: template,
              repeats: input.limits.loopSuspicionThreshold,
            });
            if (!keepGoing) {
              prunedTemplates.add(template);
              emit({ agent: "explorador", status: "warn", depth: 1, message: `Rama podada por bucle: ${template}` });
              continue;
            }
            recentSignatures.length = 0;
          }

          screen.writeActions = await collectWriteActions(page, screen, secrets);
          screens.push(screen);
          emit({
            agent: "explorador", status: "ok", depth: 0,
            message: `${template} · pantalla ${screens.length}`,
            detail: `${screen.texts.length} textos · ${screen.locators.length} localizadores`,
            durationMs: Date.now() - stepStart,
          });

          // Every fingerprint this screen already accounts for: its base
          // capture, plus every state recorded from it below. A click that
          // lands on one of them added nothing, and recording it again is how
          // two controls that open the same panel would each get their own
          // state — and how a control that toggles a panel open and shut would
          // grow one per click.
          const knownSignatures = new Set<string>([screen.signature]);

          // Which of the screen's same-named twins each entry is. Until
          // attribute narrowing, a duplicated accessible name produced at most
          // one entry, so index 0 identified it. Now a tab and a submit sharing
          // a name are both recorded, and a key built from the name alone would
          // read the second as already clicked and never explore where it goes.
          // Derived from the screen's own locator list, so every element that
          // has no twin keeps index 0 and behaves exactly as before.
          const twinIndex = new Map<string, number>();
          const seenNames = new Map<string, number>();
          for (const entry of screen.locators) {
            const identity = `${entry.kind}|${entry.accessibleName ?? entry.name}`;
            const index = seenNames.get(identity) ?? 0;
            seenNames.set(identity, index + 1);
            twinIndex.set(entry.name, index);
          }

          // First pass: navigation only. Submits are recorded, never clicked.
          for (const locator of screen.locators.filter((l) => l.kind === "link" || l.kind === "button")) {
            if (screen.writeActions.some((action) => action.locator === locator.name)) continue;
            const key = elementKey({
              screenId: screen.id,
              role: locator.kind,
              accessibleName: locator.accessibleName ?? locator.name,
              index: twinIndex.get(locator.name) ?? 0,
            });
            if (clickedElements.has(key)) continue;
            clickedElements.add(key);

            // Only while the crawl actually holds a session. On a public crawl
            // there is nothing to lose by following a control that happens to
            // be called "Log out", and skipping it dropped a real screen for
            // nothing.
            const name = locator.accessibleName ?? "";
            if (authenticated && LOGOUT_NAME.test(name)) {
              emit({
                agent: "explorador", status: "info", depth: next.depth + 1,
                message: `No se pulsa "${name}": cerrar sesión es una acción de escritura, mataría la sesión a mitad del recorrido`,
              });
              continue;
            }

            try {
              await page.goto(next.url, { waitUntil: "domcontentloaded" });
            } catch {
              complete = false;
              emit({
                agent: "explorador", status: "warn", depth: next.depth + 1,
                message: `No se pudo recargar ${next.url} antes de probar "${locator.accessibleName ?? locator.name}", se omite`,
              });
              continue;
            }
            const before = page.url();

            // Reuse the SAME scope `resolveCandidate` already validated at
            // capture time, instead of re-resolving the accessible name from
            // scratch, unscoped, and taking `.first()`. Two controls sharing a
            // name (a nav link and its header twin) both match page-wide, and
            // `.first()` would click whichever comes first in DOM order — not
            // necessarily the element the map recorded and generated the
            // Python locator for. That could attribute a transition to the
            // wrong destination, or miss a screen only the scoped element
            // leads to, while the generated Python (built from the scoped
            // locator) claims to reach somewhere the map does not.
            const role = locator.kind === "link" ? "link" : "button";
            const target = narrowedBy(
              page,
              scopedBy(page, locator).getByRole(role as never, { name, exact: true }),
              locator
            );

            const matches = await target.count().catch(() => 0);
            if (matches !== 1) {
              // Still ambiguous even scoped (or the scope disappeared since
              // capture): guessing positionally is worse than skipping.
              emit({
                agent: "explorador", status: "warn", depth: next.depth + 1,
                message: `"${name}" ya no resuelve a un único elemento al recorrerlo (${matches} coincidencias), se omite`,
              });
              continue;
            }

            // Same reasoning as the name test above, applied to where the
            // control GOES: a link labelled "Exit" or "Salir", or an icon with
            // no text at all, ends the session just as surely as one labelled
            // "Log out". Read from the href, so the session dies for nothing
            // only if this misses.
            const logoutPath = authenticated ? await logoutDestination(target, before) : null;
            if (logoutPath !== null) {
              emit({
                agent: "explorador", status: "info", depth: next.depth + 1,
                message: `No se pulsa "${name}": lleva a ${logoutPath} y cerraría la sesión a mitad del recorrido`,
              });
              continue;
            }

            // A link states its destination before it is followed, so an
            // excluded route can be honoured without ever requesting it.
            const excluded = await excludedDestination(target, before, input);
            if (excluded !== null) {
              emit({
                agent: "explorador", status: "info", depth: next.depth + 1,
                message: `No se pulsa "${name}": lleva a ${excluded}, que está excluida`,
              });
              continue;
            }

            await target.click({ timeout: 5_000 }).catch(() => undefined);
            await page.waitForLoadState("domcontentloaded").catch(() => undefined);
            const after = page.url();
            const external = isExternalUrl(after, input.baseUrl);
            const targetTemplate = external ? "" : toUrlTemplate(after, input.baseUrl);

            // The route did not change, so nothing was navigated to: on a
            // client-rendered application the click swapped the view in place.
            // That is a STATE of this screen, never a new screen — which is
            // exactly what keeps "one Page Object per route" intact. Until now
            // only the write pass could produce a state, so a click-induced one
            // fell between the two passes and the walk recorded nothing at all:
            // measured on a real login, where "Forgot password?" leaves
            // `page.url()` identical and replaces the panel, the whole crawl
            // came back with a single screen.
            if (!external && targetTemplate === template) {
              const signature = await currentSignature(page, secrets);
              if (signature === null || knownSignatures.has(signature)) continue;
              knownSignatures.add(signature);

              const view = await captureScreen(page, { screenId: screen.id, baseUrl: input.baseUrl, secrets });
              const stateId = `click-${locator.name}`;
              // Merged IN PLACE: `screens`, `concreteUrls` and `absorbedBy` all
              // hold this exact object, and swapping in the fresh one
              // `mergeScreenState` returns would orphan every lookup keyed on
              // its identity. Locators that only exist here are tagged with the
              // state id by the merge itself, as the write pass's are.
              Object.assign(
                screen,
                mergeScreenState(screen, {
                  id: stateId,
                  reachedBy: { action: "click", locator: locator.name, data: "none" },
                  texts: view.texts,
                  locators: view.locators.filter((l) => !screen.locators.some((existing) => existing.python === l.python)),
                })
              );
              emit({
                agent: "explorador", status: "ok", depth: next.depth + 1,
                message: `"${name}" cambia la vista sin cambiar de ruta: se guarda como estado de ${template}`,
                detail: `${screen.states.at(-1)?.addsTexts.length ?? 0} textos nuevos`,
              });

              // Back to the screen's base state, so the next control is clicked
              // from the same place the map describes instead of from whatever
              // this state left behind.
              try {
                await page.goto(next.url, { waitUntil: "domcontentloaded" });
              } catch {
                complete = false;
                emit({
                  agent: "explorador", status: "warn", depth: next.depth + 1,
                  message: `No se pudo volver a ${next.url} tras el estado "${stateId}", se deja de recorrer esta pantalla`,
                });
                break;
              }
              continue;
            }

            // Everything from here down really navigated: the route template
            // changed, or the click left the application. A click that changed
            // nothing at all cannot reach this point — it has the same URL,
            // hence the same template, and the state branch above answered it.
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

        // `toScreenId` must hold a screen id, not the route template the walk
        // had at hand: consumers read it against `screen.id` and a template
        // matches none of them. Resolved here, once, when every screen the
        // walk could reach is already known — and through `absorbedBy` too,
        // because a destination recorded as `/blog/first-post` is answered by
        // the screen that has since become `/blog/:id`.
        const screenIdForTemplate = (template: string): string | null =>
          screens.find((s) => s.urlTemplate === template)?.id ?? absorbedBy.get(template)?.id ?? null;
        for (const screen of screens) {
          screen.transitions = screen.transitions.map((transition) =>
            transition.toScreenId === null
              ? transition
              : { ...transition, toScreenId: screenIdForTemplate(transition.toScreenId) }
          );
        }

        // Second pass: nothing is submitted without the user's approval, every
        // run — there is deliberately no flag to bypass this. Every screen's
        // write actions are offered up front, whether or not the walk hit any
        // safety limit above; whatever the user did not approve simply never runs.
        const pendingWriteActions = screens.flatMap((screen) =>
          screen.writeActions.map((action) => ({ screenId: screen.id, action }))
        );
        const approvedWriteActions = await input.callbacks.approveWriteActions(pendingWriteActions);
        const writeAuthenticated = await runWritePass(page, screens, approvedWriteActions, concreteUrls, input, emit);
        authenticated = authenticated || writeAuthenticated;

        // Only a crawl that held a session can have screens that needed one:
        // without credentials every screen in the map was, by construction,
        // reached without logging in. Skipping the probe entirely in that case
        // keeps a public crawl exactly as fast as it was.
        if (authenticated) {
          await derivePrivateScreens(browser, screens, concreteUrls, loginSignature, input, secrets, emit);
        }
      } finally {
        await browser.close();
      }

      const map: AppMap = {
        schemaVersion: 2,
        appUrl: input.baseUrl,
        createdAt: new Date().toISOString(),
        complete,
        authenticated,
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

/** The logout path a control points at, or null when it points anywhere else. */
async function logoutDestination(target: Locator, currentUrl: string): Promise<string | null> {
  const href = (await target.getAttribute("href", { timeout: SHORT_READ_TIMEOUT_MS }).catch(() => null)) ?? "";
  if (href.trim().length === 0) return null;
  try {
    const path = new URL(href, currentUrl).pathname;
    return LOGOUT_PATH.test(path) ? path : null;
  } catch {
    return null;
  }
}

/** The excluded route template a link points at, or null when it points elsewhere. */
async function excludedDestination(target: Locator, currentUrl: string, input: CrawlInput): Promise<string | null> {
  if (input.limits.excludeRoutes.length === 0) return null;
  const href = await target.getAttribute("href").catch(() => null);
  if (href === null || href.trim().length === 0) return null;
  try {
    const resolved = new URL(href, currentUrl).toString();
    if (isExternalUrl(resolved, input.baseUrl)) return null;
    const template = toUrlTemplate(resolved, input.baseUrl);
    return matchesExcluded(template, input.limits.excludeRoutes) ? template : null;
  } catch {
    return null;
  }
}

function secretsOf(input: CrawlInput): string[] {
  return input.credentials ? [input.credentials.username, input.credentials.password] : [];
}
