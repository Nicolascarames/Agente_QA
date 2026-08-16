import { createHash } from "node:crypto";

const VOLATILE = [
  /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/g,          // dates
  /\d[\d.,]*\s?(?:€|\$|%)/g,                  // amounts
  /\b\d+\b/g,                                 // any bare number
];

/**
 * Fingerprint of the accessibility tree with the data stripped out: roles and
 * accessible names survive, numbers, dates and amounts do not. Two pages of a
 * paginated list share a signature, which is what turns "click Next forever"
 * into a detectable loop instead of an endless supply of new screens.
 */
export function screenSignature(ariaSnapshot: string): string {
  let normalized = ariaSnapshot;
  for (const pattern of VOLATILE) normalized = normalized.replace(pattern, "#");
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
