import type { Locator, Page } from "playwright";
import type { AmbiguousCandidate, LocatorEntry, Screen } from "./schema.js";
import { screenSignature } from "./signature.js";
import { toUrlTemplate } from "./urlTemplate.js";
import { pythonIdentifier, uniqueName } from "./naming.js";
import { redactText } from "./redact.js";

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

  // A password input does NOT expose the `textbox` role in ARIA, so the loop
  // above never sees it. Without this block no login screen would get a
  // fill_password method and the whole point of the map would be missed.
  // These are addressed by label, which is what Playwright offers for a
  // labelled field of any type.
  for (const handle of await page.locator('input[type="password"]').all()) {
    const id = await handle.getAttribute("id");
    const label = id ? (await page.locator(`label[for="${id}"]`).innerText().catch(() => "")) : "";
    const name = (label || (await handle.getAttribute("aria-label")) || (await handle.getAttribute("placeholder")) || "").trim();
    if (name.length === 0) continue;
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
