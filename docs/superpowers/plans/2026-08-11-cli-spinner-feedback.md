# CLI Spinner Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a terminal spinner during the two operations in the CLI that currently go silent for several seconds — LLM calls and the `ruff`/`py_compile` code check — so the user can tell the process is still alive instead of wondering if it crashed.

**Architecture:** Two small decorator functions in a new `cli/src/util/spinner.ts` wrap the existing `LLMProvider`/`CodeChecker` DI interfaces with an `ora` spinner. They're pass-through: same inputs, same outputs, same thrown errors — only a visual side effect is added. Applied at the two places `cli/src/commands/*.ts` already construct these objects (`chat.ts`, `generate.ts`). No changes to `core` at all.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Vitest, `ora` (new dependency, ESM-only spinner library).

## Global Constraints

- TypeScript strict mode across `cli`; no `any` in production code.
- Node.js >= 22.
- `core` has zero terminal I/O and is not touched by this plan at all — everything lives in `cli/src`.
- Both decorators are pure pass-through: they never change the resolved value, never change what's passed to the wrapped function, and never swallow or wrap a thrown error (`throw err`, not a new error).
- `CodeCheckResult.ok === false` is a valid **non-throwing** result (Agente 2 uses it to retry) — the checker decorator shows the spinner in "fail" state for that case but does not throw and does not alter the result.
- New dependency: `ora` (`^9.4.1`), added to `cli/package.json` under `"dependencies"` (runtime, not `devDependencies` — it's used when the CLI actually runs, not just for building it).
- "Ejecutar tests" (`execute.ts`) and "Ver/generar reportes" (`reports.ts`) are out of scope — the former already streams live `pytest` output, the latter is fast local file I/O. Neither is touched.

Spec reference: `docs/superpowers/specs/2026-08-11-cli-spinner-feedback-design.md` (read this first — it has the full reasoning for every decision below; this plan only re-states what's needed to implement).

---

## File Structure

```
cli/
  package.json                    # MODIFY: add ora dependency
  src/
    util/
      spinner.ts                   # NEW: withLLMSpinner, withCodeCheckerSpinner
      spinner.test.ts               # NEW
    commands/
      chat.ts                       # MODIFY: wrap llm with withLLMSpinner
      chat.test.ts                   # MODIFY: assert the wrapping happens
      generate.ts                     # MODIFY: wrap llm and realCodeChecker
      generate.test.ts                 # MODIFY: assert the wrapping happens
```

---

## Task 1: `spinner.ts` — the two decorators

**Files:**
- Modify: `cli/package.json`
- Create: `cli/src/util/spinner.ts`
- Test: `cli/src/util/spinner.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `Message`, `CodeChecker`, `CodeFile`, `CodeCheckResult` (all already exported from `@agente-qa/core`)
- Produces: `withLLMSpinner(provider: LLMProvider): LLMProvider`, `withCodeCheckerSpinner(checker: CodeChecker): CodeChecker`

- [ ] **Step 1: Add the `ora` dependency**

Add it to `cli/package.json`'s `"dependencies"` block. Full file:

```json
{
  "name": "agente-qa",
  "version": "0.1.3",
  "description": "CLI de automatización de QA: convierte una descripción de pruebas en lenguaje natural en tests Playwright (Gherkin/BDD), los ejecuta y genera reportes.",
  "type": "module",
  "license": "MIT",
  "author": "Nicolascarames",
  "repository": {
    "type": "git",
    "url": "https://github.com/Nicolascarames/Agente_QA.git",
    "directory": "cli"
  },
  "keywords": ["qa", "testing", "playwright", "gherkin", "bdd", "cli", "llm", "automation"],
  "engines": {
    "node": ">=22"
  },
  "bin": {
    "agente-qa": "./dist/bin/agente-qa.js"
  },
  "files": ["dist", "LICENSE", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepack": "rimraf dist && npm run build"
  },
  "dependencies": {
    "@agente-qa/core": "^0.1.0",
    "@inquirer/prompts": "^8.5.2",
    "commander": "^15.0.0",
    "ora": "^9.4.1"
  }
}
```

Run `npm install` from the repo root so `ora` is actually present in `node_modules` and `package-lock.json` is updated before writing code against it.

- [ ] **Step 2: Write the failing test**

`cli/src/util/spinner.test.ts` (full file):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, Message, CodeChecker, CodeFile } from "@agente-qa/core";

const spinnerInstance = {
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
};
spinnerInstance.start.mockReturnValue(spinnerInstance);

const oraFactory = vi.fn(() => spinnerInstance);

vi.mock("ora", () => ({
  default: (...args: unknown[]) => oraFactory(...args),
}));

import { withLLMSpinner, withCodeCheckerSpinner } from "./spinner.js";

describe("withLLMSpinner", () => {
  beforeEach(() => {
    oraFactory.mockClear();
    spinnerInstance.start.mockClear();
    spinnerInstance.succeed.mockClear();
    spinnerInstance.fail.mockClear();
  });

  it("returns the wrapped provider's result unchanged", async () => {
    const provider: LLMProvider = { generate: vi.fn().mockResolvedValue("respuesta del modelo") };
    const wrapped = withLLMSpinner(provider);

    const result = await wrapped.generate([{ role: "user", content: "hola" }]);

    expect(result).toBe("respuesta del modelo");
  });

  it("passes the exact same messages array through to the wrapped provider", async () => {
    const generate = vi.fn().mockResolvedValue("ok");
    const provider: LLMProvider = { generate };
    const wrapped = withLLMSpinner(provider);
    const messages: Message[] = [{ role: "user", content: "hola" }];

    await wrapped.generate(messages);

    expect(generate).toHaveBeenCalledWith(messages);
  });

  it("starts a spinner before calling the provider and marks it as succeeded after", async () => {
    const provider: LLMProvider = { generate: vi.fn().mockResolvedValue("ok") };
    const wrapped = withLLMSpinner(provider);

    await wrapped.generate([{ role: "user", content: "hola" }]);

    expect(oraFactory).toHaveBeenCalledWith("Consultando al modelo...");
    expect(spinnerInstance.start).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.succeed).toHaveBeenCalledTimes(1);
  });

  it("marks the spinner as failed and rethrows the same error when the provider throws", async () => {
    const boom = new Error("fallo de red");
    const provider: LLMProvider = { generate: vi.fn().mockRejectedValue(boom) };
    const wrapped = withLLMSpinner(provider);

    await expect(wrapped.generate([{ role: "user", content: "hola" }])).rejects.toBe(boom);
    expect(spinnerInstance.fail).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.succeed).not.toHaveBeenCalled();
  });
});

describe("withCodeCheckerSpinner", () => {
  beforeEach(() => {
    oraFactory.mockClear();
    spinnerInstance.start.mockClear();
    spinnerInstance.succeed.mockClear();
    spinnerInstance.fail.mockClear();
  });

  it("returns the wrapped checker's result unchanged when ok", async () => {
    const checker: CodeChecker = { check: vi.fn().mockResolvedValue({ ok: true }) };
    const wrapped = withCodeCheckerSpinner(checker);

    const result = await wrapped.check([{ path: "a.py", content: "pass\n" }]);

    expect(result).toEqual({ ok: true });
    expect(spinnerInstance.succeed).toHaveBeenCalledTimes(1);
  });

  it("marks the spinner as failed (without throwing) when the check result is not ok", async () => {
    const checker: CodeChecker = { check: vi.fn().mockResolvedValue({ ok: false, errors: "boom" }) };
    const wrapped = withCodeCheckerSpinner(checker);

    const result = await wrapped.check([{ path: "a.py", content: "pass\n" }]);

    expect(result).toEqual({ ok: false, errors: "boom" });
    expect(spinnerInstance.fail).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.succeed).not.toHaveBeenCalled();
  });

  it("marks the spinner as failed and rethrows the same error when the checker throws", async () => {
    const boom = new Error("ruff no encontrado");
    const checker: CodeChecker = { check: vi.fn().mockRejectedValue(boom) };
    const wrapped = withCodeCheckerSpinner(checker);

    await expect(wrapped.check([{ path: "a.py", content: "pass\n" }])).rejects.toBe(boom);
    expect(spinnerInstance.fail).toHaveBeenCalledTimes(1);
  });

  it("passes the exact same files array through to the wrapped checker", async () => {
    const check = vi.fn().mockResolvedValue({ ok: true });
    const checker: CodeChecker = { check };
    const wrapped = withCodeCheckerSpinner(checker);
    const files: CodeFile[] = [{ path: "a.py", content: "pass\n" }];

    await wrapped.check(files);

    expect(check).toHaveBeenCalledWith(files);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run cli/src/util/spinner.test.ts`
Expected: FAIL (`Cannot find module './spinner.js'`)

- [ ] **Step 4: Implement**

`cli/src/util/spinner.ts` (full file):

```ts
import ora from "ora";
import type { LLMProvider, Message, CodeChecker, CodeFile, CodeCheckResult } from "@agente-qa/core";

export function withLLMSpinner(provider: LLMProvider): LLMProvider {
  return {
    async generate(messages: Message[]): Promise<string> {
      const spinner = ora("Consultando al modelo...").start();
      try {
        const result = await provider.generate(messages);
        spinner.succeed("Modelo respondió.");
        return result;
      } catch (err) {
        spinner.fail("Fallo al consultar el modelo.");
        throw err;
      }
    },
  };
}

export function withCodeCheckerSpinner(checker: CodeChecker): CodeChecker {
  return {
    async check(files: CodeFile[]): Promise<CodeCheckResult> {
      const spinner = ora("Comprobando el código generado (ruff/py_compile)...").start();
      try {
        const result = await checker.check(files);
        if (result.ok) {
          spinner.succeed("Código comprobado sin errores.");
        } else {
          spinner.fail("El código generado tiene errores de lint/compilación.");
        }
        return result;
      } catch (err) {
        spinner.fail("Fallo al comprobar el código.");
        throw err;
      }
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run cli/src/util/spinner.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add cli/package.json package-lock.json cli/src/util/spinner.ts cli/src/util/spinner.test.ts
git commit -m "feat(cli): add spinner decorators for LLMProvider and CodeChecker"
```

---

## Task 2: Wire the decorators into `chat.ts` and `generate.ts`

**Files:**
- Modify: `cli/src/commands/chat.ts`
- Modify: `cli/src/commands/chat.test.ts`
- Modify: `cli/src/commands/generate.ts`
- Modify: `cli/src/commands/generate.test.ts`

**Interfaces:**
- Consumes: `withLLMSpinner`, `withCodeCheckerSpinner` (Task 1)
- Produces: nothing new — `runCreatePlan`/`runGenerateTests` keep their existing signatures and behavior unchanged

- [ ] **Step 1: Write the failing tests**

`cli/src/commands/chat.test.ts` (full file — adds a `../util/spinner.js` mock and one new test, existing two tests unchanged):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, saveProjectConfig, FakeLLMProvider } from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";

const createProviderMock = vi.fn();
const withLLMSpinnerMock = vi.fn((provider: unknown) => provider);

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
  };
});

vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (...args: unknown[]) => withLLMSpinnerMock(...args),
}));

import { runCreatePlan } from "./chat.js";

describe("runCreatePlan", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-chat-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-chat-project-"));
    createProviderMock.mockReset();
    withLLMSpinnerMock.mockClear();
    withLLMSpinnerMock.mockImplementation((provider: unknown) => provider);
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: ChatPrompts = {
      inputInitialText: vi.fn(),
      askUser: vi.fn(),
      presentForApproval: vi.fn(),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };
    await expect(runCreatePlan(prompts, tmpHome, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("loads credentials/config, runs intake through the fake LLM, and writes the feature file", async () => {
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test" }, tmpHome);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

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

    const filePath = await runCreatePlan(prompts, tmpHome, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toContain("Feature: Login");
  });

  it("wraps the LLM provider with the spinner decorator before using it", async () => {
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test" }, tmpHome);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

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

    await runCreatePlan(prompts, tmpHome, tmpProject);

    expect(withLLMSpinnerMock).toHaveBeenCalledWith(fake);
  });
});
```

`cli/src/commands/generate.test.ts` (full file — adds a `../util/spinner.js` mock, imports the mocked `realCodeChecker` to compare by reference, and one new test):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, saveProjectConfig, FakeLLMProvider, realCodeChecker } from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";

const createProviderMock = vi.fn();
const realCodeCheckerCheckMock = vi.fn();
const withLLMSpinnerMock = vi.fn((provider: unknown) => provider);
const withCodeCheckerSpinnerMock = vi.fn((checker: unknown) => checker);

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
    realCodeChecker: { check: (...args: unknown[]) => realCodeCheckerCheckMock(...args) },
  };
});

vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (...args: unknown[]) => withLLMSpinnerMock(...args),
  withCodeCheckerSpinner: (...args: unknown[]) => withCodeCheckerSpinnerMock(...args),
}));

import { runGenerateTests } from "./generate.js";

describe("runGenerateTests", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-generate-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-generate-project-"));
    createProviderMock.mockReset();
    realCodeCheckerCheckMock.mockReset();
    withLLMSpinnerMock.mockClear();
    withLLMSpinnerMock.mockImplementation((provider: unknown) => provider);
    withCodeCheckerSpinnerMock.mockClear();
    withCodeCheckerSpinnerMock.mockImplementation((checker: unknown) => checker);
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpHome, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws a clear error when there are no approved .feature files yet", async () => {
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test" }, tmpHome);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpHome, tmpProject)).rejects.toThrow(/Crear plan de pruebas/);
  });

  it("lists feature files, generates code through the fake LLM, and writes the test files", async () => {
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test" }, tmpHome);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "Feature: Login\n", "utf-8");

    const scriptedResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    createProviderMock.mockReturnValue(new FakeLLMProvider([scriptedResponse]));
    realCodeCheckerCheckMock.mockResolvedValue({ ok: true });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
      offerSavePattern: vi.fn().mockResolvedValue({ save: false }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const writtenPaths = await runGenerateTests(prompts, tmpHome, tmpProject);

    expect(prompts.selectFeatureFile).toHaveBeenCalledWith(["login.feature"]);
    expect(writtenPaths).toHaveLength(2);
    expect(
      await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")
    ).toContain("scenarios(");
  });

  it("wraps the LLM provider and the code checker with their spinner decorators before using them", async () => {
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test" }, tmpHome);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
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

    await runGenerateTests(prompts, tmpHome, tmpProject);

    expect(withLLMSpinnerMock).toHaveBeenCalledWith(fake);
    expect(withCodeCheckerSpinnerMock).toHaveBeenCalledWith(realCodeChecker);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run cli/src/commands/chat.test.ts cli/src/commands/generate.test.ts`
Expected: FAIL — the two new "wraps ... with the spinner decorator" tests fail because `chat.ts`/`generate.ts` don't call `withLLMSpinner`/`withCodeCheckerSpinner` yet (`withLLMSpinnerMock`/`withCodeCheckerSpinnerMock` never called, so `toHaveBeenCalledWith` fails). The pre-existing tests in both files still pass (the mocked decorators are identity pass-through, so behavior is unaffected either way).

- [ ] **Step 3: Implement**

`cli/src/commands/chat.ts` (full file):

```ts
import {
  createProvider,
  loadCredentials,
  loadProjectConfig,
  loadAllPatterns,
  runIntake,
  type IntakeCallbacks,
} from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";
import { withLLMSpinner } from "../util/spinner.js";

export async function runCreatePlan(
  prompts: ChatPrompts,
  homeDir: string,
  projectRoot: string
): Promise<string> {
  const credentials = await loadCredentials(homeDir);
  if (!credentials) {
    throw new Error("No hay credenciales configuradas. Ejecuta 'agente-qa init' primero.");
  }

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const llm = withLLMSpinner(createProvider(credentials));
  const patterns = await loadAllPatterns(projectRoot);
  const initialText = await prompts.inputInitialText();

  const callbacks: IntakeCallbacks = {
    askUser: (question) => prompts.askUser(question),
    presentForApproval: (plan) => prompts.presentForApproval(plan.featureText),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
  };

  const { filePath } = await runIntake(
    initialText,
    llm,
    patterns,
    projectRoot,
    projectConfig.testsDir,
    callbacks
  );

  return filePath;
}
```

`cli/src/commands/generate.ts` (full file):

```ts
import path from "node:path";
import {
  createProvider,
  loadCredentials,
  loadProjectConfig,
  loadAllPatterns,
  listFeatureFiles,
  realCodeChecker,
  runGenerador,
  type GeneratorCallbacks,
} from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";
import { withLLMSpinner, withCodeCheckerSpinner } from "../util/spinner.js";

export async function runGenerateTests(
  prompts: GeneratorPrompts,
  homeDir: string,
  projectRoot: string
): Promise<string[]> {
  const credentials = await loadCredentials(homeDir);
  if (!credentials) {
    throw new Error("No hay credenciales configuradas. Ejecuta 'agente-qa init' primero.");
  }

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const featureFiles = await listFeatureFiles(projectRoot, projectConfig.testsDir);
  if (featureFiles.length === 0) {
    throw new Error(
      "No hay ningún plan de pruebas (.feature) aprobado todavía. Usa 'Crear plan de pruebas' primero."
    );
  }

  const chosen = await prompts.selectFeatureFile(featureFiles);
  const featureFilePath = path.join(projectRoot, projectConfig.testsDir, "features", chosen);

  const llm = withLLMSpinner(createProvider(credentials));
  const patterns = await loadAllPatterns(projectRoot);

  const callbacks: GeneratorCallbacks = {
    offerSavePattern: () => prompts.offerSavePattern(),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
  };

  const { writtenPaths } = await runGenerador(
    featureFilePath,
    llm,
    patterns,
    withCodeCheckerSpinner(realCodeChecker),
    projectRoot,
    projectConfig.testsDir,
    callbacks
  );

  return writtenPaths;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run cli/src/commands/chat.test.ts cli/src/commands/generate.test.ts`
Expected: PASS (3 tests in `chat.test.ts`, 4 tests in `generate.test.ts`)

- [ ] **Step 5: Run the full suite and typecheck both packages**

Run: `npx vitest run`
Expected: PASS, all files (184 total minus/plus the ones changed here — no regressions).

Run: `npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: clean, no errors in either package.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/chat.ts cli/src/commands/chat.test.ts cli/src/commands/generate.ts cli/src/commands/generate.test.ts
git commit -m "feat(cli): show a spinner during LLM calls and the code-check step"
```
