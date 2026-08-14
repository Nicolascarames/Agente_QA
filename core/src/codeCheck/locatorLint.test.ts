import { describe, it, expect } from "vitest";
import { checkLocatorPatterns } from "./locatorLint.js";

describe("checkLocatorPatterns", () => {
  it("reports ok:true when no file contains .or_(", () => {
    const result = checkLocatorPatterns([
      { path: "pages/login_page.py", content: 'self.password_input = page.get_by_label("Contraseña")\n' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("reports ok:false with file and line number when .or_( appears", () => {
    const result = checkLocatorPatterns([
      {
        path: "pages/login_page.py",
        content:
          "class LoginPage:\n" +
          "    def __init__(self, page):\n" +
          '        self.password_input = page.get_by_placeholder("Your password").or_(page.get_by_label("Password"))\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:3:");
    expect(result.errors).toContain(".or_()");
  });

  it("only flags the offending file when multiple files are checked", () => {
    const result = checkLocatorPatterns([
      { path: "tests/test_login.py", content: "def test_login():\n    pass\n" },
      {
        path: "pages/login_page.py",
        content: 'self.x = page.get_by_role("button").or_(page.get_by_text("x"))\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:1:");
    expect(result.errors).not.toContain("tests/test_login.py");
  });

  it("reports every occurrence when the pattern appears more than once", () => {
    const result = checkLocatorPatterns([
      {
        path: "pages/login_page.py",
        content:
          'self.a = page.get_by_role("a").or_(page.get_by_text("a"))\n' +
          'self.b = page.get_by_role("b").or_(page.get_by_text("b"))\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:1:");
    expect(result.errors).toContain("pages/login_page.py:2:");
  });

  it("reproduces the real bug found testing against a live app (password toggle button collision)", () => {
    const buggyPageObject =
      "class LoginPage:\n" +
      "    def __init__(self, page):\n" +
      "        self.page = page\n" +
      '        self.password_input = page.get_by_placeholder("Your password").or_(page.get_by_label("Password"))\n' +
      "\n" +
      "    def login(self, email, password):\n" +
      "        self.password_input.fill(password)\n";

    const result = checkLocatorPatterns([{ path: "pages/login_page.py", content: buggyPageObject }]);
    expect(result.ok).toBe(false);
  });
});
