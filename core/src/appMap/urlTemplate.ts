const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const VARIABLE = ":id";

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
  return "/" + segments.map((s) => (isVariableSegment(s) ? VARIABLE : s)).join("/");
}

/**
 * The spec's third templating rule: a segment is also variable when two SIBLING
 * URLs differ only in it. `/blog/first-post` and `/blog/second-post` are one
 * screen with different data, and without this rule a catalogue or a blog turns
 * into hundreds of screens and hundreds of committed Page Objects.
 *
 * Returns the collapsed template, or null when the two are not siblings.
 *
 * The differing segment is never the first one: `/reset.html` and `/list.html`
 * differ in exactly one segment too, and collapsing every top-level route into
 * `/:id` would erase the whole map. Sharing at least one leading segment is
 * what makes two routes siblings rather than merely equal in shape. Sibling
 * SHAPE is necessary but not sufficient — `/settings/profile` and
 * `/settings/billing` also share it — so the caller decides with the screen
 * signature, which says whether the two are really the same screen.
 */
/**
 * Whether a concrete route is an instance of a route template already in the
 * map: a `:id` segment matches any single segment, every other segment must be
 * equal.
 *
 * `siblingTemplate` alone only ever collapses the FIRST pair, because it
 * refuses a side that already carries `:id` — by design, or `/user/:id` and
 * `/user/settings` would collapse into `/user/:id` and swallow a real screen.
 * The consequence was that from the third sibling onward the rule stopped
 * firing entirely: `/blog/first-post` and `/blog/second-post` became
 * `/blog/:id`, and `/blog/third-post` then landed in the map as a separate
 * screen, so the catalogue explosion the rule exists to prevent simply resumed
 * at item three. Matching a new concrete route against the templates already
 * stored is what makes the rule hold for the whole catalogue.
 */
export function matchesTemplate(template: string, concrete: string): boolean {
  if (!template.includes(VARIABLE)) return false;
  const left = template.split("/");
  const right = concrete.split("/");
  if (left.length !== right.length) return false;
  return left.every((segment, index) => segment === VARIABLE || segment === right[index]);
}

export function siblingTemplate(a: string, b: string): string | null {
  if (a === b) return null;
  const left = a.split("/");
  const right = b.split("/");
  if (left.length !== right.length || left.length < 3) return null;

  let differing = -1;
  for (let i = 0; i < left.length; i++) {
    if (left[i] === right[i]) continue;
    if (differing !== -1) return null;
    differing = i;
  }
  // Index 0 is the empty string before the leading slash; index 1 is the first
  // real segment, which must match for the two routes to be siblings.
  if (differing < 2) return null;
  if (left[differing] === VARIABLE || right[differing] === VARIABLE) return null;

  const collapsed = [...left];
  collapsed[differing] = VARIABLE;
  return collapsed.join("/");
}
