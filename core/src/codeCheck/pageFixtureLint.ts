import type { CodeFile } from "./codeChecker.js";

const DIRECT_LOCATOR = /\bpage\.(get_by_|locator\()/;

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
