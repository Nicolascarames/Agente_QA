import { describe, it, expect } from "vitest";
import { checkNoDirectPageUse } from "./pageFixtureLint.js";

describe("checkNoDirectPageUse", () => {
  it("accepts a step definition that goes through the Page Object", () => {
    const files = [{ path: "tests/test_login.py", content: 'def s(login_page):\n    login_page.click_log_in_button()\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });

  it("rejects a step definition that builds its own locator", () => {
    const files = [{ path: "tests/test_login.py", content: 'def s(page):\n    expect(page.get_by_role("alert")).to_be_visible()\n' }];
    expect(checkNoDirectPageUse(files)[0]).toMatch(/page\./);
  });

  it("allows page-level assertions that cannot come from a Page Object", () => {
    const files = [{ path: "tests/test_login.py", content: 'def s(page):\n    expect(page).to_have_url("/x")\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });

  it("ignores comments", () => {
    const files = [{ path: "tests/test_login.py", content: '# page.get_by_text("x")\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });

  it("does not inspect files under pages/", () => {
    const files = [{ path: "pages/login_page.py", content: 'return self.page.get_by_role("button")\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });

  // Playwright's Python sync API accepts raw selector strings on `page`
  // directly, bypassing the Page Object just as much as `page.get_by_*(...)`
  // or `page.locator(...)` — the two spellings the lint used to check.
  const rawSelectorCalls = [
    'page.click("button[type=submit]")',
    'page.fill("#email", value)',
    'page.wait_for_selector(".alert")',
    'page.query_selector(".alert")',
    'page.query_selector_all(".alert")',
    'page.frame_locator("#frame")',
    'page.check("#agree")',
    'page.hover("#menu")',
    'page.select_option("#country", "es")',
    'page.type("#email", value)',
  ];

  for (const call of rawSelectorCalls) {
    it(`rejects a hand-built selector via ${call.split("(")[0]}`, () => {
      const files = [{ path: "tests/test_login.py", content: `def s(page):\n    ${call}\n` }];
      expect(checkNoDirectPageUse(files)[0]).toMatch(/page\./);
    });
  }

  it("still allows page.goto and page.url — navigation and reads, not locator construction", () => {
    const files = [{
      path: "tests/test_login.py",
      content: 'def s(page):\n    page.goto("/login")\n    assert page.url.endswith("/login")\n',
    }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });

  it("still ignores a comment that quotes a forbidden raw-selector call", () => {
    const files = [{ path: "tests/test_login.py", content: '# page.click("button[type=submit]")\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });
});
