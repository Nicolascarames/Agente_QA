const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;

function isVariableSegment(segment: string): boolean {
  return NUMERIC.test(segment) || UUID.test(segment);
}

/**
 * Two URLs that differ only in a variable segment are the same screen with
 * different data (/user/123 and /user/456), so the crawler must visit one of
 * them and not both. Query string and hash are dropped: they carry state
 * within a screen, not identity of the screen.
 */
export function toUrlTemplate(url: string, baseUrl: string): string {
  const parsed = new URL(url, baseUrl);
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "/";
  return "/" + segments.map((s) => (isVariableSegment(s) ? ":id" : s)).join("/");
}
