import { AppMapSchema, type AppMap } from "./schema.js";

export const REDACTED = "[REDACTED]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.trim().length === 0) continue;
    result = result.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return result;
}

/**
 * Second net, applied right before the map is written. The first net is
 * redaction at the single point where a screen is captured (realCrawler). Both
 * exist because the map is versioned in the user's git: a secret that gets in
 * ends up in their repository.
 *
 * Serialise-redact-reparse is deliberate: it guarantees no field is missed as
 * the schema grows, which a hand-written per-field walk cannot promise.
 */
export function redactMap(map: AppMap, secrets: string[]): AppMap {
  const redacted = redactText(JSON.stringify(map), secrets);
  return AppMapSchema.parse(JSON.parse(redacted));
}
