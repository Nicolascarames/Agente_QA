import { createHash } from "node:crypto";

const VOLATILE = [
  /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/g,          // dates
  /\d[\d.,]*\s?(?:€|\$|%)/g,                  // amounts
  /\b\d+\b/g,                                 // any bare number
];
const STRUCTURAL = /\[[^\]]*\]/g;             // bracketed structural annotations like [level=1]
// A link's href is data (which screen it points to), not structure: two
// otherwise-identical screens whose only difference is a "Next" link
// pointing at a different page (paginated lists, or three structurally
// identical routes like a loop-a/loop-b/loop-c fixture) must still get the
// same signature so the loop detector can spot the repetition. Route
// identity is already `toUrlTemplate`'s job; this only strips the VALUE
// after `/url:`, keeping the `/url:` marker itself so a link with an href
// stays distinguishable from one without one.
const URL_LINE = /^(\s*-\s*\/url:\s*).*$/gm;

/**
 * Fingerprint of the accessibility tree with the data stripped out: roles and
 * accessible names survive, numbers, dates, amounts and link hrefs do not.
 * Two pages of a paginated list share a signature, which is what turns
 * "click Next forever" into a detectable loop instead of an endless supply
 * of new screens.
 */
export function screenSignature(ariaSnapshot: string): string {
  // Strip link href values before anything else, so a URL's digits or
  // brackets never reach the structural/volatile passes below.
  const withoutUrls = ariaSnapshot.replace(URL_LINE, (_match, marker: string) => `${marker}#`);

  // Save structural annotations and replace with placeholders
  const annotations: string[] = [];
  let withPlaceholders = withoutUrls.replace(STRUCTURAL, (match) => {
    annotations.push(match);
    return `__STRUCT_${annotations.length - 1}__`;
  });

  // Strip volatile data (dates, amounts, bare numbers)
  for (const pattern of VOLATILE) withPlaceholders = withPlaceholders.replace(pattern, "#");

  // Restore structural annotations
  let normalized = withPlaceholders;
  for (let i = 0; i < annotations.length; i++) {
    normalized = normalized.replace(`__STRUCT_${i}__`, annotations[i]);
  }

  normalized = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return "sha256:" + createHash("sha256").update(normalized).digest("hex");
}

export function isSuspectedLoop(recentSignatures: string[], threshold: number): boolean {
  if (threshold < 1 || recentSignatures.length < threshold) return false;
  const window = recentSignatures.slice(-threshold);
  return window.every((signature) => signature === window[0]);
}
