import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { FakeCodeChecker } from "../../codeCheck/testUtils.js";
import { FakeSiteExplorer } from "../../siteExplorer/testUtils.js";
import { evidenceCacheKey, writeCachedEvidence } from "../../siteExplorer/evidenceCache.js";
import { FakeLocatorVerifier } from "../../locatorVerify/testUtils.js";
import { chromium } from "playwright";
import { createRealSiteExplorer } from "../../siteExplorer/realSiteExplorer.js";
import { startFixtureApp, FIXTURE_CREDENTIALS, type FixtureApp } from "../../siteExplorer/testFixtureApp.js";
import { runGenerador, type GeneratorCallbacks } from "./runGenerador.js";
import type { Pattern } from "../../schemas/pattern.js";

const loginPattern: Pattern = {
  name: "login",
  description: "Inicio de sesión",
  gherkinTemplate: "Feature: Login\n",
  pageObjectTemplate: "class LoginPage:\n    pass\n",
};

const scriptedResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page
`;

function callbacks(overrides: Partial<GeneratorCallbacks> = {}): GeneratorCallbacks {
  return {
    offerSavePattern: vi.fn(),
    confirmOverwrite: vi.fn().mockResolvedValue(true),
    onExplorationStep: vi.fn(),
    onVerificationStep: vi.fn(),
    ...overrides,
  };
}

describe("runGenerador", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-rungenerador-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  async function writeFeature(content: string): Promise<string> {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "login.feature");
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("happy path: matched pattern, checker passes first try, writes files, never offers to save a pattern", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks();

    const { writtenPaths } = await runGenerador({
      featureFilePath,
      llm,
      patterns: [loginPattern],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    expect(writtenPaths).toHaveLength(2);
    expect(cb.offerSavePattern).not.toHaveBeenCalled();
    expect(
      await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")
    ).toContain("scenarios(");
  });

  it("no matched pattern: offers to save the pattern with the generated Page Object as its template", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({
      offerSavePattern: vi.fn().mockResolvedValue({ save: true, name: "checkout", description: "Flujo de compra" }),
    });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    expect(cb.offerSavePattern).toHaveBeenCalledWith("Feature: Checkout\n");
    const savedRaw = await fs.readFile(
      path.join(tmpProject, ".agente-qa", "templates", "checkout.json"),
      "utf-8"
    );
    const saved = JSON.parse(savedRaw);
    expect(saved.name).toBe("checkout");
    expect(saved.pageObjectTemplate).toContain("class LoginPage");
  });

  it("retries on checker failure, feeding the error back as feedback, up to 3 corrections, without re-exploring", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse, scriptedResponse, scriptedResponse]);
    const checker = new FakeCodeChecker([
      { ok: false, errors: "SyntaxError: line 1" },
      { ok: false, errors: "SyntaxError: line 2" },
      { ok: true },
    ]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    expect(checker.receivedCalls).toHaveLength(3);
    expect(explorer.receivedCalls).toHaveLength(1);
    const secondAttemptPrompt = llm.receivedCalls[1].find((m) => m.role === "user")?.content;
    expect(secondAttemptPrompt).toContain("SyntaxError: line 1");
    expect(secondAttemptPrompt).toContain("class LoginPage");
  });

  it("aborts without writing anything after 3 failed corrections (4 total attempts)", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse, scriptedResponse, scriptedResponse, scriptedResponse]);
    const checker = new FakeCodeChecker([
      { ok: false, errors: "e1" },
      { ok: false, errors: "e2" },
      { ok: false, errors: "e3" },
      { ok: false, errors: "e4" },
    ]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks();

    await expect(
      runGenerador({
        featureFilePath,
        llm,
        patterns: [],
        checker,
        explorer,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        appLanguage: "es",
        routes: {},
        credentials: undefined,
        verifier: new FakeLocatorVerifier([]),
        callbacks: cb,
      })
    ).rejects.toThrow(/4 intentos/);

    expect(cb.offerSavePattern).not.toHaveBeenCalled();
    const exists = await fs
      .access(path.join(tmpProject, "tests", "tests", "test_login.py"))
      .then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it("asks for overwrite confirmation when a target test file already exists, and honors a rejection", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    await fs.mkdir(path.join(tmpProject, "tests", "tests"), { recursive: true });
    await fs.writeFile(
      path.join(tmpProject, "tests", "tests", "test_login.py"),
      "# ya existente\n",
      "utf-8"
    );

    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ confirmOverwrite: vi.fn().mockResolvedValue(false) });

    await expect(
      runGenerador({
        featureFilePath,
        llm,
        patterns: [loginPattern],
        checker,
        explorer,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        appLanguage: "es",
        routes: {},
        credentials: undefined,
        verifier: new FakeLocatorVerifier([]),
        callbacks: cb,
      })
    ).rejects.toThrow(/Cancelado/);

    expect(await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")).toBe(
      "# ya existente\n"
    );
  });

  it("passes the feature's exact filename and slug to the code generator", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks();

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [loginPattern],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("features/login.feature");
    expect(promptContent).toContain("test_login.py");
    expect(promptContent).toContain("login_page.py");
  });

  it("sanitizes a multi-word feature filename into a valid Python module slug", async () => {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    const featureFilePath = path.join(dir, "recuperar-contrasena.feature");
    await fs.writeFile(featureFilePath, "Feature: Recuperar contraseña\n", "utf-8");

    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("test_recuperar_contrasena.py");
    expect(promptContent).toContain("recuperar_contrasena_page.py");
    expect(promptContent).toContain("features/recuperar-contrasena.feature");
  });

  it("aborts with a clear error and never calls the LLM when exploration fails", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: false, error: "ninguna ruta conocida respondió" }]);
    const cb = callbacks();

    await expect(
      runGenerador({
        featureFilePath,
        llm,
        patterns: [],
        checker,
        explorer,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        appLanguage: "es",
        routes: {},
        credentials: undefined,
        verifier: new FakeLocatorVerifier([]),
        callbacks: cb,
      })
    ).rejects.toThrow(/ninguna ruta conocida respondió/);

    expect(llm.receivedCalls).toHaveLength(0);
  });

  it("reuses the evidence cached by the intake instead of exploring again", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    await writeCachedEvidence(
      tmpProject,
      evidenceCacheKey({ appUrl: "https://example.com", patternName: "login", routes: {} }),
      [{ stepText: "cacheada", url: "https://example.com/login", ariaSnapshot: '- heading "Desde caché"' }]
    );
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([]); // no scripted result: exploring would fail
    const cb = callbacks();

    const { writtenPaths } = await runGenerador({
      featureFilePath,
      llm,
      patterns: [loginPattern],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    expect(writtenPaths).toHaveLength(2);
    expect(llm.lastPrompt()).toContain("Desde caché");
  });

  it("treats a cached-but-empty evidence array as a miss and explores instead of proceeding with no evidence", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    await writeCachedEvidence(
      tmpProject,
      evidenceCacheKey({ appUrl: "https://example.com", patternName: "login", routes: {} }),
      []
    );
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [{ stepText: "explorada de verdad", url: "https://example.com/login", ariaSnapshot: '- heading "Recién explorada"' }],
      },
    ]);
    const cb = callbacks();

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [loginPattern],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    expect(explorer.receivedCalls).toHaveLength(1);
    expect(llm.lastPrompt()).toContain("Recién explorada");
  });

  it("passes the explorer's real evidence into the code generation prompt", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [{ stepText: "pantalla de login", url: "https://example.com/login", ariaSnapshot: 'textbox "Email"' }],
      },
    ]);
    const cb = callbacks();

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [loginPattern],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("https://example.com/login");
    expect(promptContent).toContain('textbox "Email"');
  });

  it("passes whatever the explorer returns straight into the codegen prompt without filtering it — a pure pass-through, no redundant redaction layer", async () => {
    // This is an architectural-contract test, NOT a security regression test:
    // it proves runGenerador doesn't add a second, independent redaction layer
    // on top of the SiteExplorer's own (a second layer here could silently mask
    // a future regression in the real one and duplicate logic across modules).
    // It does NOT prove credentials are actually redacted end to end — a
    // FakeSiteExplorer bypasses createRealSiteExplorer entirely, so this test
    // would still pass even with the redaction fix in realSiteExplorer.ts fully
    // reverted. For that guarantee, see the gated end-to-end test below, which
    // drives the real explorer's fast path (real browser, real login, a
    // genuine credential leak into page.url()) all the way through to the
    // codegen prompt.
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [
          { stepText: "x", url: "https://example.com/login", ariaSnapshot: 'textbox "Password": s3cret-value' },
        ],
      },
    ]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("s3cret-value");
  });

  it("passes baseUrl, credentials, and headed:true through to the explorer", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: { username: "qa@example.com", password: "s3cret" },
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    expect(explorer.receivedCalls[0].baseUrl).toBe("https://example.com");
    expect(explorer.receivedCalls[0].credentials).toEqual({ username: "qa@example.com", password: "s3cret" });
    expect(explorer.receivedCalls[0].headed).toBe(true);
  });

  it("prepends the project's configured route for the matched pattern to the explorer's route candidates", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const patternWithHints: Pattern = {
      ...loginPattern,
      navigationHints: { routeCandidates: ["/login", "/signin"], requiresLogin: false },
    };
    const originalCandidates = [...patternWithHints.navigationHints!.routeCandidates];
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks();

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [patternWithHints],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: { login: "/acceso" },
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    const passedPattern = explorer.receivedCalls[0].matchedPattern;
    expect(passedPattern?.navigationHints?.routeCandidates).toEqual(["/acceso", "/login", "/signin"]);
    expect(patternWithHints.navigationHints?.routeCandidates).toEqual(originalCandidates);
  });

  it("does NOT synthesize navigationHints for a matched pattern that has none, even with a configured route", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    // loginPattern has no navigationHints at all — this is the shape of every
    // user-saved custom pattern (saveProjectPattern never sets one).
    expect(loginPattern.navigationHints).toBeUndefined();
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [loginPattern],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: { login: "/acceso" },
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    const passedPattern = explorer.receivedCalls[0].matchedPattern;
    expect(passedPattern?.navigationHints).toBeUndefined();
    expect(passedPattern).toEqual(loginPattern);
  });

  it("passes appLanguage and routes through to the code generation prompt", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "en",
      routes: { home: "/dashboard" },
      credentials: undefined,
      verifier: new FakeLocatorVerifier([]),
      callbacks: cb,
    });

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("inglés");
    expect(promptContent).toContain("/dashboard");
  });

  it("verifies extracted locators against the real app, passing the checks it found", async () => {
    const featureFilePath = await writeFeature(
      'Feature: Login\n  Scenario: x\n    Then debo ver un mensaje de error "Credenciales incorrectas"\n'
    );
    const responseWithGetMethod = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, then, parsers

scenarios("../features/login.feature")


@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page

    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;
    const llm = new FakeLLMProvider([responseWithGetMethod]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      callbacks: cb,
    });

    expect(verifier.receivedCalls).toHaveLength(1);
    expect(verifier.receivedCalls[0].checks).toEqual([
      { method: "get_error_message", argument: "Credenciales incorrectas" },
    ]);
  });

  it("verifies against all captured screens' URLs, not just the first, and not the raw baseUrl, when evidence is non-empty", async () => {
    const featureFilePath = await writeFeature(
      'Feature: Login\n  Scenario: x\n    Then debo ver un mensaje de error "Credenciales incorrectas"\n'
    );
    const responseWithGetMethod = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, then, parsers

scenarios("../features/login.feature")


@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page

    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;
    const llm = new FakeLLMProvider([responseWithGetMethod]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [
          { stepText: "pantalla de login", url: "https://example.com/login", ariaSnapshot: 'textbox "Email"' },
          {
            stepText: "pantalla tras login",
            url: "https://example.com/dashboard",
            ariaSnapshot: '- text: Credenciales incorrectas',
          },
        ],
      },
    ]);
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      callbacks: cb,
    });

    // A locator that's only visible after an action (e.g. an error message
    // shown on a later screen) must still be checked against the screen where
    // it actually appears — so every captured screen's URL is passed, not
    // just the first, and not the raw baseUrl.
    expect(verifier.receivedCalls[0].urls).toEqual([
      "https://example.com/login",
      "https://example.com/dashboard",
    ]);
  });

  it("falls back to the raw baseUrl for verification when the explorer returned no screens", async () => {
    const featureFilePath = await writeFeature(
      'Feature: Login\n  Scenario: x\n    Then debo ver un mensaje de error "Credenciales incorrectas"\n'
    );
    const responseWithGetMethod = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, then, parsers

scenarios("../features/login.feature")


@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page

    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;
    const llm = new FakeLLMProvider([responseWithGetMethod]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      callbacks: cb,
    });

    expect(verifier.receivedCalls[0].urls).toEqual(["https://example.com"]);
  });

  it("retries when the verifier rejects a locator, feeding its error back as feedback", async () => {
    const featureFilePath = await writeFeature(
      'Feature: Login\n  Scenario: x\n    Then debo ver un mensaje de error "Credenciales incorrectas"\n'
    );
    const responseWithGetMethod = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, then, parsers

scenarios("../features/login.feature")


@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page

    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;
    const llm = new FakeLLMProvider([responseWithGetMethod, responseWithGetMethod]);
    const checker = new FakeCodeChecker([{ ok: true }, { ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const verifier = new FakeLocatorVerifier([
      { ok: false, errors: "El locator get_error_message(...) resolvió a 2 elementos reales" },
      { ok: true },
    ]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      callbacks: cb,
    });

    expect(checker.receivedCalls).toHaveLength(2);
    expect(verifier.receivedCalls).toHaveLength(2);
    const secondAttemptPrompt = llm.receivedCalls[1].find((m) => m.role === "user")?.content;
    expect(secondAttemptPrompt).toContain("resolvió a 2 elementos reales");
  });

  it("surfaces verification warnings (e.g. a 0-element locator) via onVerificationStep without treating them as failures", async () => {
    const featureFilePath = await writeFeature(
      'Feature: Login\n  Scenario: x\n    Then debo ver un mensaje de error "Credenciales incorrectas"\n'
    );
    const responseWithGetMethod = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, then, parsers

scenarios("../features/login.feature")


@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page

    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;
    const llm = new FakeLLMProvider([responseWithGetMethod]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const verifier = new FakeLocatorVerifier([
      { ok: true, warnings: "El locator get_error_message(...) no se encontró en la pantalla inicial (0 elementos)" },
    ]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      callbacks: cb,
    });

    expect(cb.onVerificationStep).toHaveBeenCalledWith(
      expect.stringContaining("no se encontró en la pantalla inicial")
    );
    // Must not have retried or thrown — a warning-only result is a success.
    expect(llm.receivedCalls).toHaveLength(1);
    expect(verifier.receivedCalls).toHaveLength(1);
  });

  it("skips verification entirely (never calls the verifier) when extraction finds no checks", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const verifier = new FakeLocatorVerifier([]);
    const cb = callbacks();

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [loginPattern],
      checker,
      explorer,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      callbacks: cb,
    });

    expect(verifier.receivedCalls).toHaveLength(0);
  });

  it("surfaces unverifiable literals via onVerificationStep instead of failing silently", async () => {
    const featureFilePath = await writeFeature(
      'Feature: Login\n  Scenario: x\n    Then debo ver un mensaje de error "Credenciales incorrectas"\n'
    );
    const responseWithUntracedParam = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, then, parsers

scenarios("../features/login.feature")


@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    mensaje_normalizado = mensaje_error.strip()
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_normalizado)
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page

    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;
    const llm = new FakeLLMProvider([responseWithUntracedParam]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const verifier = new FakeLocatorVerifier([]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [],
      checker,
      explorer,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      callbacks: cb,
    });

    expect(verifier.receivedCalls).toHaveLength(0);
    expect(cb.onVerificationStep).toHaveBeenCalledWith(expect.stringContaining("no se pudieron verificar"));
  });

  it("aborts immediately, without retrying, when the feature expects a literal the app does not have", async () => {
    const featureFilePath = await writeFeature(
      '# agente-qa:pattern=login\nFeature: Login\n  Scenario: entrar\n    Then veo el título "Dream and Growth" en la pantalla de inicio\n'
    );
    const generated = `# FILE: tests/test_login.py
@then(parsers.re(r'veo el título "(?P<title>[^"]*)" en la pantalla de inicio'))
def veo_el_titulo(login_page, title):
    expect(login_page.get_heading(title)).to_be_visible()
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page

    def get_heading(self, title):
        return self.page.get_by_role("heading", name=title)
`;
    const llm = new FakeLLMProvider([generated, generated, generated, generated]);
    const checker = new FakeCodeChecker([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [
          {
            stepText: "tras iniciar sesión",
            url: "https://example.com/",
            ariaSnapshot: '- heading "Sueño y crecimiento" [level=1]',
          },
        ],
      },
    ]);
    const verifier = new FakeLocatorVerifier([]);
    const cb = callbacks();

    await expect(
      runGenerador({
        featureFilePath,
        llm,
        patterns: [loginPattern],
        checker,
        explorer,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        appLanguage: "es",
        routes: {},
        credentials: undefined,
        verifier,
        callbacks: cb,
      })
    ).rejects.toThrow(/Sueño y crecimiento/);

    // one LLM call only: retrying cannot change a literal that lives in the .feature
    expect(llm.callCount()).toBe(1);
    // nothing was written
    await expect(
      fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")
    ).rejects.toThrow();
  });

  it("verifies against every captured screen, not just the first", async () => {
    // Note: this uses a step definition with a traceable get_* call (unlike
    // the module-level `scriptedResponse` fixture, which has no step defs at
    // all and so extracts zero checks — extractLocatorChecks would never call
    // the verifier for it, making the assertion below untestable).
    const featureFilePath = await writeFeature(
      '# agente-qa:pattern=login\nFeature: Login\n  Scenario: x\n    Then veo el botón "Entrar"\n'
    );
    const responseWithGetMethod = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, then, parsers

scenarios("../features/login.feature")


@then(parsers.parse('veo el botón "{nombre_boton}"'))
def veo_el_boton(page, nombre_boton):
    login_page = LoginPage(page)
    login_page.get_button(nombre_boton)
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page

    def get_button(self, name):
        return self.page.get_by_role("button", name=name)
`;
    const llm = new FakeLLMProvider([responseWithGetMethod]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [
          { stepText: "login", url: "https://example.com/login", ariaSnapshot: '- button "Entrar"' },
          { stepText: "panel", url: "https://example.com/panel", ariaSnapshot: '- heading "Panel"' },
        ],
      },
    ]);
    const verifier = new FakeLocatorVerifier([{ ok: true }]);

    await runGenerador({
      featureFilePath,
      llm,
      patterns: [loginPattern],
      checker,
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      credentials: undefined,
      verifier,
      callbacks: callbacks(),
    });

    expect(verifier.receivedCalls.at(-1)?.urls).toEqual([
      "https://example.com/login",
      "https://example.com/panel",
    ]);
  });
});

async function hasChromium(): Promise<boolean> {
  try {
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const chromiumAvailable = await hasChromium();

describe.skipIf(!chromiumAvailable)(
  "runGenerador with the real SiteExplorer (requires Playwright Chromium installed) — end-to-end credential-leak regression guard",
  () => {
    let tmpProject: string;
    let app: FixtureApp;

    beforeEach(async () => {
      tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-rungenerador-e2e-"));
      app = await startFixtureApp("leaky");
    });

    afterEach(async () => {
      await fs.rm(tmpProject, { recursive: true, force: true });
      await app.close();
    });

    async function writeFeature(content: string): Promise<string> {
      const dir = path.join(tmpProject, "tests", "features");
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, "login.feature");
      await fs.writeFile(filePath, content, "utf-8");
      return filePath;
    }

    it("never lets a credential that leaked into page.url() during a real login reach the code-generation LLM prompt", async () => {
      // Drives the real fast path (createRealSiteExplorer, no mocks) against a
      // fixture whose native GET-method login form genuinely puts the password
      // in the URL on submit — the exact vector the Critical finding was about
      // (core/src/siteExplorer/realSiteExplorer.ts's captureEvidence/redaction).
      // The explorer's own LLM is never called here (the fast path succeeds via
      // navigationHints, no agentic escalation needed) — an empty FakeLLMProvider
      // makes that assumption fail loudly if it's ever wrong.
      const leakyPattern: Pattern = {
        name: "login",
        description: "login",
        gherkinTemplate: "Feature: Login\n",
        pageObjectTemplate: "",
        navigationHints: { routeCandidates: ["/leaky"], requiresLogin: true },
      };
      const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");

      const explorerLlm = new FakeLLMProvider([]);
      const explorer = createRealSiteExplorer(explorerLlm);
      const codegenLlm = new FakeLLMProvider([scriptedResponse]);
      const checker = new FakeCodeChecker([{ ok: true }]);
      const cb = callbacks();

      await runGenerador({
        featureFilePath,
        llm: codegenLlm,
        patterns: [leakyPattern],
        checker,
        explorer,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: app.url,
        appLanguage: "es",
        routes: {},
        credentials: FIXTURE_CREDENTIALS,
        verifier: new FakeLocatorVerifier([]),
        callbacks: cb,
      });

      expect(explorerLlm.receivedCalls).toHaveLength(0);
      const promptContent = codegenLlm.receivedCalls[0].find((m) => m.role === "user")?.content;
      expect(promptContent).not.toContain(FIXTURE_CREDENTIALS.password);
      expect(promptContent).not.toContain(FIXTURE_CREDENTIALS.username);
    }, 20000); // headed (visible) Chromium launch is slower than the headless real-browser tests elsewhere; runGenerador hardcodes headed: true.
  }
);
