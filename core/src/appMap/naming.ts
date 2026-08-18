import { createHash } from "node:crypto";

export function pythonIdentifier(raw: string): string {
  const ascii = raw.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const cleaned = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) return "unnamed";
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function uniqueName(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  let counter = 2;
  while (taken.has(`${candidate}_${counter}`)) counter += 1;
  return `${candidate}_${counter}`;
}

const ATTRIBUTE_PREFIX = "attribute:";

/**
 * The word a disambiguator contributes to a locator's name, or "" when it has
 * none to give. `attribute:[type='submit']` contributes "submit"; a scope
 * contributes whatever follows its prefix.
 */
export function disambiguatorToken(disambiguatedBy: string | undefined): string {
  if (!disambiguatedBy) return "";
  if (disambiguatedBy.startsWith(ATTRIBUTE_PREFIX)) {
    const condition = disambiguatedBy.slice(ATTRIBUTE_PREFIX.length);
    const value = condition.match(/=\s*['"]([^'"]*)['"]/)?.[1];
    return pythonIdentifier(value ?? condition);
  }
  const separator = disambiguatedBy.indexOf(":");
  return pythonIdentifier(separator === -1 ? disambiguatedBy : disambiguatedBy.slice(separator + 1));
}

/**
 * A locator's name, suffixed by the fact that made it unique — never by a
 * counter. A counter encodes crawl order, so the same element could be
 * `log_in_button_2` today and `log_in_button_3` tomorrow, silently breaking
 * every reference to it. Deriving the suffix from `disambiguatedBy` makes the
 * name a property of the element instead.
 *
 * `fingerprint` is used only for the last-resort suffix: the locator's own
 * Python expression, which is unique whenever the disambiguation succeeded.
 */
export function disambiguatedName(
  base: string,
  disambiguatedBy: string | undefined,
  fingerprint: string,
  taken: Set<string>
): string {
  const token = disambiguatorToken(disambiguatedBy);
  if (token.length === 0) {
    return taken.has(base) ? `${base}_${fingerprintSuffix(fingerprint)}` : base;
  }
  // `log_in_button` + token "button" would say the same thing twice. Drop it,
  // unless dropping it collides with a sibling that already owns the base.
  if ((base === token || base.endsWith(`_${token}`)) && !taken.has(base)) return base;
  const withToken = `${base}_${token}`;
  if (!taken.has(withToken)) return withToken;
  return `${withToken}_${fingerprintSuffix(fingerprint)}`;
}

function fingerprintSuffix(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 6);
}
