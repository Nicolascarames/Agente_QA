import { chromium } from "playwright";
import type { Locator, Page } from "playwright";
import type { EmitEvent } from "../events/agentEvent.js";
import type { AmbiguousCandidate, AppMap, LocatorEntry, Screen, WriteAction } from "./schema.js";
import { screenSignature, isSuspectedLoop } from "./signature.js";
import { toUrlTemplate, siblingTemplate } from "./urlTemplate.js";
import { pythonIdentifier, uniqueName } from "./naming.js";
import { pythonLiteral } from "./pythonLiteral.js";
import { redactText } from "./redact.js";
import { elementKey, mergeScreenState } from "./elementIdentity.js";
import type { Crawler, CrawlCredentials, CrawlInput, CrawlResult } from "./crawler.js";
import { MissingCrawlerToolError } from "./crawler.js";

export { pythonLiteral } from "./pythonLiteral.js";

const REGIONS = ["main", "form", "navigation", "banner", "contentinfo", "dialog"] as const;

/** Fields the crawler treats as fillable form inputs, everywhere in this file. */
const FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])';

const PASSWORD_NAME = /password|contrasena|contraseña|clave/i;

/**
 * Logging out mid-crawl would kill the session the whole authenticated pass
 * depends on, so a control with one of these names is never clicked during the
 * walk — the spec classifies it as a write action, not as navigation.
 */
const LOGOUT_NAME = /log\s*-?\s*out|logout|sign\s*-?\s*out|cerrar\s+sesi[oó]n|desconectar/i;

/** A single text node long enough to be a paragraph is copy, not a locator target. */
const MAX_TEXT_CANDIDATE_LENGTH = 300;

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
  /** Screens captured while the crawl holds a real session are private screens. */
  requiresAuth?: boolean;
  /** Optional so tests can capture a screen without wiring an event channel. */
  emit?: EmitEvent;
}

interface Candidate {
  kind: LocatorEntry["kind"];
  role: string | null;
  accessibleName: string;
  build: (scope: Locator | Page) => Locator;
  python: (scopePrefix: string) => string;
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
 * The text of the `<label for=…>` that names a field, or "" when there is none.
 *
 * The `count()` gate is the whole point: `count()` answers from the current DOM
 * without waiting, while `innerText()` on a selector that matches nothing waits
 * for it to appear and only then gives up. An input with an `id` and no
 * matching label — a placeholder-only or `aria-label`-only field, the ordinary
 * case in a single-page application — therefore used to cost Playwright's full
 * default timeout EACH TIME, and this runs once per field per capture.
 */
async function labelTextFor(page: Page, id: string): Promise<string> {
  const escaped = id.replace(/["\\]/g, "\\$&");
  const label = page.locator(`label[for="${escaped}"]`);
  if ((await label.count().catch(() => 0)) !== 1) return "";
  return await label.innerText({ timeout: SHORT_READ_TIMEOUT_MS }).catch(() => "");
}

/** Every name a form field could be recorded under, most specific first. */
async function fieldNames(page: Page, handle: Locator): Promise<string[]> {
  const id = await attribute(handle, "id");
  const label = id.length > 0 ? await labelTextFor(page, id) : "";
  const aria = await attribute(handle, "aria-label");
  const placeholder = await attribute(handle, "placeholder");
  return [label, aria, placeholder].map((name) => name.trim()).filter((name) => name.length > 0);
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
  return page.evaluate((maxLength: number) => {
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
      if (text.length === 0 || text.length > maxLength) continue;
      const candidate = element as HTMLElement & { checkVisibility?: () => boolean };
      const visible =
        typeof candidate.checkVisibility === "function"
          ? candidate.checkVisibility()
          : candidate.offsetParent !== null;
      if (!visible) continue;
      found.push(text);
    }
    return found;
  }, MAX_TEXT_CANDIDATE_LENGTH);
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
      candidates.push({
        kind,
        role,
        accessibleName: trimmed,
        build: (scope) => scope.getByRole(role as never, { name: trimmed, exact: true }),
        python: exactRolePython(role, trimmed),
      });
    }
  }

  // The role loop above names a candidate from `aria-label`, `innerText` or —
  // for buttons only — `value`. An <input> never has `innerText` (it has no
  // text content, labelled or not) and rarely carries `aria-label`, so EVERY
  // plain form field — email, text, password alike — comes out of that loop
  // with an empty name and gets dropped there, `textbox` role or no `textbox`
  // role. Confirmed empirically against this fixture: both the email and the
  // password field match `getByRole("textbox")`, and both report
  // `innerText: ""`. Their real name lives on a separate `<label for="...">`,
  // which this pass reads directly. Without it, no login screen would get a
  // fillable input at all and the whole point of the map would be missed.
  //
  // Dedup against the role loop by accessible name: if the role loop above
  // already produced an "input" candidate with this name, the role-based
  // locator wins and this pass must not add a second, redundant one for the
  // same field (same failure mode `mergeScreenState` guards against one
  // layer down — see Task 5 — except here the duplicate would otherwise be
  // created earlier, inside a single capture).
  const inputNamesFromRoleLoop = new Set(candidates.filter((c) => c.kind === "input").map((c) => c.accessibleName));

  for (const handle of await page.locator(FIELD_SELECTOR).all()) {
    const name = (await fieldNames(page, handle))[0] ?? "";
    if (name.length === 0 || inputNamesFromRoleLoop.has(name)) continue;
    inputNamesFromRoleLoop.add(name);
    candidates.push({
      kind: "input",
      role: null,
      accessibleName: name,
      build: (scope) => scope.getByLabel(name, { exact: true }),
      python: (prefix) => `${prefix}get_by_label(${pythonLiteral(name)}, exact=True)`,
    });
  }

  const seenTexts = new Set<string>();
  const paragraphs = await page.getByRole("paragraph").allInnerTexts();
  for (const text of [...paragraphs, ...(await leafTexts(page))]) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_CANDIDATE_LENGTH || seenTexts.has(trimmed)) continue;
    seenTexts.add(trimmed);
    candidates.push({
      kind: "text",
      role: null,
      accessibleName: trimmed,
      build: (scope) => scope.getByText(trimmed, { exact: true }),
      python: (prefix) => `${prefix}get_by_text(${pythonLiteral(trimmed)}, exact=True)`,
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
  if (plainCount === 0) return { ambiguous: { candidate: plainPython, count: 0, reason: "no encontrado al validar" } };

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

  for (const candidate of await collectCandidates(page)) {
    const cleanName = redactText(candidate.accessibleName, context.secrets);
    if (!texts.includes(cleanName)) texts.push(cleanName);

    const resolved = await resolveCandidate(page, candidate);
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
    ...screenIdentity(context.screenId),
    urlTemplate,
    signature: screenSignature(ariaSnapshot),
    requiresAuth: context.requiresAuth === true,
    texts,
    probeValues: [],
    locators,
    states: [],
    ambiguous,
    transitions: [],
    writeActions: [],
  };
}

/** `id`, `name` and `className` all derive from the same slug, in one place. */
function screenIdentity(screenId: string): { id: string; name: string; className: string } {
  return {
    id: screenId,
    name: screenId,
    className: `${pythonIdentifier(screenId).replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())}Page`,
  };
}

function matchesExcluded(urlTemplate: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return regex.test(urlTemplate);
  });
}

/** Resolves a route template against the app's base URL with URL semantics. */
export function resolveScreenUrl(baseUrl: string, urlTemplate: string): string {
  return new URL(urlTemplate, baseUrl).toString();
}

/**
 * Only the ORIGIN of `appUrl` is walked. String prefixes cannot decide this:
 * with `baseUrl = "https://example.com"` (no trailing slash, perfectly legal
 * config), `https://example.com.evil.test/panel` starts with the base URL and
 * would be crawled as if it were part of the application.
 */
export function isExternalUrl(url: string, baseUrl: string): boolean {
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
export async function collectWriteActions(page: Page, screen: Screen, secrets: string[]): Promise<WriteAction[]> {
  const actions: WriteAction[] = [];
  for (const submit of await page.locator("form button[type=submit], form input[type=submit]").all()) {
    // `<input type="submit">` has no innerText at all: without the `value`
    // fallback its label was always "Enviar", the lookup by accessible name
    // below always failed, and such a button could never become a write action.
    const rawLabel = await controlName(submit, { useValue: true });
    const label = redactText(rawLabel.length > 0 ? rawLabel : "Enviar", secrets);
    const locator = screen.locators.find((l) => l.accessibleName === label && l.kind === "button");
    if (!locator) continue;

    const form = await formOf(page, submit);
    const namesInForm = new Set<string>();
    if (form !== null) {
      for (const field of await form.locator(FIELD_SELECTOR).all()) {
        for (const name of await fieldNames(page, field)) namesInForm.add(redactText(name, secrets));
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
  const looksLikeEmail = /email|correo|user|usuario/i.test(fieldName);
  const looksLikePassword = PASSWORD_NAME.test(fieldName);
  if (data === "invalid") return looksLikeEmail ? INVALID_EMAIL : looksLikePassword ? INVALID_PASSWORD : "";
  if (looksLikeEmail) return credentials?.username ?? "agente-qa@example.test";
  if (looksLikePassword) return credentials?.password ?? "agente-qa-valid-password";
  return "agente-qa";
}

/** The region `resolveCandidate` already validated this locator in, if any. */
function regionOf(entry: { disambiguatedBy?: string } | undefined): string | null {
  const value = entry?.disambiguatedBy;
  return value !== undefined && value.startsWith("region:") ? value.slice("region:".length) : null;
}

function scopedBy(page: Page, region: string | null): Locator | Page {
  return region === null ? page : page.getByRole(region as never);
}

function hasPasswordField(screen: Screen, action: WriteAction): boolean {
  return action.formFields.some((fieldName) => {
    const field = screen.locators.find((l) => l.name === fieldName);
    return field?.accessibleName !== undefined && PASSWORD_NAME.test(field.accessibleName);
  });
}

/**
 * Fills a form with the SAME scope every other resolver in this file uses: the
 * region `resolveCandidate` recorded at capture time. Re-resolving the label
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
    const target = scopedBy(page, regionOf(field)).getByLabel(field.accessibleName, { exact: true });
    const matches = await target.count().catch(() => 0);
    if (matches !== 1) {
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
  const target = scopedBy(page, regionOf(submitLocator)).getByRole("button", { name: action.label, exact: true });
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
 */
async function attemptLogin(page: Page, input: CrawlInput, emit: EmitEvent, secrets: string[]): Promise<boolean> {
  if (input.credentials === undefined) return false;
  try {
    await page.goto(input.baseUrl, { waitUntil: "domcontentloaded" });
  } catch {
    emit({ agent: "explorador", status: "warn", depth: 1, message: `No se pudo cargar ${input.baseUrl} para iniciar sesión` });
    return false;
  }

  const entry = await captureScreen(page, { screenId: "login", baseUrl: input.baseUrl, secrets });
  const action = (await collectWriteActions(page, entry, secrets)).find((a) => hasPasswordField(entry, a));
  if (action === undefined) {
    emit({ agent: "explorador", status: "info", depth: 1, message: "No se encontró formulario de login en la pantalla inicial, se mapea solo la parte pública" });
    return false;
  }

  const before = page.url();
  await fillFormFields(page, entry, action, "valid", input.credentials, emit);
  if (!(await clickWriteAction(page, entry, action, emit))) return false;

  const authenticated = page.url() !== before;
  emit(
    authenticated
      ? { agent: "explorador", status: "ok", depth: 1, message: `Sesión iniciada, el mapa cubrirá la zona privada → ${page.url()}` }
      : { agent: "explorador", status: "warn", depth: 1, message: "El login no cambió de pantalla, se mapea solo la parte pública" }
  );
  return authenticated;
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
  input: CrawlInput,
  emit: EmitEvent
): Promise<boolean> {
  const secrets = secretsOf(input);
  let authenticated = false;
  for (const { screenId, locator: locatorName } of approved) {
    const index = screens.findIndex((s) => s.id === screenId);
    if (index < 0) continue;
    let screen = screens[index];
    const action = screen.writeActions.find((a) => a.locator === locatorName);
    if (!action) continue;

    const isLoginAction = hasPasswordField(screen, action);

    for (const data of ["invalid", "valid"] as const) {
      const url = resolveScreenUrl(input.baseUrl, screen.urlTemplate);
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

      const after = await captureScreen(page, {
        screenId: screen.id, baseUrl: input.baseUrl, secrets, requiresAuth: screen.requiresAuth,
      });
      screen = mergeScreenState(screen, {
        id: `${data}-submit-${action.locator}`,
        reachedBy: { action: "submit", locator: action.locator, data },
        texts: after.texts.filter((t) => !probeValues.includes(t)),
        locators: after.locators.filter((l) => !screen.locators.some((existing) => existing.python === l.python)),
      });
      screen = { ...screen, probeValues: Array.from(new Set([...screen.probeValues, ...probeValues])) };
      screens[index] = screen;
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
      let complete = true;
      let authenticated = false;

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
        authenticated = await attemptLogin(page, input, emit, secrets);
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
          const screen = await captureScreen(page, {
            screenId, baseUrl: input.baseUrl, secrets, requiresAuth: authenticated, emit,
          });

          // Third templating rule of the spec: two sibling URLs that differ in
          // exactly one segment are the same screen with different data. The
          // signature decides — /settings/profile and /settings/billing are
          // siblings by shape but different screens, and their accessibility
          // trees say so. Without this rule a catalogue or a blog explodes into
          // hundreds of screens and hundreds of committed Page Objects, with
          // `maxScreens` as the only brake.
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

          // First pass: navigation only. Submits are recorded, never clicked.
          for (const locator of screen.locators.filter((l) => l.kind === "link" || l.kind === "button")) {
            if (screen.writeActions.some((action) => action.locator === locator.name)) continue;
            const key = elementKey({
              screenId: screen.id, role: locator.kind, accessibleName: locator.accessibleName ?? locator.name, index: 0,
            });
            if (clickedElements.has(key)) continue;
            clickedElements.add(key);

            const name = locator.accessibleName ?? "";
            if (LOGOUT_NAME.test(name)) {
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
            const target = scopedBy(page, regionOf(locator)).getByRole(role as never, { name, exact: true });

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
            if (after === before) continue;

            const targetTemplate = toUrlTemplate(after, input.baseUrl);
            const external = isExternalUrl(after, input.baseUrl);
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
        // walk could reach is already known.
        for (const screen of screens) {
          screen.transitions = screen.transitions.map((transition) =>
            transition.toScreenId === null
              ? transition
              : { ...transition, toScreenId: screens.find((s) => s.urlTemplate === transition.toScreenId)?.id ?? null }
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
        const writeAuthenticated = await runWritePass(page, screens, approvedWriteActions, input, emit);
        authenticated = authenticated || writeAuthenticated;
      } finally {
        await browser.close();
      }

      const map: AppMap = {
        schemaVersion: 1,
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
