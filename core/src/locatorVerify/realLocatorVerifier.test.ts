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
  }
);
