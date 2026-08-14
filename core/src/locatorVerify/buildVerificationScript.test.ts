import { describe, it, expect } from "vitest";
import { buildVerificationScript } from "./buildVerificationScript.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

const files: GeneratedFile[] = [
  { path: "tests/test_login.py", content: "" },
  { path: "pages/login_page.py", content: "class LoginPage:\n    pass\n" },
];

describe("buildVerificationScript", () => {
  it("embeds the base URL, checks, and page object path as JSON literals", () => {
    const script = buildVerificationScript(
      files,
      [{ method: "get_button", argument: "Log In" }],
      "https://example.com"
    );

    expect(script).toContain('BASE_URL = "https://example.com"');
    expect(script).toContain('"method": "get_button"');
    expect(script).toContain('"argument": "Log In"');
    expect(script).toContain('PAGE_OBJECT_PATH = "pages/login_page.py"');
  });

  it("never calls an action method — only .count()/.all(), never .click()/.fill()/.check()", () => {
    const script = buildVerificationScript(files, [], "https://example.com");

    expect(script).toContain(".count()");
    expect(script).toContain(".all()");
    expect(script).not.toContain(".click(");
    expect(script).not.toContain(".fill(");
    expect(script).not.toContain(".check(");
    expect(script).not.toContain(".submit(");
  });

  it("always launches headless, regardless of any project headedMode preference", () => {
    const script = buildVerificationScript(files, [], "https://example.com");
    expect(script).toContain("headless=True");
  });

  it("navigates with the raw page directly, never through a Page Object goto() method", () => {
    const script = buildVerificationScript(files, [], "https://example.com");
    expect(script).toContain("page.goto(BASE_URL)");
  });

  it("uses an empty string for PAGE_OBJECT_PATH when no pages/ file is present", () => {
    const script = buildVerificationScript([{ path: "tests/test_x.py", content: "" }], [], "https://example.com");
    expect(script).toContain('PAGE_OBJECT_PATH = ""');
  });
});
