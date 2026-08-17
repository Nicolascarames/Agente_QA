/**
 * Every `page.` in a stored locator expression becomes `self.page.` — not just
 * the first. An attribute-disambiguated locator carries a second reference
 * inside `.and_(...)`, and a bare `page` inside a Page Object method raises
 * `NameError: name 'page' is not defined` at runtime.
 *
 * `\b` does not match inside `login_page.` because `_` is a word character, so
 * an expression that already goes through a Page Object survives unchanged.
 * The negative lookbehind `(?<!self\.)` additionally guards against a second
 * pass over an already-rewritten expression: without it, `self.page.` would
 * become `self.self.page.` instead of surviving unchanged.
 *
 * This function has exactly one owner on purpose: the same rule used to live
 * in the emitter and in the freshness check as two separate copies, and both
 * copies were wrong at once.
 */
export function toSelfPageExpression(python: string): string {
  return python.replace(/(?<!self\.)\bpage\./g, "self.page.");
}
