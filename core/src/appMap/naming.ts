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
