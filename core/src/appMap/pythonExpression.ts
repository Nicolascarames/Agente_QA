/**
 * Every `page.` in a stored locator expression becomes `self.page.` — not just
 * the first. An attribute-disambiguated locator carries a second reference
 * inside `.and_(...)`, and a bare `page` inside a Page Object method raises
 * `NameError: name 'page' is not defined` at runtime.
 *
 * This walks the expression char by char instead of using a single regex,
 * because a regex cannot tell code position from string-literal contents: a
 * `kind: "text"` locator's Python is `page.get_by_text(<the app's own
 * words>, exact=True)`, and ordinary UI copy ends in a lowercase "page." all
 * the time ("You do not have permission to view this page."). A literal-blind
 * replace corrupts that copy — the exact "validated one way, emitted another"
 * bug this function exists to prevent. So a string literal (single- or
 * double-quoted, backslash escapes respected) is copied through byte for
 * byte, and only `page.` in code position is ever rewritten.
 *
 * In code position: a reference only counts at a word boundary — `\b` would
 * not match inside `login_page.` because `_` is a word character, so an
 * expression that already goes through a Page Object survives unchanged —
 * and only when it is not already qualified with `self.`, which guards a
 * second pass over an already-rewritten expression: without it, `self.page.`
 * would become `self.self.page.` instead of surviving unchanged.
 *
 * This function has exactly one owner on purpose: the same rule used to live
 * in the emitter and in the freshness check as two separate copies, and both
 * copies were wrong at once.
 */
export function toSelfPageExpression(python: string): string {
  const isWordChar = (char: string): boolean => /\w/.test(char);

  let result = "";
  let i = 0;
  const n = python.length;

  while (i < n) {
    const ch = python[i];

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n && python[j] !== quote) {
        j += python[j] === "\\" && j + 1 < n ? 2 : 1;
      }
      j = Math.min(j + 1, n); // consume the closing quote, if any
      result += python.slice(i, j);
      i = j;
      continue;
    }

    const precedingIsWordChar = i > 0 && isWordChar(python[i - 1]);
    const alreadyQualified = python.slice(Math.max(0, i - 5), i) === "self.";

    if (!precedingIsWordChar && !alreadyQualified && python.startsWith("page.", i)) {
      result += "self.page.";
      i += 5;
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}
