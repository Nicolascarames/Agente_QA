import { describe, it, expect } from "vitest";
import { toSelfPageExpression } from "./pythonExpression.js";

describe("toSelfPageExpression", () => {
  it("rewrites a plain expression", () => {
    expect(toSelfPageExpression('page.get_by_role("button", name="Log in", exact=True)')).toBe(
      'self.page.get_by_role("button", name="Log in", exact=True)'
    );
  });

  it("rewrites EVERY page reference, not just the leading one", () => {
    // This is the whole point: an attribute-disambiguated locator carries a
    // second `page.` inside `.and_(...)`, and leaving it bare raises
    // NameError at runtime inside a Page Object method.
    const input =
      'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))';
    const out = toSelfPageExpression(input);
    expect(out).toBe(
      'self.page.get_by_role("button", name="Log in", exact=True).and_(self.page.locator("[type=\'submit\']"))'
    );
    expect(out).not.toMatch(/(?<!self\.)\bpage\./);
  });

  it("does not corrupt an identifier that merely ends in page", () => {
    expect(toSelfPageExpression("login_page.get_by_role()")).toBe("login_page.get_by_role()");
  });

  it("leaves an expression that does not start from page untouched", () => {
    expect(toSelfPageExpression('self.page.locator("#x")')).toBe('self.page.locator("#x")');
  });

  // A `kind: "text"` locator's Python embeds the app's own copy verbatim, and
  // ordinary UI copy ends in a lowercase "page." often enough that a
  // literal-blind rewrite corrupts it into text nobody ever wrote on screen.
  it("does not touch a `page.` that lives inside a string literal", () => {
    const input = 'page.get_by_text("You do not have permission to view this page.", exact=True)';
    expect(toSelfPageExpression(input)).toBe(
      'self.page.get_by_text("You do not have permission to view this page.", exact=True)'
    );
  });

  it("does not touch a `page.` inside a named-argument string literal", () => {
    const input = 'page.get_by_role("button", name="Go to page.", exact=True)';
    expect(toSelfPageExpression(input)).toBe(
      'self.page.get_by_role("button", name="Go to page.", exact=True)'
    );
  });

  it("copies a single-quoted literal's contents through untouched", () => {
    const input = "page.get_by_text('Back to page.', exact=True)";
    expect(toSelfPageExpression(input)).toBe("self.page.get_by_text('Back to page.', exact=True)");
  });

  it("respects a backslash-escaped quote inside a literal without ending it early", () => {
    const input = 'page.get_by_text("Click \\"page.\\" now", exact=True)';
    expect(toSelfPageExpression(input)).toBe(
      'self.page.get_by_text("Click \\"page.\\" now", exact=True)'
    );
  });
});
