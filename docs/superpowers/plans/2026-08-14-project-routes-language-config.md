# Rutas + idioma de la app bajo test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `AGENTE_QA_APP_URL` from `.env` into `config.json` (required), add project-level `appLanguage` (es/en, default es) and `routes` (named route map) to `config.json`, and thread both into the prompts and Site Explorer logic that Agente 1/2 already use — so the engine knows what language the real app's interface is in and where its known routes live, instead of always guessing in castellano and assuming the URL root is home.

**Architecture:** `ProjectConfigSchema` (`core/src/config/projectConfig.ts`) gains the three new fields; `init`/`config` (`runInit`) collects them via new `InitPrompts` methods. `appLanguage`/`routes` flow down through `runIntake`→`generateGherkin`→`gherkinGenerationPrompt` (Agente 1) and `runGenerador`→`generateCode`→`codeGenerationPrompt` (Agente 2) as plain parameters — no new modules, no LLM call added anywhere that doesn't already make one. `runGenerador`'s already-flagged 10-positional-parameter signature is refactored to a single options object as part of this work, since two more parameters would make it worse.

**Tech Stack:** TypeScript, Zod, Vitest, `@inquirer/prompts` — same stack as the rest of `core`/`cli`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-project-routes-language-config-design.md`

## Global Constraints

- `core/src` never does terminal I/O — all human interaction crosses injected callbacks (`IntakeCallbacks`, `GeneratorCallbacks`, `InitPrompts`, etc.). Never add `console.*`/`readline` to `core`.
- DI stays explicit — functions receive `projectRoot` as a parameter, never read `process.cwd()`.
- Relative imports use a `.js` suffix even though the source file is `.ts` (ESM NodeNext).
- `cli`'s `tsc -p cli/tsconfig.json --noEmit` needs `core/dist/` built to resolve `@agente-qa/core` — run `npm run build --workspace=core` before checking `cli`'s typecheck whenever `core/src` changed. `npx vitest run` does NOT need this (it aliases straight to `core/src`).
- "Done" for each task = code + `npx tsc -p core/tsconfig.json --noEmit` clean + `npx tsc -p cli/tsconfig.json --noEmit` clean + `npx vitest run` green + commit.
- No LLM call anywhere inside `init`/`config` — confirmed decision, plain `inquirer` prompts only.
- `appUrl` migration is a clean cut: no fallback read of `AGENTE_QA_APP_URL` from `.env`, no migration code.
- User-facing CLI strings stay in castellano; code/identifiers/comments/commits in English (Conventional Commits).

---

## Task 1: Refactor `runGenerador` to accept an options object

**Files:**
- Modify: `core/src/agents/generador/runGenerador.ts`
- Modify: `core/src/index.ts`
- Modify: `cli/src/commands/generate.ts`
- Test: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Produces: `RunGeneradorOptions` (exported type) — `{ featureFilePath: string; llm: LLMProvider; patterns: Pattern[]; checker: CodeChecker; explorer: SiteExplorer; projectRoot: string; testsDir: string; baseUrl: string; credentials: ExplorationCredentials | undefined; callbacks: GeneratorCallbacks }`; `runGenerador(options: RunGeneradorOptions): Promise<{ writtenPaths: string[] }>`.

This is a pure refactor — same behavior, same 10 pieces of data, just grouped into one object instead of 10 positional parameters (already flagged as a maintainability smell in `memory.md`, about to get 2 more parameters in Task 7 — fix the shape before making it worse).

- [ ] **Step 1: Rewrite `runGenerador.ts` to take a single options object**

Replace the current signature and its destructuring at the top of the function body:

```ts
export interface RunGeneradorOptions {
  featureFilePath: string;
  llm: LLMProvider;
  patterns: Pattern[];
  checker: CodeChecker;
  explorer: SiteExplorer;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  credentials: ExplorationCredentials | undefined;
  callbacks: GeneratorCallbacks;
}

export async function runGenerador(options: RunGeneradorOptions): Promise<{ writtenPaths: string[] }> {
  const {
    featureFilePath,
    llm,
    patterns,
    checker,
    explorer,
    projectRoot,
    testsDir,
    baseUrl,
    credentials,
    callbacks,
  } = options;

  const featureText = await fs.readFile(featureFilePath, "utf-8");
  const matchedPatternName = parseFeatureHeader(featureText);
  const matchedPattern = matchedPatternName
    ? (patterns.find((p) => p.name === matchedPatternName) ?? null)
    : null;

  const featureFileName = path.basename(featureFilePath);
  const naming = { slug: toPythonModuleSlug(featureFileName.replace(/\.feature$/, "")), featureFileName };

  const exploration = await explorer.explore(
    { featureText, matchedPattern, baseUrl, credentials, headed: true },
    callbacks.onExplorationStep
  );
  if (!exploration.ok) {
    throw new Error(`No se pudo verificar la aplicación real antes de generar el código: ${exploration.error}`);
  }
  const evidence = exploration.screens;

  let retry: { previousFiles: GeneratedFile[]; feedback: string } | undefined;
  let files: GeneratedFile[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    files = await generateCode(featureText, llm, matchedPattern, naming, evidence, retry);
    const result = await checker.check(files);
    if (result.ok) break;

    const errors = result.errors ?? "Error desconocido de verificación de código.";
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`El código generado no pasó la verificación tras ${MAX_ATTEMPTS} intentos. Último error:\n${errors}`);
    }
    retry = { previousFiles: files, feedback: errors };
  }

  for (const file of files) {
    if (await testFileExists(projectRoot, testsDir, file.path)) {
      const targetPath = testFilePath(projectRoot, testsDir, file.path);
      const overwrite = await callbacks.confirmOverwrite(targetPath);
      if (!overwrite) {
        throw new Error(`Cancelado: ya existe ${targetPath} y no se sobrescribió.`);
      }
    }
  }

  const writtenPaths = await writeTestFiles(projectRoot, testsDir, files);

  if (!matchedPattern) {
    const pageObjectFile = files.find((f) => f.path.startsWith("pages/"));
    const saveDecision = await callbacks.offerSavePattern(featureText);
    if (saveDecision.save && saveDecision.name && saveDecision.description) {
      await saveProjectPattern(projectRoot, {
        name: saveDecision.name,
        description: saveDecision.description,
        gherkinTemplate: featureText,
        pageObjectTemplate: pageObjectFile?.content ?? "",
      });
    }
  }

  return { writtenPaths };
}
```

(The body is otherwise byte-for-byte identical to today's — only the signature and the destructuring block changed.)

- [ ] **Step 2: Export `RunGeneradorOptions` from the barrel**

In `core/src/index.ts`, change:

```ts
export { runGenerador } from "./agents/generador/runGenerador.js";
export type { GeneratorCallbacks } from "./agents/generador/runGenerador.js";
```

to:

```ts
export { runGenerador } from "./agents/generador/runGenerador.js";
export type { GeneratorCallbacks, RunGeneradorOptions } from "./agents/generador/runGenerador.js";
```

- [ ] **Step 3: Update the production call site in `cli/src/commands/generate.ts`**

Replace:

```ts
  const { writtenPaths } = await runGenerador(
    featureFilePath,
    llm,
    patterns,
    withCodeCheckerSpinner(realCodeChecker),
    explorer,
    projectRoot,
    projectConfig.testsDir,
    baseUrl,
    credentials,
    callbacks
  );
```

with:

```ts
  const { writtenPaths } = await runGenerador({
    featureFilePath,
    llm,
    patterns,
    checker: withCodeCheckerSpinner(realCodeChecker),
    explorer,
    projectRoot,
    testsDir: projectConfig.testsDir,
    baseUrl,
    credentials,
    callbacks,
  });
```

- [ ] **Step 4: Rewrite every call site in `runGenerador.test.ts` to the object form**

Replace the entire file with this content (identical tests, only the call syntax changed):

```ts
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
      credentials: { username: "qa@example.com", password: "s3cret" },
      callbacks: cb,
    });

    expect(explorer.receivedCalls[0].baseUrl).toBe("https://example.com");
    expect(explorer.receivedCalls[0].credentials).toEqual({ username: "qa@example.com", password: "s3cret" });
    expect(explorer.receivedCalls[0].headed).toBe(true);
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
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run` — expect all PASS (behavior unchanged, only call syntax).
Run: `npm run build --workspace=core && npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit` — expect clean.

- [ ] **Step 6: Commit**

```bash
git add core/src/agents/generador/runGenerador.ts core/src/agents/generador/runGenerador.test.ts core/src/index.ts cli/src/commands/generate.ts
git commit -m "refactor(core): change runGenerador to accept a single options object

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Add `appLanguage` and `routes` to `ProjectConfigSchema` (additive, defaulted)

**Files:**
- Modify: `core/src/config/projectConfig.ts`
- Test: `core/src/config/projectConfig.test.ts`
- Test: `cli/src/commands/init.test.ts`

**Interfaces:**
- Produces: `ProjectConfig` gains `appLanguage: "es" | "en"` (default `"es"`) and `routes: Record<string, string>` (default `{}`).

This is purely additive — every existing caller of `saveProjectConfig` that omits these fields gets the defaults, so nothing breaks. `appUrl` is NOT added here (that's the breaking change, isolated to Task 3).

- [ ] **Step 1: Write the failing tests in `projectConfig.test.ts`**

Add these three tests inside the existing `describe("projectConfig", ...)` block, and update the two existing round-trip tests (their `toEqual` now needs the new defaulted fields):

```ts
  it("saves and loads project config round-trip, defaulting headedMode to false when omitted", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appLanguage: "es",
      routes: {},
    });
  });

  it("saves and loads headedMode: true when explicitly given", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", headedMode: true });
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: true,
      appLanguage: "es",
      routes: {},
    });
  });

  it("saves and loads an explicit appLanguage and routes", async () => {
    await saveProjectConfig(tmpProject, {
      testsDir: "tests",
      appLanguage: "en",
      routes: { home: "/", login: "/login" },
    });
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appLanguage: "en",
      routes: { home: "/", login: "/login" },
    });
  });

  it("rejects an invalid appLanguage value", async () => {
    await expect(
      saveProjectConfig(tmpProject, { testsDir: "tests", appLanguage: "fr" as never })
    ).rejects.toThrow();
  });
```

(These replace the two existing tests with the same names — same setup, updated expectation.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/config/projectConfig.test.ts`
Expected: the two round-trip tests FAIL (actual value has no `appLanguage`/`routes` keys); the two new tests FAIL (`appLanguage`/`routes` not accepted or not defaulted).

- [ ] **Step 3: Add the fields to the schema**

In `core/src/config/projectConfig.ts`, change:

```ts
export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
  headedMode: z.boolean().default(false),
});
```

to:

```ts
export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
  headedMode: z.boolean().default(false),
  appLanguage: z.enum(["es", "en"]).default("es"),
  routes: z.record(z.string()).default({}),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run core/src/config/projectConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the ripple in `cli/src/commands/init.test.ts`**

`runInit` calls `saveProjectConfig` with just `{ testsDir, headedMode }` — Zod now fills in `appLanguage`/`routes` defaults, so the two exact-equality assertions there break the same way. Update them:

Replace:
```ts
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests", headedMode: false });
```
(first occurrence, in `"saves the project config from the prompt answers"`) with:
```ts
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appLanguage: "es",
      routes: {},
    });
```

Replace:
```ts
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests", headedMode: true });
```
(in `"saves headedMode: true when the user confirms it"`) with:
```ts
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: true,
      appLanguage: "es",
      routes: {},
    });
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add core/src/config/projectConfig.ts core/src/config/projectConfig.test.ts cli/src/commands/init.test.ts
git commit -m "feat(core): add appLanguage and routes fields to ProjectConfig

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Move `appUrl` from `.env` to `config.json` (required)

**Files:**
- Modify: `core/src/config/projectConfig.ts`
- Modify: `core/src/config/projectEnv.ts`
- Modify: `core/src/prompts/types.ts` → actually `cli/src/prompts/types.ts`
- Modify: `cli/src/prompts/inquirerPrompts.ts`
- Modify: `cli/src/commands/init.ts`
- Modify: `cli/src/commands/generate.ts`
- Modify: `cli/src/commands/execute.ts`
- Test: `core/src/config/projectConfig.test.ts`
- Test: `core/src/config/projectEnv.test.ts`
- Test: `cli/src/commands/init.test.ts`
- Test: `cli/src/commands/generate.test.ts`
- Test: `cli/src/commands/execute.test.ts`
- Test: `cli/src/commands/chat.test.ts`
- Test: `cli/src/commands/reports.test.ts`
- Test: `cli/src/commands/generate.e2e.test.ts`
- Test: `cli/src/commands/execute.e2e.test.ts`
- Test: `cli/src/commands/chat.e2e.test.ts`
- Test: `cli/src/commands/reports.e2e.test.ts`

**Interfaces:**
- Produces: `ProjectConfig.appUrl: string` (required, URL-validated); `requireAppUrl(config: ProjectConfig): string` and `testEnvVars(config: ProjectConfig, env: ProjectEnv): Record<string, string>`, both now living in `core/src/config/projectConfig.ts` (moved from `projectEnv.ts`, same exported names).
- Consumes: `ProjectEnv` type from `./projectEnv.js` (for `testEnvVars`'s second parameter).

This is the breaking change the spec calls out: because `appUrl` becomes required with no default, **every** place in the repo that builds a `ProjectConfig` (production code and tests alike) must supply it in the same commit, or `tsc`/`vitest` go red. This task is large because that ripple is real, not because the feature itself is complex — do all the steps below before running the final verification.

- [ ] **Step 1: Write the failing schema test**

Add to `projectConfig.test.ts`, and update the 3 existing `saveProjectConfig(tmpProject, { testsDir: "tests"[, ...] })` calls from Task 2 to include `appUrl: "https://example.com"` (both in the input and the expected `toEqual` output):

```ts
  it("rejects a config with no appUrl", async () => {
    await expect(saveProjectConfig(tmpProject, { testsDir: "tests" } as never)).rejects.toThrow();
  });

  it("rejects an appUrl that isn't a valid URL", async () => {
    await expect(
      saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "not-a-url" })
    ).rejects.toThrow();
  });
```

Update the 4 existing tests from Task 2 (`"saves and loads project config round-trip..."`, `"saves and loads headedMode: true..."`, `"saves and loads an explicit appLanguage and routes"`, and the original `"writes the file at..."`/`"rejects and does not write the file when testsDir is empty"` tests) to pass `appUrl: "https://example.com"` in every `saveProjectConfig` call and include it in every expected `toEqual` object. For example:

```ts
  it("saves and loads project config round-trip, defaulting headedMode to false when omitted", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
    });
  });
```

Apply the same `appUrl: "https://example.com"` addition (input + expected output) to `"saves and loads headedMode: true when explicitly given"` and `"saves and loads an explicit appLanguage and routes"`. The `"writes the file at..."` and `"rejects and does not write the file when testsDir is empty"` tests only need `appUrl: "https://example.com"` added to their `saveProjectConfig` input (they don't assert the full loaded shape).

- [ ] **Step 2: Write the failing `requireAppUrl`/`testEnvVars` tests**

Add to `projectConfig.test.ts`, inside `describe("projectConfig", ...)`:

```ts
  describe("requireAppUrl", () => {
    it("returns the configured appUrl", () => {
      expect(
        requireAppUrl({ testsDir: "tests", headedMode: false, appUrl: "https://mi-app.com", appLanguage: "es", routes: {} })
      ).toBe("https://mi-app.com");
    });
  });

  describe("testEnvVars", () => {
    const config = { testsDir: "tests", headedMode: false, appUrl: "https://mi-app.com", appLanguage: "es" as const, routes: {} };

    it("maps appUrl and present test credentials to their AGENTE_QA_* names", () => {
      expect(testEnvVars(config, { appUrl: undefined, testUsername: "qa", testPassword: "pwd", llmProvider: undefined, llmApiKey: undefined, llmBaseURL: undefined, llmModel: undefined })).toEqual({
        AGENTE_QA_APP_URL: "https://mi-app.com",
        AGENTE_QA_TEST_USERNAME: "qa",
        AGENTE_QA_TEST_PASSWORD: "pwd",
      });
    });

    it("omits absent test credentials entirely rather than including them as empty strings", () => {
      expect(testEnvVars(config, { appUrl: undefined, testUsername: undefined, testPassword: undefined, llmProvider: undefined, llmApiKey: undefined, llmBaseURL: undefined, llmModel: undefined })).toEqual({
        AGENTE_QA_APP_URL: "https://mi-app.com",
      });
    });
  });
```

Add the corresponding imports at the top of `projectConfig.test.ts`:

```ts
import { saveProjectConfig, loadProjectConfig, projectConfigPath, requireAppUrl, testEnvVars } from "./projectConfig.js";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run core/src/config/projectConfig.test.ts`
Expected: FAIL — `appUrl` not in schema yet, `requireAppUrl`/`testEnvVars` not exported from this module yet.

- [ ] **Step 4: Update the schema and add the moved functions in `projectConfig.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProjectEnv } from "./projectEnv.js";

export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
  headedMode: z.boolean().default(false),
  appUrl: z.string().url(),
  appLanguage: z.enum(["es", "en"]).default("es"),
  routes: z.record(z.string()).default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "config.json");
}

export async function saveProjectConfig(
  projectRoot: string,
  config: z.input<typeof ProjectConfigSchema>
): Promise<void> {
  const parsed = ProjectConfigSchema.parse(config);
  const filePath = projectConfigPath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig | null> {
  try {
    const raw = await fs.readFile(projectConfigPath(projectRoot), "utf-8");
    return ProjectConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function requireAppUrl(config: ProjectConfig): string {
  return config.appUrl;
}

export function testEnvVars(config: ProjectConfig, env: ProjectEnv): Record<string, string> {
  const vars: Record<string, string> = { AGENTE_QA_APP_URL: config.appUrl };
  if (env.testUsername) vars.AGENTE_QA_TEST_USERNAME = env.testUsername;
  if (env.testPassword) vars.AGENTE_QA_TEST_PASSWORD = env.testPassword;
  return vars;
}
```

- [ ] **Step 5: Run `projectConfig.test.ts` to verify it passes**

Run: `npx vitest run core/src/config/projectConfig.test.ts`
Expected: PASS.

- [ ] **Step 6: Remove `appUrl`/`requireAppUrl`/`testEnvVars` from `projectEnv.ts`**

In `core/src/config/projectEnv.ts`:

- Remove `appUrl: z.string().url().optional(),` from `ProjectEnvSchema`.
- Remove `appUrl: "AGENTE_QA_APP_URL",` from `ENV_VAR_KEYS`.
- Remove the `appUrl: nonEmpty(ENV_VAR_KEYS.appUrl),` line from the `candidate` object inside `loadProjectEnv`.
- Remove the `# ── Aplicación bajo test ──...` / `AGENTE_QA_APP_URL=` block from `ENV_TEMPLATE` (the 4 lines from `# ── Aplicación bajo test` through the blank line before `# Usuario y contraseña...`), leaving the "Usuario y contraseña de prueba" section as the first content block after the header comment.
- Delete the entire `requireAppUrl` function.
- Delete the entire `testEnvVars` function.

- [ ] **Step 7: Update `projectEnv.test.ts`**

Remove the `requireAppUrl` and `testEnvVars` `describe` blocks entirely (moved to `projectConfig.test.ts` in Step 2 above). Remove `requireAppUrl`, `testEnvVars` from the import at the top of the file.

`ProjectEnv` no longer has an `appUrl` field, so every `blank`-style fixture object in this file that includes `appUrl: undefined,` needs that line removed. There are two such places:

Inside `describe("requireLlmConfig", ...)`, replace:
```ts
    const blank = {
      appUrl: undefined,
      testUsername: undefined,
      testPassword: undefined,
      llmProvider: undefined,
      llmApiKey: undefined,
      llmBaseURL: undefined,
      llmModel: undefined,
    };
```
with:
```ts
    const blank = {
      testUsername: undefined,
      testPassword: undefined,
      llmProvider: undefined,
      llmApiKey: undefined,
      llmBaseURL: undefined,
      llmModel: undefined,
    };
```

Inside `describe("loadProjectEnv", ...)`'s `"returns all-undefined fields when the file exists but is the blank template"` test, replace:
```ts
      expect(await loadProjectEnv(tmpProject)).toEqual({
        appUrl: undefined,
        testUsername: undefined,
        testPassword: undefined,
        llmProvider: undefined,
        llmApiKey: undefined,
        llmBaseURL: undefined,
        llmModel: undefined,
      });
```
with:
```ts
      expect(await loadProjectEnv(tmpProject)).toEqual({
        testUsername: undefined,
        testPassword: undefined,
        llmProvider: undefined,
        llmApiKey: undefined,
        llmBaseURL: undefined,
        llmModel: undefined,
      });
```

Replace the `"creates the .env template..."` test's assertion:
```ts
      expect(envContent).toContain("AGENTE_QA_APP_URL=");
```
— delete this line entirely (the rest of that test, checking `AGENTE_QA_LLM_API_KEY=`, stays).

Replace the `"parses filled-in values"` test:
```ts
    it("parses filled-in values", async () => {
      await writeEnv({
        AGENTE_QA_APP_URL: "https://staging.mi-app.com",
        AGENTE_QA_TEST_USERNAME: "qa-tester@mi-app.com",
        AGENTE_QA_TEST_PASSWORD: "Sup3rSecreta!",
        AGENTE_QA_LLM_PROVIDER: "anthropic",
        AGENTE_QA_LLM_API_KEY: "sk-ant-test",
      });

      expect(await loadProjectEnv(tmpProject)).toEqual({
        appUrl: "https://staging.mi-app.com",
        testUsername: "qa-tester@mi-app.com",
        testPassword: "Sup3rSecreta!",
        llmProvider: "anthropic",
        llmApiKey: "sk-ant-test",
        llmBaseURL: undefined,
        llmModel: undefined,
      });
    });
```
with:
```ts
    it("parses filled-in values", async () => {
      await writeEnv({
        AGENTE_QA_TEST_USERNAME: "qa-tester@mi-app.com",
        AGENTE_QA_TEST_PASSWORD: "Sup3rSecreta!",
        AGENTE_QA_LLM_PROVIDER: "anthropic",
        AGENTE_QA_LLM_API_KEY: "sk-ant-test",
      });

      expect(await loadProjectEnv(tmpProject)).toEqual({
        testUsername: "qa-tester@mi-app.com",
        testPassword: "Sup3rSecreta!",
        llmProvider: "anthropic",
        llmApiKey: "sk-ant-test",
        llmBaseURL: undefined,
        llmModel: undefined,
      });
    });
```

Replace the `"treats a whitespace-only value as absent"` test (it used the now-removed `appUrl` field to exercise the `nonEmpty()` trimming behavior — rewrite it against `testUsername` instead, so the coverage of that behavior isn't lost):
```ts
    it("treats a whitespace-only value as absent", async () => {
      await writeEnv({ AGENTE_QA_APP_URL: "   " });

      expect((await loadProjectEnv(tmpProject))?.appUrl).toBeUndefined();
    });
```
with:
```ts
    it("treats a whitespace-only value as absent", async () => {
      await writeEnv({ AGENTE_QA_TEST_USERNAME: "   " });

      expect((await loadProjectEnv(tmpProject))?.testUsername).toBeUndefined();
    });
```

Delete the `"throws a clear error naming AGENTE_QA_APP_URL when it's present but not a valid URL"` test entirely (that field no longer exists in `ProjectEnvSchema`; the equivalent URL-validation coverage for `appUrl` now lives in `projectConfig.test.ts`, added in Step 1).

In the two file-permission tests under `describe.skipIf(process.platform === "win32")("file permissions (POSIX only)", ...)` and the `"writes the .gitignore even when .env already existed..."` test, leave the literal `"AGENTE_QA_APP_URL=https://mi-app.com\n"` fixture content exactly as-is — those tests exercise byte-for-byte file preservation and permission bits, not field parsing, so the sentinel text is unrelated to this change and doesn't need to change.

- [ ] **Step 8: Run `projectEnv.test.ts` and `projectConfig.test.ts`**

Run: `npx vitest run core/src/config/projectEnv.test.ts core/src/config/projectConfig.test.ts`
Expected: PASS.

- [ ] **Step 9: Add `inputAppUrl` to `InitPrompts` and wire it into `runInit`**

In `cli/src/prompts/types.ts`, change:
```ts
export interface InitPrompts {
  inputTestsDir(): Promise<string>;
  confirmHeadedMode(): Promise<boolean>;
  selectGitignoreEntries(candidates: string[]): Promise<string[]>;
}
```
to:
```ts
export interface InitPrompts {
  inputTestsDir(): Promise<string>;
  confirmHeadedMode(): Promise<boolean>;
  inputAppUrl(): Promise<string>;
  selectGitignoreEntries(candidates: string[]): Promise<string[]>;
}
```

In `cli/src/prompts/inquirerPrompts.ts`, add to `realInitPrompts` (between `confirmHeadedMode` and `selectGitignoreEntries`):
```ts
  async inputAppUrl() {
    return input({
      message: "¿Cuál es la URL de la aplicación que vas a probar?",
      validate: (value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return "Introduce una URL válida (ej. https://mi-app.com)";
        }
      },
    });
  },
```

In `cli/src/commands/init.ts`, change:
```ts
export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  const headedMode = await prompts.confirmHeadedMode();
  await saveProjectConfig(projectRoot, { testsDir, headedMode });
```
to:
```ts
export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  const headedMode = await prompts.confirmHeadedMode();
  const appUrl = await prompts.inputAppUrl();
  await saveProjectConfig(projectRoot, { testsDir, headedMode, appUrl });
```

- [ ] **Step 10: Update `init.test.ts`**

Add `inputAppUrl: async () => "https://example.com"` to the `prompts()` helper's defaults:
```ts
function prompts(overrides: Partial<InitPrompts> = {}): InitPrompts {
  return {
    inputTestsDir: async () => "tests",
    confirmHeadedMode: async () => false,
    inputAppUrl: async () => "https://example.com",
    selectGitignoreEntries: async (candidates) => candidates,
    ...overrides,
  };
}
```

Update the two `toEqual` assertions from Task 2 to include `appUrl: "https://example.com"`:
```ts
  it("saves the project config from the prompt answers", async () => {
    await runInit(prompts(), tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
    });
  });

  it("saves headedMode: true when the user confirms it", async () => {
    await runInit(prompts({ confirmHeadedMode: async () => true }), tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: true,
      appUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
    });
  });
```

- [ ] **Step 11: Run `init.test.ts`**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: PASS.

- [ ] **Step 12: Switch `generate.ts` and `execute.ts` to the config-based `appUrl`/`testEnvVars`**

In `cli/src/commands/generate.ts`, remove `requireAppUrl` from the `@agente-qa/core` import list and change:
```ts
  const llmCredentials = requireLlmConfig(env, projectEnvPath(projectRoot));
  const baseUrl = requireAppUrl(env, projectEnvPath(projectRoot));

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
```
to:
```ts
  const llmCredentials = requireLlmConfig(env, projectEnvPath(projectRoot));

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const baseUrl = requireAppUrl(projectConfig);
```
`requireAppUrl` stays in the `@agente-qa/core` import list unchanged (still the same exported name, just re-exported from a different internal module now). `projectEnvPath` was only used in that one removed call — remove it from the import list, since `requireLlmConfig(env, projectEnvPath(projectRoot))` on the line above is the only other candidate use and it still needs it. Check the full import list after editing: `projectEnvPath` must stay if `requireLlmConfig`'s call still references it (it does, see the line above) — so no import removal is actually needed in `generate.ts`. (This is unlike `execute.ts` in the next step, where `projectEnvPath` truly becomes unused.)

In `cli/src/commands/execute.ts`, change:
```ts
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  requireAppUrl(env, projectEnvPath(projectRoot));
```
to:
```ts
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  requireAppUrl(projectConfig);
```
and change:
```ts
    testEnvVars(env)
```
to:
```ts
    testEnvVars(projectConfig, env)
```
(both inside the `runEjecutor(...)` call at the bottom of the function). Remove the now-unused `projectEnvPath` import if nothing else in the file uses it — check: `execute.ts` no longer needs `projectEnvPath` at all after this change, remove it from the `@agente-qa/core` import list.

- [ ] **Step 13: Fix every remaining test file that constructs a `ProjectConfig`**

**`cli/src/commands/generate.test.ts`:**

Remove the entire `"throws a clear error when AGENTE_QA_APP_URL isn't configured"` test (lines with `await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" }); await saveProjectConfig(tmpProject, { testsDir: "tests" }); ...`) — this scenario is no longer reachable: `saveProjectConfig` now rejects a missing `appUrl` at save time, so a `config.json` that exists but lacks `appUrl` can't be constructed through the public API anymore. The remaining "init hasn't been run yet" test already covers the "no config at all" case.

Update `BASE_ENV` to drop the now-nonexistent env var:
```ts
const BASE_ENV = {
  AGENTE_QA_LLM_PROVIDER: "anthropic",
  AGENTE_QA_LLM_API_KEY: "sk-test",
};
```

Add `appUrl: "https://example.com"` to the remaining 4 `saveProjectConfig(tmpProject, { testsDir: "tests" })` calls (in `"throws a clear error when there are no approved .feature files yet"`, `"lists feature files, generates code..."`, `"wraps the LLM provider..."`, and `"builds the site explorer..."`):
```ts
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
```

**`cli/src/commands/execute.test.ts`:**

Remove the entire `"throws a clear error naming AGENTE_QA_APP_URL when it's missing from the .env, without invoking the real test runner"` test — same reasoning as above, this state is no longer reachable.

For the remaining 6 `saveProjectConfig(tmpProject, { testsDir: "tests"[, headedMode: true] })` calls, add `appUrl: "https://example.com"`:
```ts
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
```
(and `{ testsDir: "tests", headedMode: true, appUrl: "https://example.com" }` for the one test that also sets `headedMode: true`).

In the tests that follow their `saveProjectConfig` call with `await ensureProjectEnvTemplate(tmpProject);` and then `await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");` (the `"throws a clear error when there are no generated tests yet"`, `"runs through the fake prompts..."`, `"defaults to headless..."`, `"passes headed: true..."`, and `"wraps the real test runner..."` tests) — **delete the `fs.writeFile(projectEnvPath(...), "AGENTE_QA_APP_URL=...")` line** in each; `ensureProjectEnvTemplate(tmpProject)` alone is enough to make `.env` exist (which is all `loadProjectEnv` needs to return non-null), and the app URL now comes from `saveProjectConfig`'s `appUrl` field instead.

Rewrite `"passes the app URL and test credentials from the .env into the runner's env option"` (its whole premise — appUrl living in `.env` — changed):
```ts
  it("passes the app URL from config.json and test credentials from .env into the runner's env option", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://staging.mi-app.com" });
    await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
    await fs.writeFile(
      projectEnvPath(tmpProject),
      "AGENTE_QA_TEST_USERNAME=qa\nAGENTE_QA_TEST_PASSWORD=pwd\n",
      "utf-8"
    );
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "Feature: Login\n", "utf-8");

    realTestRunnerRunMock.mockResolvedValue({ exitCode: 0 });

    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
    };

    await runExecuteTests(prompts, tmpProject);

    expect(realTestRunnerRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          AGENTE_QA_APP_URL: "https://staging.mi-app.com",
          AGENTE_QA_TEST_USERNAME: "qa",
          AGENTE_QA_TEST_PASSWORD: "pwd",
        },
      })
    );
  });
```

**`cli/src/commands/chat.test.ts`:** add `appUrl: "https://example.com"` to all 3 `saveProjectConfig(tmpProject, { testsDir: "tests" })` calls.

**`cli/src/commands/reports.test.ts`:** add `appUrl: "https://example.com"` to all 4 `saveProjectConfig(tmpProject, { testsDir: "tests" })` calls.

**`cli/src/commands/generate.e2e.test.ts`:** add `appUrl: "https://example.com"` to the `saveProjectConfig(tmpProject, { testsDir: "tests" })` call. Also remove `AGENTE_QA_APP_URL=https://example.com\n` from the raw `.env` content written just above it, leaving:
```ts
      await fs.writeFile(
        projectEnvPath(tmpProject),
        "AGENTE_QA_LLM_PROVIDER=anthropic\nAGENTE_QA_LLM_API_KEY=sk-test\n",
        "utf-8"
      );
      await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
```

**`cli/src/commands/execute.e2e.test.ts`:** replace
```ts
      await saveProjectConfig(tmpProject, { testsDir: "tests" });
      await ensureProjectEnvTemplate(tmpProject);
      // The sample pytest-bdd scenario below doesn't make any real network calls,
      // so this URL is only here to satisfy runExecuteTests' AGENTE_QA_APP_URL check.
      await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://example.com\n", "utf-8");
```
with
```ts
      await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
      await ensureProjectEnvTemplate(tmpProject);
```

**`cli/src/commands/chat.e2e.test.ts`:** add `appUrl: "https://example.com"` to the `saveProjectConfig(tmpProject, { testsDir: "tests" })` call (its `.env` content already has no `appUrl` line, nothing else to change there).

**`cli/src/commands/reports.e2e.test.ts`:** same fix as `execute.e2e.test.ts` — replace
```ts
      await saveProjectConfig(tmpProject, { testsDir: "tests" });
      await ensureProjectEnvTemplate(tmpProject);
      // The sample pytest-bdd scenario below doesn't make any real network calls,
      // so this URL is only here to satisfy runExecuteTests' AGENTE_QA_APP_URL check.
      await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://example.com\n", "utf-8");
```
with
```ts
      await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
      await ensureProjectEnvTemplate(tmpProject);
```

- [ ] **Step 14: Run the full suite and typecheck**

Run: `npm run build --workspace=core && npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: clean.
Run: `npx vitest run`
Expected: all PASS (e2e-gated tests either run green or skip, depending on local `python`/`ruff`/Chromium availability — same as before this change).

- [ ] **Step 15: Commit**

```bash
git add core/src/config/projectConfig.ts core/src/config/projectConfig.test.ts core/src/config/projectEnv.ts core/src/config/projectEnv.test.ts cli/src/prompts/types.ts cli/src/prompts/inquirerPrompts.ts cli/src/commands/init.ts cli/src/commands/init.test.ts cli/src/commands/generate.ts cli/src/commands/execute.ts cli/src/commands/generate.test.ts cli/src/commands/execute.test.ts cli/src/commands/chat.test.ts cli/src/commands/reports.test.ts cli/src/commands/generate.e2e.test.ts cli/src/commands/execute.e2e.test.ts cli/src/commands/chat.e2e.test.ts cli/src/commands/reports.e2e.test.ts
git commit -m "feat(core): move appUrl from .env to config.json, required

BREAKING CHANGE: AGENTE_QA_APP_URL is no longer read from .env. Run
'agente-qa init' (or the Configuración menu option) again to set the
app URL in config.json.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `init`/`config` asks for app language and known routes

**Files:**
- Modify: `cli/src/prompts/types.ts`
- Modify: `cli/src/prompts/inquirerPrompts.ts`
- Modify: `cli/src/commands/init.ts`
- Test: `cli/src/commands/init.test.ts`

**Interfaces:**
- Produces: `InitPrompts` gains `selectAppLanguage(): Promise<"es" | "en">`, `inputRoute(label: string): Promise<string>`, `promptAdditionalRoutes(): Promise<Record<string, string>>`.

This builds on Task 3's minimal `inputAppUrl` — purely additive to `runInit`, no schema change (Task 2 already added `appLanguage`/`routes` with defaults).

- [ ] **Step 1: Write the failing tests in `init.test.ts`**

Add `selectAppLanguage`, `inputRoute`, `promptAdditionalRoutes` defaults to the `prompts()` helper:
```ts
function prompts(overrides: Partial<InitPrompts> = {}): InitPrompts {
  return {
    inputTestsDir: async () => "tests",
    confirmHeadedMode: async () => false,
    inputAppUrl: async () => "https://example.com",
    selectAppLanguage: async () => "es",
    inputRoute: async () => "/",
    promptAdditionalRoutes: async () => ({}),
    selectGitignoreEntries: async (candidates) => candidates,
    ...overrides,
  };
}
```

Update the two `toEqual` assertions from Task 3 to include the new fields explicitly (they were relying on Zod defaults before; now `runInit` will pass explicit values):
```ts
  it("saves the project config from the prompt answers", async () => {
    await runInit(prompts(), tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appUrl: "https://example.com",
      appLanguage: "es",
      routes: { home: "/" },
    });
  });
```
(the second `"saves headedMode: true..."` test gets the same `appLanguage`/`routes` additions, with `headedMode: true`).

Add new tests:
```ts
  it("saves appLanguage: \"en\" when the user picks English", async () => {
    await runInit(prompts({ selectAppLanguage: async () => "en" }), tmpProject);

    expect((await loadProjectConfig(tmpProject))?.appLanguage).toBe("en");
  });

  it("asks for the home and login routes, and only saves login when it's non-empty", async () => {
    await runInit(
      prompts({
        inputRoute: async (label) => (label.includes("login") ? "/login" : "/"),
      }),
      tmpProject
    );

    expect((await loadProjectConfig(tmpProject))?.routes).toEqual({ home: "/", login: "/login" });
  });

  it("omits the login route when the user leaves it blank", async () => {
    await runInit(
      prompts({
        inputRoute: async (label) => (label.includes("login") ? "" : "/"),
      }),
      tmpProject
    );

    expect((await loadProjectConfig(tmpProject))?.routes).toEqual({ home: "/" });
  });

  it("merges extra routes from promptAdditionalRoutes into the saved config", async () => {
    await runInit(
      prompts({
        promptAdditionalRoutes: async () => ({ checkout: "/carrito", signup: "/registro" }),
      }),
      tmpProject
    );

    expect((await loadProjectConfig(tmpProject))?.routes).toEqual({
      home: "/",
      checkout: "/carrito",
      signup: "/registro",
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: FAIL — `InitPrompts` has no `selectAppLanguage`/`inputRoute`/`promptAdditionalRoutes` yet, `runInit` doesn't call them.

- [ ] **Step 3: Add the methods to `InitPrompts`**

In `cli/src/prompts/types.ts`:
```ts
export interface InitPrompts {
  inputTestsDir(): Promise<string>;
  confirmHeadedMode(): Promise<boolean>;
  inputAppUrl(): Promise<string>;
  selectAppLanguage(): Promise<"es" | "en">;
  inputRoute(label: string): Promise<string>;
  promptAdditionalRoutes(): Promise<Record<string, string>>;
  selectGitignoreEntries(candidates: string[]): Promise<string[]>;
}
```

- [ ] **Step 4: Wire them into `runInit`**

In `cli/src/commands/init.ts`, change:
```ts
export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  const headedMode = await prompts.confirmHeadedMode();
  const appUrl = await prompts.inputAppUrl();
  await saveProjectConfig(projectRoot, { testsDir, headedMode, appUrl });
```
to:
```ts
export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  const headedMode = await prompts.confirmHeadedMode();
  const appUrl = await prompts.inputAppUrl();
  const appLanguage = await prompts.selectAppLanguage();
  const homeRoute = await prompts.inputRoute("página principal (home)");
  const loginRoute = await prompts.inputRoute("login");
  const extraRoutes = await prompts.promptAdditionalRoutes();
  const routes: Record<string, string> = { home: homeRoute, ...(loginRoute ? { login: loginRoute } : {}), ...extraRoutes };
  await saveProjectConfig(projectRoot, { testsDir, headedMode, appUrl, appLanguage, routes });
```

- [ ] **Step 5: Run `init.test.ts` to verify it passes**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement the real prompts in `inquirerPrompts.ts`**

Add to `realInitPrompts`, after `inputAppUrl`:
```ts
  async selectAppLanguage() {
    return select<"es" | "en">({
      message: "¿En qué idioma está la interfaz de la aplicación?",
      choices: [
        { name: "Español", value: "es" },
        { name: "Inglés", value: "en" },
      ],
      default: "es",
    });
  },
  async inputRoute(label) {
    return input({ message: `¿Cuál es la ruta de ${label}? (relativa, ej. /login — déjalo vacío si no lo sabes)`, default: label.includes("home") ? "/" : "" });
  },
  async promptAdditionalRoutes() {
    const routes: Record<string, string> = {};
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const addMore = await select<boolean>({
        message: Object.keys(routes).length === 0 ? "¿Quieres añadir alguna otra ruta?" : "¿Añadir otra ruta más?",
        choices: [
          { name: "No", value: false },
          { name: "Sí", value: true },
        ],
        default: false,
      });
      if (!addMore) break;
      const name = await input({ message: "Nombre de la ruta (ej. checkout, dashboard):" });
      const routePath = await input({ message: `¿Cuál es la ruta de "${name}"?` });
      routes[name] = routePath;
    }
    return routes;
  },
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm run build --workspace=core && npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: clean.
Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add cli/src/prompts/types.ts cli/src/prompts/inquirerPrompts.ts cli/src/commands/init.ts cli/src/commands/init.test.ts
git commit -m "feat(cli): ask for app language and known routes during init/config

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Thread `appLanguage` into Gherkin generation (Agente 1)

**Files:**
- Modify: `core/src/prompts/intake.ts`
- Modify: `core/src/agents/intake/gherkinGenerator.ts`
- Modify: `core/src/agents/intake/runIntake.ts`
- Test: `core/src/agents/intake/gherkinGenerator.test.ts`
- Test: `core/src/agents/intake/runIntake.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks (this is independent of Tasks 1–4's config plumbing; the CLI wiring that actually reads `projectConfig.appLanguage` happens in Task 8).
- Produces: `gherkinGenerationPrompt(text, matchedPattern, appLanguage: "es" | "en"): string`; `generateGherkin(text, llm, matchedPattern, appLanguage: "es" | "en")`; `runIntake(initialText, llm, patterns, projectRoot, testsDir, appLanguage: "es" | "en", callbacks)`.

- [ ] **Step 1: Write the failing tests in `gherkinGenerator.test.ts`**

Add a 4th argument `"es"` to every existing `generateGherkin(...)` call in the file (7 calls total — after `null` or `matchedPattern` as the 3rd argument). For example:
```ts
    const plan = await generateGherkin("probar login", llm, null, "es");
```

Add two new tests at the end of the `describe("generateGherkin", ...)` block:
```ts
  it("tells the model the app interface is in English when appLanguage is \"en\"", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    await generateGherkin("probar login", llm, null, "en");
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("inglés");
  });

  it("tells the model the app interface is in Spanish when appLanguage is \"es\"", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    await generateGherkin("probar login", llm, null, "es");
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("español");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/agents/intake/gherkinGenerator.test.ts`
Expected: FAIL — `generateGherkin` doesn't accept a 4th argument yet, the language phrase isn't in the prompt.

- [ ] **Step 3: Add `appLanguage` to `gherkinGenerationPrompt`**

In `core/src/prompts/intake.ts`, change:
```ts
export function gherkinGenerationPrompt(
  text: string,
  matchedPattern: { name: string; gherkinTemplate: string } | null
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este patrón conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos de la petición:

"""
${matchedPattern.gherkinTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el plan desde cero.";

  return `Eres un analista de QA. Escribe un plan de pruebas en formato Gherkin (Feature/Scenario/Given/When/Then, con tags como @smoke o @regression donde corresponda) para esta petición:

"""
${text}
"""

${patternSection}

Responde ÚNICAMENTE con el contenido completo del archivo .feature, empezando por la línea "Feature:". No incluyas explicaciones ni bloques de código markdown.`;
}
```
to:
```ts
export function gherkinGenerationPrompt(
  text: string,
  matchedPattern: { name: string; gherkinTemplate: string } | null,
  appLanguage: "es" | "en"
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este patrón conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos de la petición:

"""
${matchedPattern.gherkinTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el plan desde cero.";

  const languageLabel = appLanguage === "en" ? "inglés" : "español";
  const languageSection = `La interfaz real de la aplicación bajo test está en ${languageLabel}. Los textos visibles que menciones o esperes (botones, mensajes, etiquetas, validaciones) deben asumirse en ese idioma — no los traduzcas al castellano aunque el resto de esta conversación esté en castellano.`;

  return `Eres un analista de QA. Escribe un plan de pruebas en formato Gherkin (Feature/Scenario/Given/When/Then, con tags como @smoke o @regression donde corresponda) para esta petición:

"""
${text}
"""

${patternSection}

${languageSection}

Responde ÚNICAMENTE con el contenido completo del archivo .feature, empezando por la línea "Feature:". No incluyas explicaciones ni bloques de código markdown.`;
}
```

- [ ] **Step 4: Add `appLanguage` to `generateGherkin`**

In `core/src/agents/intake/gherkinGenerator.ts`, change:
```ts
export async function generateGherkin(
  text: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null
): Promise<GherkinPlan> {
  const raw = await llm.generate([
    { role: "system", content: "Eres un analista de QA experto en especificaciones Gherkin." },
    { role: "user", content: gherkinGenerationPrompt(text, matchedPattern) },
  ]);
```
to:
```ts
export async function generateGherkin(
  text: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null,
  appLanguage: "es" | "en"
): Promise<GherkinPlan> {
  const raw = await llm.generate([
    { role: "system", content: "Eres un analista de QA experto en especificaciones Gherkin." },
    { role: "user", content: gherkinGenerationPrompt(text, matchedPattern, appLanguage) },
  ]);
```

- [ ] **Step 5: Run `gherkinGenerator.test.ts` to verify it passes**

Run: `npx vitest run core/src/agents/intake/gherkinGenerator.test.ts`
Expected: PASS.

- [ ] **Step 6: Add `appLanguage` to `runIntake` and its tests**

In `core/src/agents/intake/runIntake.test.ts`, add a 6th argument `"es"` (before `callbacks`) to all 4 existing `runIntake(...)` calls. For example:
```ts
    const { plan, filePath } = await runIntake(
      "quiero probar el login",
      llm,
      [loginPattern],
      tmpProject,
      "tests",
      "es",
      callbacks
    );
```

Run: `npx vitest run core/src/agents/intake/runIntake.test.ts` — expect FAIL (too many arguments / `appLanguage` unused by `runIntake` yet).

In `core/src/agents/intake/runIntake.ts`, change:
```ts
export async function runIntake(
  initialText: string,
  llm: LLMProvider,
  patterns: Pattern[],
  projectRoot: string,
  testsDir: string,
  callbacks: IntakeCallbacks
): Promise<{ plan: GherkinPlan; filePath: string }> {
```
to:
```ts
export async function runIntake(
  initialText: string,
  llm: LLMProvider,
  patterns: Pattern[],
  projectRoot: string,
  testsDir: string,
  appLanguage: "es" | "en",
  callbacks: IntakeCallbacks
): Promise<{ plan: GherkinPlan; filePath: string }> {
```
and replace both occurrences of `generateGherkin(text, llm, matched)` with `generateGherkin(text, llm, matched, appLanguage)`.

- [ ] **Step 7: Run `runIntake.test.ts` to verify it passes**

Run: `npx vitest run core/src/agents/intake/runIntake.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm run build --workspace=core && npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: `cli` typecheck will now FAIL — `chat.ts` still calls `runIntake` with the old 6-argument shape. That call site is fixed in Task 8; for now, confirm `core`'s own typecheck and `npx vitest run` (which doesn't touch `cli`'s call site) are clean:
Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: clean.
Run: `npx vitest run core cli/src/commands/init.test.ts cli/src/commands/generate.test.ts cli/src/commands/reports.test.ts`
Expected: PASS (these don't call `runIntake`). `cli/src/commands/chat.test.ts`/`chat.e2e.test.ts` will fail to type/run until Task 8 — that's expected and fixed immediately next; do not skip ahead of Task 8.

- [ ] **Step 9: Commit**

```bash
git add core/src/prompts/intake.ts core/src/agents/intake/gherkinGenerator.ts core/src/agents/intake/gherkinGenerator.test.ts core/src/agents/intake/runIntake.ts core/src/agents/intake/runIntake.test.ts
git commit -m "feat(core): thread appLanguage into Gherkin generation prompt

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Thread `appLanguage` and `routes` into code generation (Agente 2)

**Files:**
- Modify: `core/src/prompts/generador.ts`
- Modify: `core/src/agents/generador/codeGenerator.ts`
- Test: `core/src/agents/generador/codeGenerator.test.ts`

**Interfaces:**
- Produces: `codeGenerationPrompt(featureText, matchedPattern, naming, evidence, appLanguage: "es" | "en", routes: Record<string, string>, retry?): string`; `generateCode(featureText, llm, matchedPattern, naming, evidence, appLanguage: "es" | "en", routes: Record<string, string>, retry?): Promise<GeneratedFile[]>`.

- [ ] **Step 1: Write the failing tests in `codeGenerator.test.ts`**

Add `"es"` and `{}` as the 6th/7th arguments (before any trailing `retry`) to every existing `generateCode(...)` call in the file (9 calls). For example:
```ts
    const files = await generateCode(featureText, llm, null, naming, [], "es", {});
```
and, for the two calls with `retry` (`generateCode(featureText, llm, null, naming, [], { previousFiles, feedback: ... })`):
```ts
    await generateCode(featureText, llm, null, naming, [], "es", {}, {
      previousFiles,
      feedback: "SyntaxError: unexpected token",
    });
```

Add four new tests at the end of `describe("generateCode", ...)`:
```ts
  it("tells the model the app interface is in English when appLanguage is \"en\"", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "en", {});
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("inglés");
  });

  it("tells the model the app interface is in Spanish by default", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("español");
  });

  it("includes the project's known home route when routes.home is provided", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", { home: "/dashboard" });
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("/dashboard");
  });

  it("omits the home route section entirely when routes.home isn't provided", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).not.toContain("página principal de la aplicación");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `appLanguage`/`routes` to `codeGenerationPrompt`**

In `core/src/prompts/generador.ts`, change the function signature and body:
```ts
export function codeGenerationPrompt(
  featureText: string,
  matchedPattern: { name: string; pageObjectTemplate: string } | null,
  naming: CodeGenerationNaming,
  evidence: CodeGenerationEvidence[],
  appLanguage: "es" | "en",
  routes: Record<string, string>,
  retry?: CodeGenerationRetry
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este esqueleto de Page Object conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos del feature:

"""
${matchedPattern.pageObjectTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el Page Object desde cero.";

  const evidenceSection =
    evidence.length > 0
      ? `Esto es lo que se ha comprobado de verdad en la aplicación real — usa estas rutas y estos nombres accesibles reales, no inventes otros:

${evidence
  .map((screen) => `### ${screen.stepText}\nURL real: ${screen.url}\n"""\n${screen.ariaSnapshot}\n"""`)
  .join("\n\n")}`
      : "No se pudo capturar evidencia real de la aplicación para este intento: usa el patrón conocido (si lo hay) o el propio feature como única guía.";

  const languageLabel = appLanguage === "en" ? "inglés" : "español";
  const languageSection = `La interfaz real de la aplicación bajo test está en ${languageLabel}. Los textos visibles que menciones o esperes (botones, mensajes, etiquetas, validaciones) deben asumirse en ese idioma — no los traduzcas al castellano aunque el resto de esta conversación esté en castellano.`;

  const homeRouteSection = routes.home
    ? `\n\nLa página principal de la aplicación (tras completar flujos como login) está en la ruta "${routes.home}"; si el escenario verifica una redirección a la página principal, usa esa ruta en vez de asumir la raíz de la URL base.`
    : "";

  const retrySection = retry
    ? `\n\nEl intento anterior generó este código:
"""
${retry.previousFiles.map((f) => `# FILE: ${f.path}\n${f.content}`).join("\n")}
"""

Pero no pasó la verificación de calidad. Corrige exactamente este error, manteniendo el resto del código igual siempre que sea posible:
"""
${retry.feedback}
"""`
    : "";

  return `Eres un ingeniero de QA experto en Playwright + Python + pytest-bdd + Page Object Model.

${languageSection}

Dado este archivo Gherkin ya aprobado, ubicado en "features/${naming.featureFileName}":
"""
${featureText}
"""

${patternSection}

${evidenceSection}${homeRouteSection}

El proyecto ya tiene instalado el plugin "pytest-playwright": el fixture "page" (una página de navegador ya lista) está disponible automáticamente en cualquier test, no lo definas tú ni escribas ningún conftest.py.

Para los locators de Playwright, usa siempre una única estrategia precisa por elemento (rol + nombre accesible exacto, o "get_by_test_id" si la evidencia lo muestra) — nunca combines varias estrategias con ".or_()": puede resolver a más de un elemento real y romper en modo estricto (ejemplo real: un botón "mostrar/ocultar contraseña" cuyo "aria-label" también contiene la palabra "contraseña"/"password" colisiona con el locator del campo).

La URL de la aplicación bajo test y las credenciales de una cuenta de prueba NUNCA se escriben como texto literal en este código: se guarda en el repositorio del usuario. Léelas siempre con "os.environ": "os.environ[\"AGENTE_QA_APP_URL\"]" para la URL base, y si el escenario prueba un login, "os.environ[\"AGENTE_QA_TEST_USERNAME\"]" / "os.environ[\"AGENTE_QA_TEST_PASSWORD\"]" para usuario y contraseña.

Genera EXACTAMENTE dos bloques de código, cada uno empezando por una línea con este formato exacto "# FILE: <ruta>", seguida del contenido completo de ese archivo. No incluyas explicaciones fuera de los bloques ni bloques de código markdown (\`\`\`).

Los dos archivos, en este orden, usando exactamente estos nombres (no inventes otros):
1. "tests/test_${naming.slug}.py" — step definitions pytest-bdd. Importa "scenarios" de "pytest_bdd" y llama "scenarios(\"../features/${naming.featureFileName}\")". Importa de "pytest_bdd" solo los decoradores "given"/"when"/"then" que realmente vayas a usar según los pasos del feature (no importes los que no uses). Usa el fixture "page" (parámetro de las funciones step) para interactuar con el navegador a través del Page Object.
2. "pages/${naming.slug}_page.py" — clase(s) Page Object en Python (Playwright sync API) para las pantallas involucradas, recibiendo "page" en su constructor.${retrySection}`;
}
```

- [ ] **Step 4: Add `appLanguage`/`routes` to `generateCode`**

In `core/src/agents/generador/codeGenerator.ts`, change:
```ts
export async function generateCode(
  featureText: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null,
  naming: CodeGenerationNaming,
  evidence: CodeGenerationEvidence[],
  retry?: CodeGenerationRetry
): Promise<GeneratedFile[]> {
  const raw = await llm.generate([
    {
      role: "system",
      content: "Eres un ingeniero de QA experto en Playwright, Python, pytest-bdd y Page Object Model.",
    },
    { role: "user", content: codeGenerationPrompt(featureText, matchedPattern, naming, evidence, retry) },
  ]);

  return parseGeneratedFiles(raw);
}
```
to:
```ts
export async function generateCode(
  featureText: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null,
  naming: CodeGenerationNaming,
  evidence: CodeGenerationEvidence[],
  appLanguage: "es" | "en",
  routes: Record<string, string>,
  retry?: CodeGenerationRetry
): Promise<GeneratedFile[]> {
  const raw = await llm.generate([
    {
      role: "system",
      content: "Eres un ingeniero de QA experto en Playwright, Python, pytest-bdd y Page Object Model.",
    },
    { role: "user", content: codeGenerationPrompt(featureText, matchedPattern, naming, evidence, appLanguage, routes, retry) },
  ]);

  return parseGeneratedFiles(raw);
}
```

- [ ] **Step 5: Run `codeGenerator.test.ts` to verify it passes**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck `core`**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: FAIL — `runGenerador.ts` still calls `generateCode(featureText, llm, matchedPattern, naming, evidence, retry)` with the old 6-argument shape. That's fixed in Task 7, immediately next — don't skip ahead of it.

- [ ] **Step 7: Commit**

```bash
git add core/src/prompts/generador.ts core/src/agents/generador/codeGenerator.ts core/src/agents/generador/codeGenerator.test.ts
git commit -m "feat(core): thread appLanguage and routes.home into code generation prompt

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: `runGenerador` gains `appLanguage`/`routes`, prepends project routes to Site Explorer candidates

**Files:**
- Modify: `core/src/agents/generador/runGenerador.ts`
- Test: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Consumes: `generateCode(..., appLanguage, routes, retry?)` from Task 6.
- Produces: `RunGeneradorOptions` gains `appLanguage: "es" | "en"` and `routes: Record<string, string>`.

This is the task that finally fixes `core`'s typecheck after Task 6, and implements the route-candidate prepending described in the spec.

- [ ] **Step 1: Write the failing tests in `runGenerador.test.ts`**

Add `appLanguage: "es", routes: {},` to every existing call's options object (13 calls from Task 1's rewrite — every `runGenerador({ ... })` call, including the end-to-end one). For example:
```ts
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
```

Add two new tests at the end of the main `describe("runGenerador", ...)` block (before the `hasChromium`/e2e block):
```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL — `RunGeneradorOptions` doesn't accept `appLanguage`/`routes` yet, and `generateCode` inside `runGenerador` is still called with the old signature (also a `tsc` error).

- [ ] **Step 3: Add `appLanguage`/`routes` to `RunGeneradorOptions` and implement route prepending**

In `core/src/agents/generador/runGenerador.ts`, change:
```ts
export interface RunGeneradorOptions {
  featureFilePath: string;
  llm: LLMProvider;
  patterns: Pattern[];
  checker: CodeChecker;
  explorer: SiteExplorer;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  credentials: ExplorationCredentials | undefined;
  callbacks: GeneratorCallbacks;
}

export async function runGenerador(options: RunGeneradorOptions): Promise<{ writtenPaths: string[] }> {
  const {
    featureFilePath,
    llm,
    patterns,
    checker,
    explorer,
    projectRoot,
    testsDir,
    baseUrl,
    credentials,
    callbacks,
  } = options;

  const featureText = await fs.readFile(featureFilePath, "utf-8");
  const matchedPatternName = parseFeatureHeader(featureText);
  const matchedPattern = matchedPatternName
    ? (patterns.find((p) => p.name === matchedPatternName) ?? null)
    : null;

  const featureFileName = path.basename(featureFilePath);
  const naming = { slug: toPythonModuleSlug(featureFileName.replace(/\.feature$/, "")), featureFileName };

  const exploration = await explorer.explore(
    { featureText, matchedPattern, baseUrl, credentials, headed: true },
    callbacks.onExplorationStep
  );
```
to:
```ts
export interface RunGeneradorOptions {
  featureFilePath: string;
  llm: LLMProvider;
  patterns: Pattern[];
  checker: CodeChecker;
  explorer: SiteExplorer;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  appLanguage: "es" | "en";
  routes: Record<string, string>;
  credentials: ExplorationCredentials | undefined;
  callbacks: GeneratorCallbacks;
}

export async function runGenerador(options: RunGeneradorOptions): Promise<{ writtenPaths: string[] }> {
  const {
    featureFilePath,
    llm,
    patterns,
    checker,
    explorer,
    projectRoot,
    testsDir,
    baseUrl,
    appLanguage,
    routes,
    credentials,
    callbacks,
  } = options;

  const featureText = await fs.readFile(featureFilePath, "utf-8");
  const matchedPatternName = parseFeatureHeader(featureText);
  const basePattern = matchedPatternName
    ? (patterns.find((p) => p.name === matchedPatternName) ?? null)
    : null;

  const projectRoute = basePattern ? routes[basePattern.name] : undefined;
  const matchedPattern: Pattern | null =
    basePattern && projectRoute
      ? {
          ...basePattern,
          navigationHints: {
            requiresLogin: basePattern.navigationHints?.requiresLogin ?? false,
            routeCandidates: [projectRoute, ...(basePattern.navigationHints?.routeCandidates ?? [])],
          },
        }
      : basePattern;

  const featureFileName = path.basename(featureFilePath);
  const naming = { slug: toPythonModuleSlug(featureFileName.replace(/\.feature$/, "")), featureFileName };

  const exploration = await explorer.explore(
    { featureText, matchedPattern, baseUrl, credentials, headed: true },
    callbacks.onExplorationStep
  );
```

Then change the `generateCode` call inside the retry loop:
```ts
    files = await generateCode(featureText, llm, matchedPattern, naming, evidence, retry);
```
to:
```ts
    files = await generateCode(featureText, llm, matchedPattern, naming, evidence, appLanguage, routes, retry);
```

- [ ] **Step 4: Run `runGenerador.test.ts` to verify it passes**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: clean.
Run: `npm run build --workspace=core && npx tsc -p cli/tsconfig.json --noEmit`
Expected: FAIL — `cli/src/commands/generate.ts` builds `RunGeneradorOptions` without `appLanguage`/`routes` yet, and `chat.ts` still calls the old `runIntake` shape from Task 5. Both are fixed in Task 8, immediately next.
Run: `npx vitest run core`
Expected: PASS (this task's scope, `core` package only).

- [ ] **Step 6: Commit**

```bash
git add core/src/agents/generador/runGenerador.ts core/src/agents/generador/runGenerador.test.ts
git commit -m "feat(core): prepend project routes to Site Explorer candidates, thread appLanguage/routes into code generation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Wire `appLanguage`/`routes` through the CLI commands

**Files:**
- Modify: `cli/src/commands/chat.ts`
- Modify: `cli/src/commands/generate.ts`
- Test: `cli/src/commands/chat.test.ts`
- Test: `cli/src/commands/generate.test.ts`

**Interfaces:**
- Consumes: `runIntake(..., appLanguage, callbacks)` from Task 5; `RunGeneradorOptions` with `appLanguage`/`routes` from Task 7.

This is the task that finally fixes `cli`'s typecheck, left red on purpose since Task 5/Task 7.

- [ ] **Step 1: Write the failing test in `chat.test.ts`**

Add a new test at the end of `describe("runCreatePlan", ...)`:
```ts
  it("passes the project's configured app language through to Gherkin generation", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com", appLanguage: "en" });

    const fake = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    createProviderMock.mockReturnValue(fake);

    const prompts: ChatPrompts = {
      inputInitialText: vi.fn().mockResolvedValue("quiero probar el login"),
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runCreatePlan(prompts, tmpProject);

    const gherkinPrompt = fake.receivedCalls[2].find((m) => m.role === "user")?.content;
    expect(gherkinPrompt).toContain("inglés");
  });
```
Also add `appUrl: "https://example.com"` to the 3 existing `saveProjectConfig` calls if not already applied in Task 3 (they should already have it from that task).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run cli/src/commands/chat.test.ts`
Expected: this new test FAILS (compile error: `runIntake` still takes the old shape inside `chat.ts`, or the language phrase is absent).

- [ ] **Step 3: Wire `chat.ts`**

Change:
```ts
  const { filePath } = await runIntake(
    initialText,
    llm,
    patterns,
    projectRoot,
    projectConfig.testsDir,
    callbacks
  );
```
to:
```ts
  const { filePath } = await runIntake(
    initialText,
    llm,
    patterns,
    projectRoot,
    projectConfig.testsDir,
    projectConfig.appLanguage,
    callbacks
  );
```

- [ ] **Step 4: Run `chat.test.ts` to verify it passes**

Run: `npx vitest run cli/src/commands/chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test in `generate.test.ts`**

Add a new test at the end of `describe("runGenerateTests", ...)`:
```ts
  it("passes the project's configured app language and routes through to code generation", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, {
      testsDir: "tests",
      appUrl: "https://example.com",
      appLanguage: "en",
      routes: { home: "/dashboard" },
    });
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "Feature: Login\n", "utf-8");

    const scriptedResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    const fake = new FakeLLMProvider([scriptedResponse]);
    createProviderMock.mockReturnValue(fake);
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
      offerSavePattern: vi.fn().mockResolvedValue({ save: false }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runGenerateTests(prompts, tmpProject);

    const codegenPrompt = fake.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(codegenPrompt).toContain("inglés");
    expect(codegenPrompt).toContain("/dashboard");
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: this new test FAILS (compile error: `RunGeneradorOptions` built without `appLanguage`/`routes`).

- [ ] **Step 7: Wire `generate.ts`**

Change:
```ts
  const { writtenPaths } = await runGenerador({
    featureFilePath,
    llm,
    patterns,
    checker: withCodeCheckerSpinner(realCodeChecker),
    explorer,
    projectRoot,
    testsDir: projectConfig.testsDir,
    baseUrl,
    credentials,
    callbacks,
  });
```
to:
```ts
  const { writtenPaths } = await runGenerador({
    featureFilePath,
    llm,
    patterns,
    checker: withCodeCheckerSpinner(realCodeChecker),
    explorer,
    projectRoot,
    testsDir: projectConfig.testsDir,
    baseUrl,
    appLanguage: projectConfig.appLanguage,
    routes: projectConfig.routes,
    credentials,
    callbacks,
  });
```

- [ ] **Step 8: Run `generate.test.ts` to verify it passes**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm run build --workspace=core && npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: clean.
Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add cli/src/commands/chat.ts cli/src/commands/chat.test.ts cli/src/commands/generate.ts cli/src/commands/generate.test.ts
git commit -m "feat(cli): wire project appLanguage/routes into generate and chat commands

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Update `README.md`

**Files:**
- Modify: `README.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Update the `init`/`.env` documentation**

In `README.md`, replace line 115:
```
`init` pregunta en qué carpeta del proyecto guardar los tests, y crea (si no existe ya) una plantilla `.env` en `<proyecto>/.agente-qa/.env` — fuera de git (`.agente-qa/.gitignore` ya la excluye). Ahí rellenas a mano, con un editor de texto, la URL de la aplicación que vas a probar, un usuario/contraseña de prueba (opcional, solo si vas a probar login) y el proveedor/API key/modelo del LLM. `init` nunca pide estos valores por chat ni sobrescribe el archivo si ya existe.
```
with:
```
`init` pregunta en qué carpeta del proyecto guardar los tests, la URL de la aplicación que vas a probar, en qué idioma está su interfaz (español por defecto, o inglés) y las rutas conocidas del proyecto (página principal, login, y cualquier otra que quieras añadir) — todo se guarda en `<proyecto>/.agente-qa/config.json` (sí va a git, no son datos sensibles). Además crea (si no existe ya) una plantilla `.env` en `<proyecto>/.agente-qa/.env` — fuera de git (`.agente-qa/.gitignore` ya la excluye) — donde rellenas a mano, con un editor de texto, un usuario/contraseña de prueba (opcional, solo si vas a probar login) y el proveedor/API key/modelo del LLM. `init` nunca pide estos dos últimos valores por chat ni sobrescribe el `.env` si ya existe.
```

Then update the example `.env` block (currently lines 133-141) — remove the `AGENTE_QA_APP_URL=https://staging.mi-app.com` line, since that variable no longer belongs in `.env`. Replace:
```
Ejemplo de `<proyecto>/.agente-qa/.env` completo, eligiendo Groq como proveedor `openai-compatible`:

```
AGENTE_QA_APP_URL=https://staging.mi-app.com
AGENTE_QA_TEST_USERNAME=qa-tester@mi-app.com
AGENTE_QA_TEST_PASSWORD=Sup3rSecreta!
AGENTE_QA_LLM_PROVIDER=openai-compatible
AGENTE_QA_LLM_API_KEY=gsk_xxxxxxxxxxxxxxxx
AGENTE_QA_LLM_BASE_URL=https://api.groq.com/openai/v1
AGENTE_QA_LLM_MODEL=llama-3.3-70b-versatile
```
```
with:
```
Ejemplo de `<proyecto>/.agente-qa/.env` completo, eligiendo Groq como proveedor `openai-compatible` (la URL de la app, el idioma y las rutas ya no van aquí — se preguntan en `init`/`Configuración` y se guardan en `config.json`):

```
AGENTE_QA_TEST_USERNAME=qa-tester@mi-app.com
AGENTE_QA_TEST_PASSWORD=Sup3rSecreta!
AGENTE_QA_LLM_PROVIDER=openai-compatible
AGENTE_QA_LLM_API_KEY=gsk_xxxxxxxxxxxxxxxx
AGENTE_QA_LLM_BASE_URL=https://api.groq.com/openai/v1
AGENTE_QA_LLM_MODEL=llama-3.3-70b-versatile
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document app URL/language/routes moving from .env to config.json

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Verification

After Task 9, run the full gate once more from a clean state:

```bash
npm run build --workspace=core
npx tsc -p core/tsconfig.json --noEmit
npx tsc -p cli/tsconfig.json --noEmit
npx vitest run
```

All three must be clean/green before considering this plan done, per this project's definition of "hecho" in `CLAUDE.md`.
