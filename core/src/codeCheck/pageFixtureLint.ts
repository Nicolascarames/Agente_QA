import type { CodeFile } from "./codeChecker.js";

/**
 * Every Playwright Python sync-API method that resolves a selector/role
 * DIRECTLY on `page`, bypassing a Page Object method — not just the two
 * spellings (`get_by_*`, `locator(`) this list used to cover. Playwright still
 * accepts a raw selector string on `page.click`, `page.fill`,
 * `page.wait_for_selector`, `page.query_selector(_all)`, `page.frame_locator`,
 * and the other action/query methods below, so a denylist of only the first
 * two spellings left every one of these as an unblocked escape hatch.
 * `page.goto`/`page.url` (navigation and reads, not locator construction) stay
 * legal, same as `expect(page)` for a page-level assertion.
 */
const DIRECT_LOCATOR =
  /\bpage\.(get_by_|locator\(|click\(|dblclick\(|tap\(|fill\(|type\(|press\(|check\(|uncheck\(|hover\(|select_option\(|set_input_files\(|drag_and_drop\(|wait_for_selector\(|query_selector\(|query_selector_all\(|eval_on_selector\(|eval_on_selector_all\(|frame_locator\(|text_content\(|inner_text\(|inner_html\(|get_attribute\(|is_visible\(|is_hidden\(|is_enabled\(|is_disabled\(|is_checked\()/;

/**
 * A step definition may not build its own locator. Every locator in this system
 * was validated against a real browser and lives in a Page Object generated from
 * the map; one written by hand here is exactly the invention the map exists to
 * prevent. `expect(page)` for a page-level assertion stays allowed.
 */
export function checkNoDirectPageUse(files: CodeFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith("tests/")) continue;
    file.content.split(/\r?\n/).forEach((line, index) => {
      if (line.trim().startsWith("#")) return;
      if (DIRECT_LOCATOR.test(line)) {
        problems.push(
          `${file.path}:${index + 1}: un step definition no puede construir su propio localizador (${line.trim()}). Usa un método del Page Object.`
        );
      }
    });
  }
  return problems;
}
