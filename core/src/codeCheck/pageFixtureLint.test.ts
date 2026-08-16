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
});
