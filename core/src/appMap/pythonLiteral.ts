/**
 * Builds a Python double-quoted string literal. Backslashes and double quotes
 * are escaped so the value cannot break out of the literal; `\r`, `\n` and
 * `\t` are escaped too so an accessible name that contains a raw newline (a
 * multi-line button label, for instance) can never split the emitted string
 * across lines. `pageObjectEmitter` interpolates this output verbatim into a
 * generated Python file without parsing it, so an unescaped newline here
 * produces `SyntaxError: unterminated string literal` in the generated test
 * and makes the whole file uncollectable — proven with a real `py_compile`
 * run during the Task 6 review.
 *
 * It lives in its own module, away from `realCrawler`, so `pageObjectEmitter`
 * can use it without importing Playwright.
 */
export function pythonLiteral(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}
