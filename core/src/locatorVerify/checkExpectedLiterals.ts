import type { LocatorCheck } from "./locatorVerifier.js";
import type { ScreenEvidence } from "../siteExplorer/siteExplorer.js";

export interface MissingLiteral {
  method: string;
  argument: string;
  closest: string | null;
}

// Playwright matches accessible names and text case-insensitively and with
// whitespace collapsed (get_by_role(exact=False), get_by_text). Comparing the
// same way is what makes the feature's "Log In" match the real button "Log in".
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function candidateTexts(screens: ScreenEvidence[]): string[] {
  const found: string[] = [];
  for (const screen of screens) {
    for (const line of screen.ariaSnapshot.split("\n")) {
      for (const quoted of line.matchAll(/"([^"]+)"/g)) found.push(quoted[1]);
      const text = line.match(/text:\s*(.+)$/);
      if (text) found.push(text[1].trim());
    }
  }
  return found;
}

function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i++) grams.push(value.slice(i, i + 2));
  return grams;
}

// Dice coefficient over character bigrams: enough to point at the real text in
// an error message, and needs no new dependency.
function similarity(a: string, b: string): number {
  const left = bigrams(normalize(a));
  const right = bigrams(normalize(b));
  if (left.length === 0 || right.length === 0) return 0;
  const pool = [...right];
  let hits = 0;
  for (const gram of left) {
    const index = pool.indexOf(gram);
    if (index >= 0) {
      hits++;
      pool.splice(index, 1);
    }
  }
  return (2 * hits) / (left.length + right.length);
}

export function checkExpectedLiterals(
  checks: LocatorCheck[],
  screens: ScreenEvidence[]
): MissingLiteral[] {
  if (screens.length === 0) return [];

  const haystack = screens.map((screen) => normalize(screen.ariaSnapshot));
  const candidates = candidateTexts(screens);
  const missing: MissingLiteral[] = [];

  for (const check of checks) {
    const needle = normalize(check.argument);
    if (needle.length === 0) continue;
    if (haystack.some((snapshot) => snapshot.includes(needle))) continue;

    let closest: string | null = null;
    let best = 0;
    for (const candidate of candidates) {
      const score = similarity(check.argument, candidate);
      if (score > best) {
        best = score;
        closest = candidate;
      }
    }
    missing.push({ method: check.method, argument: check.argument, closest: best >= 0.06 ? closest : null });
  }

  return missing;
}

export function formatMissingLiterals(missing: MissingLiteral[]): string {
  return missing
    .map((item) => {
      const suggestion = item.closest
        ? ` El texto real más parecido en la aplicación es "${item.closest}": usa ese, o reescribe el paso sin literal.`
        : " No hay ningún texto parecido en la aplicación: reescribe el paso sin literal.";
      return `El archivo .feature espera el texto "${item.argument}" (locator ${item.method}), que no aparece en ninguna de las pantallas verificadas de la aplicación real.${suggestion}`;
    })
    .join("\n\n");
}
