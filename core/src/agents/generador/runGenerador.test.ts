import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { FakeCodeChecker } from "../../codeCheck/testUtils.js";
import { FakeSiteExplorer } from "../../siteExplorer/testUtils.js";
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
        callbacks: cb,
      })
    ).rejects.toThrow(/ninguna ruta conocida respondió/);

    expect(llm.receivedCalls).toHaveLength(0);
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
      callbacks: cb,
    });

    const passedPattern = explorer.receivedCalls[0].matchedPattern;
    expect(passedPattern?.navigationHints?.routeCandidates).toEqual(["/acceso", "/login", "/signin"]);
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
      callbacks: cb,
    });

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("inglés");
    expect(promptContent).toContain("/dashboard");
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
        callbacks: cb,
      });

      expect(explorerLlm.receivedCalls).toHaveLength(0);
      const promptContent = codegenLlm.receivedCalls[0].find((m) => m.role === "user")?.content;
      expect(promptContent).not.toContain(FIXTURE_CREDENTIALS.password);
      expect(promptContent).not.toContain(FIXTURE_CREDENTIALS.username);
    }, 20000); // headed (visible) Chromium launch is slower than the headless real-browser tests elsewhere; runGenerador hardcodes headed: true.
  }
);
