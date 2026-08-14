import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRealLocatorVerifier, MissingLocatorVerifierToolError, realLocatorVerifier } from "./realLocatorVerifier.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}

function pytestStackAvailable(pythonCmd: string): boolean {
  return spawnSync(pythonCmd, ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"]).status === 0;
}

const hasPython = commandExists("python");
const hasPytestStack = hasPython && pytestStackAvailable("python");

describe("realLocatorVerifier missing tool handling", () => {
  it("throws MissingLocatorVerifierToolError when the python command doesn't exist", async () => {
    const verifier = createRealLocatorVerifier({ pythonCommand: "agente-qa-definitely-missing-python" });
    await expect(verifier.verify([], [], "https://example.com", undefined)).rejects.toThrow(
      MissingLocatorVerifierToolError
    );
  });

  it("throws MissingLocatorVerifierToolError when pytest/pytest-bdd/pytest-playwright/pytest-html aren't importable", async () => {
    if (!hasPython || hasPytestStack) return; // can't reproduce "modules missing" without an interpreter that actually lacks them
    const verifier = createRealLocatorVerifier({ pythonCommand: "python" });
    await expect(verifier.verify([], [], "https://example.com", undefined)).rejects.toThrow(
      MissingLocatorVerifierToolError
    );
  });
});

const LOGIN_PAGE_OBJECT = `from playwright.sync_api import Page, Locator


class LoginPage:
    def __init__(self, page: Page):
        self.page = page

    def get_button(self, button_name: str) -> Locator:
        return self.page.get_by_role("button", name=button_name, exact=False)

    def click_button(self, button_name: str):
        self.get_button(button_name).click()
`;

function generatedFiles(): GeneratedFile[] {
  return [
    { path: "tests/test_login.py", content: "" },
    { path: "pages/login_page.py", content: LOGIN_PAGE_OBJECT },
  ];
}

describe.skipIf(!hasPytestStack)(
  "realLocatorVerifier (requires Python + pytest + pytest-bdd + pytest-playwright + pytest-html on PATH)",
  () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-locatorverify-e2e-"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("reports ok:false with a clear explanation when a locator resolves to 2 real elements", async () => {
      const htmlPath = path.join(tmpDir, "index.html");
      await fs.writeFile(
        htmlPath,
        "<!doctype html><html><body>" +
          '<button type="button">Log in</button>' +
          '<button type="submit">Log in</button>' +
          "</body></html>",
        "utf-8"
      );
      const baseUrl = pathToFileURL(htmlPath).toString();

      const result = await realLocatorVerifier.verify(
        generatedFiles(),
        [{ method: "get_button", argument: "Log in" }],
        baseUrl,
        undefined
      );

      expect(result.ok).toBe(false);
      expect(result.errors).toContain("get_button");
      expect(result.errors).toContain("2 elementos");
    }, 20000);

    it("reports ok:true when the locator resolves to exactly 1 real element", async () => {
      const htmlPath = path.join(tmpDir, "index.html");
      await fs.writeFile(
        htmlPath,
        "<!doctype html><html><body>" +
          '<button type="button">Menu</button>' +
          '<button type="submit">Log in</button>' +
          "</body></html>",
        "utf-8"
      );
      const baseUrl = pathToFileURL(htmlPath).toString();

      const result = await realLocatorVerifier.verify(
        generatedFiles(),
        [{ method: "get_button", argument: "Log in" }],
        baseUrl,
        undefined
      );

      expect(result).toEqual({ ok: true });
    }, 20000);

    it("returns ok:true immediately without launching a browser when there are no checks to verify", async () => {
      const result = await realLocatorVerifier.verify(generatedFiles(), [], "https://example.com", undefined);
      expect(result).toEqual({ ok: true });
    });

    it("reports ok:true with a warning (not a failure) when a locator resolves to 0 elements on the initial screen", async () => {
      // count === 0 is the NORMAL, EXPECTED result for a locator that only
      // appears after an action this harness never performs (e.g. an error
      // message shown only after a failed login submit) — it must not abort
      // generation the way a genuine 2+ ambiguity does.
      const htmlPath = path.join(tmpDir, "index.html");
      await fs.writeFile(
        htmlPath,
        "<!doctype html><html><body>" + '<button type="button">Menu</button>' + "</body></html>",
        "utf-8"
      );
      const baseUrl = pathToFileURL(htmlPath).toString();

      const result = await realLocatorVerifier.verify(
        generatedFiles(),
        [{ method: "get_button", argument: "Log in" }],
        baseUrl,
        undefined
      );

      expect(result.ok).toBe(true);
      expect(result.warnings).toContain("get_button");
      expect(result.warnings).toContain("0 elementos");
    }, 20000);

    it("throws MissingLocatorVerifierToolError (not a locator failure fed back to the LLM) when the script produces zero results and the output carries Playwright's browser-missing hint", async () => {
      // Real end-to-end reproduction, not a mocked RunResult: a Page Object
      // whose module-level code raises before any check can run drives the
      // generated script through the exact same "crash before printing any
      // JSON line" shape a genuinely missing chromium install produces
      // (chromium.launch() throwing before load_page_object_classes is even
      // reached) — parsedCount stays 0, and Playwright's own error text is
      // what's expected to land in stderr for a real missing-browser case.
      const htmlPath = path.join(tmpDir, "index.html");
      await fs.writeFile(
        htmlPath,
        "<!doctype html><html><body>" + '<button type="button">Log in</button>' + "</body></html>",
        "utf-8"
      );
      const baseUrl = pathToFileURL(htmlPath).toString();

      const brokenPageObject = `raise RuntimeError("Looks like Playwright was just installed or updated. Please run: playwright install")
`;
      const files: GeneratedFile[] = [
        { path: "tests/test_login.py", content: "" },
        { path: "pages/login_page.py", content: brokenPageObject },
      ];

      await expect(
        realLocatorVerifier.verify(files, [{ method: "get_button", argument: "Log in" }], baseUrl, undefined)
      ).rejects.toThrow(MissingLocatorVerifierToolError);
    }, 20000);

    it("lets one Page Object class with an incompatible constructor fail to instantiate without preventing another class's get_* method from being found and verified", async () => {
      // Same "one broken thing shouldn't crash the rest" failure class Task 6
      // already fixed once for the per-check loop, one level up: at
      // instantiation time, load_page_object_classes previously did
      // `instances = [cls(page) for cls in classes]` unconditionally — one
      // incompatible __init__ took down the whole script.
      const htmlPath = path.join(tmpDir, "index.html");
      await fs.writeFile(
        htmlPath,
        "<!doctype html><html><body>" + '<button type="button">Log in</button>' + "</body></html>",
        "utf-8"
      );
      const baseUrl = pathToFileURL(htmlPath).toString();

      const pageObjectWithOneBrokenClass = `from playwright.sync_api import Page, Locator


class BrokenHelper:
    def __init__(self, page: Page, extra_required_arg):
        self.page = page
        self.extra = extra_required_arg


class LoginPage:
    def __init__(self, page: Page):
        self.page = page

    def get_button(self, button_name: str) -> Locator:
        return self.page.get_by_role("button", name=button_name, exact=False)
`;
      const files: GeneratedFile[] = [
        { path: "tests/test_login.py", content: "" },
        { path: "pages/login_page.py", content: pageObjectWithOneBrokenClass },
      ];

      const result = await realLocatorVerifier.verify(
        files,
        [{ method: "get_button", argument: "Log in" }],
        baseUrl,
        undefined
      );

      expect(result).toEqual({ ok: true });
    }, 20000);
  }
);
