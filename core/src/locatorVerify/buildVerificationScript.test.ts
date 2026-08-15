import { describe, it, expect } from "vitest";
import { buildVerificationScript } from "./buildVerificationScript.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

const files: GeneratedFile[] = [
  { path: "tests/test_login.py", content: "" },
  { path: "pages/login_page.py", content: "class LoginPage:\n    pass\n" },
];

describe("buildVerificationScript", () => {
  it("embeds the urls, checks, and page object path as JSON literals", () => {
    const script = buildVerificationScript(
      files,
      [{ method: "get_button", argument: "Log In" }],
      ["https://example.com"]
    );

    expect(script).toContain('URLS = [\n  "https://example.com"\n]');
    expect(script).toContain('"method": "get_button"');
    expect(script).toContain('"argument": "Log In"');
    expect(script).toContain('PAGE_OBJECT_PATH = "pages/login_page.py"');
  });

  it("never calls an action method — only .count()/.all(), never .click()/.fill()/.check()", () => {
    const script = buildVerificationScript(files, [], ["https://example.com"]);

    expect(script).toContain(".count()");
    expect(script).toContain(".all()");
    expect(script).not.toContain(".click(");
    expect(script).not.toContain(".fill(");
    expect(script).not.toContain(".check(");
    expect(script).not.toContain(".submit(");
  });

  it("always launches headless, regardless of any project headedMode preference", () => {
    const script = buildVerificationScript(files, [], ["https://example.com"]);
    expect(script).toContain("headless=True");
  });

  it("navigates with the raw page directly, never through a Page Object goto() method, iterating over every url", () => {
    const script = buildVerificationScript(files, [], ["https://example.com"]);
    expect(script).toContain("for url in URLS:");
    expect(script).toContain('page.goto(url, wait_until="load")');
  });

  it("uses an empty string for PAGE_OBJECT_PATH when no pages/ file is present", () => {
    const script = buildVerificationScript([{ path: "tests/test_x.py", content: "" }], [], ["https://example.com"]);
    expect(script).toContain('PAGE_OBJECT_PATH = ""');
  });

  it("wraps each check's count/matches logic in a try/except so one crashing locator can't kill the rest of the loop", () => {
    const script = buildVerificationScript(files, [{ method: "get_button", argument: "Log In" }], ["https://example.com"]);

    expect(script).toContain("try:");
    expect(script).toContain("except Exception as e:");
  });

  it("wraps each Page Object class's instantiation individually, so one class with an incompatible __init__ can't crash the whole script before any check runs", () => {
    const script = buildVerificationScript(files, [], ["https://example.com"]);

    expect(script).toContain("for cls in classes:");
    expect(script).toContain("instances.append(cls(page))");
    expect(script).not.toContain("instances = [cls(page) for cls in classes]");
  });

  it("embeds every url to check against", () => {
    const script = buildVerificationScript(
      [{ path: "pages/x_page.py", content: "class X:\n    pass\n" }],
      [{ method: "get_heading", argument: "Panel" }],
      ["https://app.test/login", "https://app.test/dashboard"]
    );
    expect(script).toContain('"https://app.test/login"');
    expect(script).toContain('"https://app.test/dashboard"');
    expect(script).toContain("URLS =");
  });

  it("waits for networkidle with a short timeout instead of blocking on goto", () => {
    const script = buildVerificationScript([], [{ method: "get_x", argument: "y" }], ["https://app.test/"]);
    expect(script).toContain('wait_until="load"');
    expect(script).toContain("wait_for_load_state");
    expect(script).toContain("timeout=3000");
  });

  it("guards navigation with a try/except so a url that fails to load doesn't abort the whole run", () => {
    const script = buildVerificationScript([], [{ method: "get_x", argument: "y" }], ["https://app.test/a", "https://app.test/b"]);
    const gotoIndex = script.indexOf("page.goto(url");
    const precedingTry = script.lastIndexOf("try:", gotoIndex);
    expect(precedingTry).toBeGreaterThan(-1);
    expect(script.slice(precedingTry, gotoIndex)).not.toContain("except");

    const gotoExcept = script.indexOf("except Exception:", gotoIndex);
    const continueIndex = script.indexOf("continue", gotoExcept);
    const nextIdleWait = script.indexOf("wait_for_load_state", gotoIndex);
    expect(gotoExcept).toBeGreaterThan(-1);
    expect(continueIndex).toBeGreaterThan(gotoExcept);
    expect(continueIndex).toBeLessThan(nextIdleWait);
  });

  it("clears a previously recorded error once a later url resolves the same check without an exception", () => {
    const script = buildVerificationScript([], [{ method: "get_x", argument: "y" }], ["https://app.test/a", "https://app.test/b"]);
    expect(script).toContain('results[index].pop("error", None)');
  });
});
