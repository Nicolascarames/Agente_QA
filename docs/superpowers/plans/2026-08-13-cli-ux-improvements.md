# CLI UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four UX gaps in the CLI: a silent spinner-less gap during "Ejecutar tests", no way to watch execution (headed browser + step-by-step console), "Ver/generar reportes" never opening the files it generates, and `init`/`Configuración` never touching the consumer project's own `.gitignore`.

**Architecture:** Small, additive changes layered on the existing DI patterns — a new `TestRunOptions.headed`/`verboseSteps` pair threaded from a new `ProjectConfig.headedMode` field, through `runEjecutor`, into `realTestRunner`'s pytest invocation; a new `withTestRunnerSpinner` CLI decorator mirroring the existing `withLLMSpinner`/`withCodeCheckerSpinner`; a new `cli/src/util/openFile.ts` with a pure, fully-tested command-resolution function plus a thin untested real-spawn wrapper; a new `core/src/config/projectGitignore.ts` mirroring `ensureProjectEnvTemplate`'s idempotent-write pattern.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Vitest, `@inquirer/prompts`, `ora`, Node `child_process`.

**Spec:** `docs/superpowers/specs/2026-08-13-cli-ux-improvements-design.md` (read this first — it has the full reasoning for every decision below; this plan only re-states what's needed to implement).

## Global Constraints

- TypeScript strict mode across `core` and `cli`; no `any` in production code.
- Node.js >= 22.
- `core` has no direct terminal I/O — `console.log`/`ora`/opening files stays in `cli/src`, never in `core/src`.
- Modo headed de Agente 3 (este plan) es distinto del `headed: true` fijo del Site Explorer (Agente 2) — no se tocan sus tests ni su código.
- Un único campo de configuración (`headedMode`) controla a la vez `--headed` y `--gherkin-terminal-reporter` — no son interruptores independientes en la UX, aunque `TestRunOptions` los exponga como dos campos separados (`headed`, `verboseSteps`) para no acoplar el contrato de bajo nivel a esa decisión de UX.
- Apertura de reportes: nivel "resumen" abre solo el `.md`; nivel "completo" abre el `.md` y además el `.html`. El `.html` siempre se abre con el abridor del sistema operativo, nunca con `code`, incluso dentro de VSCode.
- `.gitignore` del proyecto: se pregunta en cada `init`/`Configuración`, pero solo por las entradas (`node_modules`, `<testsDir>/results`, `<testsDir>/test-results`) que todavía falten — si ya están las tres, no se pregunta nada.
- `openFile`/`trySpawn` (el `spawn` real que abre una ventana/aplicación) no se testea automáticamente — abrir una ventana real durante `vitest run` es un efecto de sistema no deseable en CI. Solo `resolveOpenCommand` (la función pura de decisión) se testea, exhaustivamente.

---

## File Structure

```
core/src/config/
  projectConfig.ts        # MODIFY: + headedMode (con z.input/z.infer para no romper llamadas existentes)
  projectConfig.test.ts     # MODIFY
  projectGitignore.ts         # NEW
  projectGitignore.test.ts      # NEW
core/src/testRun/
  testRunner.ts                  # MODIFY: TestRunOptions + headed, verboseSteps
  realTestRunner.ts                # MODIFY: + flags --headed / --gherkin-terminal-reporter
  realTestRunner.test.ts             # MODIFY
  testUtils.test.ts                    # MODIFY
core/src/agents/ejecutor/
  runEjecutor.ts                         # MODIFY: + parámetro headedMode
  runEjecutor.test.ts                      # MODIFY
core/src/
  index.ts                                   # MODIFY: + exports de projectGitignore
  index.test.ts                                # MODIFY
cli/src/util/
  spinner.ts                                     # MODIFY: + withTestRunnerSpinner
  spinner.test.ts                                  # MODIFY
  openFile.ts                                        # NEW
  openFile.test.ts                                     # NEW
cli/src/prompts/
  types.ts                                               # MODIFY: + InitPrompts.confirmHeadedMode/selectGitignoreEntries
  inquirerPrompts.ts                                       # MODIFY
cli/src/commands/
  init.ts                                                    # MODIFY
  init.test.ts                                                 # MODIFY
  execute.ts                                                     # MODIFY
  execute.test.ts                                                  # MODIFY
  reports.ts                                                         # MODIFY
  reports.test.ts                                                      # MODIFY
cli/src/
  menu.ts                                                                # MODIFY
  menu.test.ts                                                             # MODIFY
```

---

## Task 1: `ProjectConfigSchema` gana `headedMode`

**Files:**
- Modify: `core/src/config/projectConfig.ts`
- Modify: `core/src/config/projectConfig.test.ts`

**Interfaces:**
- Produces: `ProjectConfigSchema` con `headedMode: z.boolean().default(false)`; `ProjectConfig` (tipo de salida, `z.infer`, `headedMode` siempre `boolean`); `saveProjectConfig(projectRoot: string, config: z.input<typeof ProjectConfigSchema>): Promise<void>` — el parámetro usa el tipo de ENTRADA de zod (con `headedMode` opcional), así que todas las llamadas existentes (`saveProjectConfig(root, { testsDir: "tests" })`, usadas en muchos tests de otros ficheros) siguen compilando sin tocarlas.

**Nota importante para el implementador:** si `saveProjectConfig` sigue tipado con `config: ProjectConfig` (el tipo de SALIDA de `z.infer`), añadir `headedMode: z.boolean().default(false)` rompe la compilación de todas las llamadas existentes que solo pasan `{ testsDir }` — porque el tipo de salida de zod hace `headedMode` obligatorio, aunque en tiempo de ejecución `.parse()` lo rellene solo. La solución es cambiar el parámetro de `saveProjectConfig` al tipo de ENTRADA (`z.input<typeof ProjectConfigSchema>`), no tocar cada llamada existente.

- [ ] **Step 1: Write the failing test**

En `core/src/config/projectConfig.test.ts`, reemplaza el test `"saves and loads project config round-trip"` y añade dos nuevos. Fichero completo:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, loadProjectConfig, projectConfigPath } from "./projectConfig.js";

describe("projectConfig", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("returns null when no config file exists", async () => {
    expect(await loadProjectConfig(tmpProject)).toBeNull();
  });

  it("saves and loads project config round-trip, defaulting headedMode to false when omitted", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests", headedMode: false });
  });

  it("saves and loads headedMode: true when explicitly given", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", headedMode: true });
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests", headedMode: true });
  });

  it("writes the file at <project>/.agente-qa/config.json", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "qa-tests" });
    expect(projectConfigPath(tmpProject)).toBe(path.join(tmpProject, ".agente-qa", "config.json"));
  });

  it("rejects and does not write the file when testsDir is empty", async () => {
    await expect(saveProjectConfig(tmpProject, { testsDir: "" })).rejects.toThrow();
    const exists = await fs.stat(projectConfigPath(tmpProject)).then(() => true, () => false);
    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/config/projectConfig.test.ts`
Expected: FAIL — `headedMode` no existe todavía en el esquema, `loadProjectConfig` devuelve `{ testsDir: "tests" }` sin ese campo.

- [ ] **Step 3: Implement**

`core/src/config/projectConfig.ts` (fichero completo):

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
  headedMode: z.boolean().default(false),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/config/projectConfig.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/config/projectConfig.ts core/src/config/projectConfig.test.ts
git commit -m "feat(core): add headedMode to ProjectConfigSchema"
```

---

## Task 2: `TestRunOptions` gana `headed`/`verboseSteps`

**Files:**
- Modify: `core/src/testRun/testRunner.ts`
- Modify: `core/src/testRun/realTestRunner.ts`
- Modify: `core/src/testRun/testUtils.test.ts`
- Modify: `core/src/testRun/realTestRunner.test.ts`

**Interfaces:**
- Produces: `TestRunOptions` con dos campos nuevos, `headed: boolean` y `verboseSteps: boolean`. `realTestRunner` añade `--headed` a los argumentos de `pytest` cuando `headed` es `true`, y `--gherkin-terminal-reporter` cuando `verboseSteps` es `true`.

- [ ] **Step 1: Write the failing test**

En `core/src/testRun/testUtils.test.ts`, añade los dos campos nuevos al helper `options()`. Fichero completo:

```ts
import { describe, it, expect } from "vitest";
import { FakeTestRunner } from "./testUtils.js";
import type { TestRunOptions } from "./testRunner.js";

function options(overrides: Partial<TestRunOptions> = {}): TestRunOptions {
  return {
    cwd: "/tmp/project/tests",
    markerExpression: null,
    screenshotMode: "off",
    videoMode: "off",
    headed: false,
    verboseSteps: false,
    junitXmlPath: "/tmp/project/tests/results/latest.xml",
    htmlReportPath: "/tmp/project/tests/results/latest.html",
    onOutput: () => {},
    env: {},
    ...overrides,
  };
}

describe("FakeTestRunner", () => {
  it("returns scripted results in order and records the options it was called with", async () => {
    const fake = new FakeTestRunner([{ exitCode: 1 }, { exitCode: 0 }]);

    const first = await fake.run(options({ markerExpression: "smoke" }));
    expect(first).toEqual({ exitCode: 1 });

    const second = await fake.run(options());
    expect(second).toEqual({ exitCode: 0 });

    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0].markerExpression).toBe("smoke");
  });

  it("throws when out of scripted results", async () => {
    const fake = new FakeTestRunner([]);
    await expect(fake.run(options())).rejects.toThrow();
  });
});
```

En `core/src/testRun/realTestRunner.test.ts`, actualiza `baseOptions()` y los dos objetos de opciones literales de los tests gateados existentes, y añade un test nuevo que confirma que `pytest` acepta `--headed`/`--gherkin-terminal-reporter` y que este último cambia su salida. Fichero completo:

```ts
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRealTestRunner, realTestRunner, MissingTestToolError } from "./realTestRunner.js";
import type { TestRunOptions } from "./testRunner.js";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}

function pytestStackAvailable(pythonCmd: string): boolean {
  return spawnSync(pythonCmd, ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"]).status === 0;
}

const hasPython = commandExists("python");
const hasPytestStack = hasPython && pytestStackAvailable("python");

function baseOptions(overrides: Partial<TestRunOptions> = {}): TestRunOptions {
  return {
    cwd: process.cwd(),
    markerExpression: null,
    screenshotMode: "off",
    videoMode: "off",
    headed: false,
    verboseSteps: false,
    junitXmlPath: path.join(os.tmpdir(), "agente-qa-realtestrunner-preflight.xml"),
    htmlReportPath: path.join(os.tmpdir(), "agente-qa-realtestrunner-preflight.html"),
    onOutput: () => {},
    env: {},
    ...overrides,
  };
}

describe("realTestRunner missing tool handling", () => {
  it("throws MissingTestToolError when the python command doesn't exist", async () => {
    const runner = createRealTestRunner({ pythonCommand: "agente-qa-definitely-missing-python" });
    await expect(runner.run(baseOptions())).rejects.toThrow(MissingTestToolError);
  });

  it("throws MissingTestToolError when pytest/pytest-bdd/pytest-playwright/pytest-html aren't importable", async () => {
    if (!hasPython || hasPytestStack) return; // can't reproduce "modules missing" without an interpreter that actually lacks them
    const runner = createRealTestRunner({ pythonCommand: "python" });
    await expect(runner.run(baseOptions())).rejects.toThrow(MissingTestToolError);
  });
});

describe.skipIf(!hasPytestStack)(
  "realTestRunner (requires Python + pytest + pytest-bdd + pytest-playwright + pytest-html on PATH)",
  () => {
    it("runs a trivial pytest-bdd scenario and writes the junit-xml and the html report", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-realtestrunner-"));
      try {
        await fs.mkdir(path.join(tmpDir, "features"), { recursive: true });
        await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, "features", "sample.feature"),
          "Feature: Sample\n  @smoke\n  Scenario: it works\n    Given a precondition\n    When an action happens\n    Then the outcome is correct\n",
          "utf-8"
        );
        await fs.writeFile(
          path.join(tmpDir, "tests", "test_sample.py"),
          `from pytest_bdd import scenarios, given, when, then

scenarios("../features/sample.feature")


@given("a precondition")
def _():
    pass


@when("an action happens")
def _():
    pass


@then("the outcome is correct")
def _():
    pass
`,
          "utf-8"
        );

        const junitXmlPath = path.join(tmpDir, "results", "latest.xml");
        const htmlReportPath = path.join(tmpDir, "results", "latest.html");
        await fs.mkdir(path.dirname(junitXmlPath), { recursive: true });

        let output = "";
        const result = await realTestRunner.run({
          cwd: tmpDir,
          markerExpression: null,
          screenshotMode: "off",
          videoMode: "off",
          headed: false,
          verboseSteps: false,
          junitXmlPath,
          htmlReportPath,
          onOutput: (chunk) => {
            output += chunk;
          },
          env: {},
        });

        expect(result.exitCode).toBe(0);
        expect(output.length).toBeGreaterThan(0);
        const xmlExists = await fs.access(junitXmlPath).then(
          () => true,
          () => false
        );
        expect(xmlExists).toBe(true);
        const htmlExists = await fs.access(htmlReportPath).then(
          () => true,
          () => false
        );
        expect(htmlExists).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("passes custom env vars through to the pytest subprocess", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-realtestrunner-env-"));
      try {
        await fs.mkdir(path.join(tmpDir, "features"), { recursive: true });
        await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, "features", "sample.feature"),
          "Feature: Sample\n  @smoke\n  Scenario: it works\n    Given a precondition\n    When an action happens\n    Then the outcome is correct\n",
          "utf-8"
        );
        await fs.writeFile(
          path.join(tmpDir, "tests", "test_sample.py"),
          `import os
from pytest_bdd import scenarios, given, when, then

scenarios("../features/sample.feature")


@given("a precondition")
def _():
    assert os.environ["AGENTE_QA_APP_URL"] == "https://example.com"


@when("an action happens")
def _():
    pass


@then("the outcome is correct")
def _():
    pass
`,
          "utf-8"
        );

        const junitXmlPath = path.join(tmpDir, "results", "latest.xml");
        const htmlReportPath = path.join(tmpDir, "results", "latest.html");
        await fs.mkdir(path.dirname(junitXmlPath), { recursive: true });

        const result = await realTestRunner.run({
          cwd: tmpDir,
          markerExpression: null,
          screenshotMode: "off",
          videoMode: "off",
          headed: false,
          verboseSteps: false,
          junitXmlPath,
          htmlReportPath,
          onOutput: () => {},
          env: { AGENTE_QA_APP_URL: "https://example.com" },
        });

        expect(result.exitCode).toBe(0);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("accepts --headed and --gherkin-terminal-reporter, and the latter visibly changes pytest's output", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-realtestrunner-headed-"));
      try {
        await fs.mkdir(path.join(tmpDir, "features"), { recursive: true });
        await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, "features", "sample.feature"),
          "Feature: Sample\n  @smoke\n  Scenario: it works\n    Given a precondition\n    When an action happens\n    Then the outcome is correct\n",
          "utf-8"
        );
        await fs.writeFile(
          path.join(tmpDir, "tests", "test_sample.py"),
          `from pytest_bdd import scenarios, given, when, then

scenarios("../features/sample.feature")


@given("a precondition")
def _():
    pass


@when("an action happens")
def _():
    pass


@then("the outcome is correct")
def _():
    pass
`,
          "utf-8"
        );

        const junitXmlPath = path.join(tmpDir, "results", "latest.xml");
        const htmlReportPath = path.join(tmpDir, "results", "latest.html");
        await fs.mkdir(path.dirname(junitXmlPath), { recursive: true });

        let output = "";
        const result = await realTestRunner.run({
          cwd: tmpDir,
          markerExpression: null,
          screenshotMode: "off",
          videoMode: "off",
          headed: true,
          verboseSteps: true,
          junitXmlPath,
          htmlReportPath,
          onOutput: (chunk) => {
            output += chunk;
          },
          env: {},
        });

        expect(result.exitCode).toBe(0);
        expect(output).toContain("Feature: Sample");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  }
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/testRun/testUtils.test.ts core/src/testRun/realTestRunner.test.ts`
Expected: FAIL — `TestRunOptions` no tiene `headed`/`verboseSteps` todavía (error de tipos en los ficheros de test); si Python+pytest-bdd están instalados, el nuevo test gateado falla porque `pytest` no reconoce `--gherkin-terminal-reporter` como flag esperado en la salida (aún no se pasa).

- [ ] **Step 3: Implement**

`core/src/testRun/testRunner.ts` (fichero completo):

```ts
export interface TestRunOptions {
  cwd: string;
  markerExpression: string | null;
  screenshotMode: "off" | "only-on-failure" | "on";
  videoMode: "off" | "retain-on-failure" | "on";
  headed: boolean;
  verboseSteps: boolean;
  junitXmlPath: string;
  htmlReportPath: string;
  onOutput: (chunk: string) => void;
  env: Record<string, string>;
}

export interface TestRunResult {
  exitCode: number;
  browserSetupWarning?: string;
}

export interface TestRunner {
  run(options: TestRunOptions): Promise<TestRunResult>;
}
```

En `core/src/testRun/realTestRunner.ts`, en el método `run`, reemplaza el bloque de construcción de `args` (deja el resto del fichero igual):

```ts
      const args = ["-m", "pytest"];
      if (runOptions.markerExpression) {
        args.push("-m", runOptions.markerExpression);
      }
      args.push(`--screenshot=${runOptions.screenshotMode}`);
      args.push(`--video=${runOptions.videoMode}`);
      if (runOptions.headed) {
        args.push("--headed");
      }
      if (runOptions.verboseSteps) {
        args.push("--gherkin-terminal-reporter");
      }
      args.push(`--junitxml=${runOptions.junitXmlPath}`);
      args.push(`--html=${runOptions.htmlReportPath}`, "--self-contained-html");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/testRun/testUtils.test.ts core/src/testRun/realTestRunner.test.ts`
Expected: PASS (2 tests en `testUtils.test.ts`; el bloque gateado de `realTestRunner.test.ts` pasa con 3 tests si Python+pytest-bdd+pytest-playwright+pytest-html están instalados, si no aparecen como `skipped`)

- [ ] **Step 5: Commit**

```bash
git add core/src/testRun/testRunner.ts core/src/testRun/realTestRunner.ts core/src/testRun/testUtils.test.ts core/src/testRun/realTestRunner.test.ts
git commit -m "feat(core): add headed/verboseSteps to TestRunOptions and realTestRunner"
```

---

## Task 3: `runEjecutor` gana `headedMode`

**Files:**
- Modify: `core/src/agents/ejecutor/runEjecutor.ts`
- Modify: `core/src/agents/ejecutor/runEjecutor.test.ts`

**Interfaces:**
- Consumes: `TestRunOptions.headed`/`verboseSteps` (Task 2)
- Produces: `runEjecutor(projectRoot, testsDir, runner, headedMode: boolean, callbacks, testEnv?)` — `headedMode` se inserta como 4º parámetro, entre `runner` y `callbacks`; se traduce a `headed: headedMode, verboseSteps: headedMode` en las `TestRunOptions` que recibe el `TestRunner`.

- [ ] **Step 1: Write the failing test**

Reemplaza `core/src/agents/ejecutor/runEjecutor.test.ts` en su totalidad — cada llamada existente a `runEjecutor(tmpProject, "tests", runner, callbacks, ...)` pasa a `runEjecutor(tmpProject, "tests", runner, false, callbacks, ...)`, y se añaden dos tests nuevos al final:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeTestRunner } from "../../testRun/testUtils.js";
import { runEjecutor, type ExecutorCallbacks } from "./runEjecutor.js";

describe("runEjecutor", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-runejecutor-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  async function writeFeature(fileName: string, content: string): Promise<void> {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), content, "utf-8");
  }

  it("throws a clear error when there are no feature files", async () => {
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
      onOutput: vi.fn(),
    };

    await expect(runEjecutor(tmpProject, "tests", runner, false, callbacks)).rejects.toThrow(
      /Generar tests Playwright/
    );
  });

  it("builds a pytest marker expression (without '@') from a strict subset of selected tags", async () => {
    await writeFeature("login.feature", "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n");
    await writeFeature("checkout.feature", "@regression\nFeature: Checkout\n  Scenario: y\n    Given b\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn().mockResolvedValue(["@smoke"]),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(callbacks.selectTags).toHaveBeenCalledWith(["@regression", "@smoke"]);
    expect(runner.receivedCalls[0].markerExpression).toBe("smoke");
  });

  it("rejects a strict subset selection that includes a tag with characters invalid for pytest -m", async () => {
    await writeFeature("login.feature", "@smoke-test\nFeature: Login\n  Scenario: x\n    Given a\n");
    await writeFeature("checkout.feature", "@regression\nFeature: Checkout\n  Scenario: y\n    Given b\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn().mockResolvedValue(["@smoke-test"]),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await expect(runEjecutor(tmpProject, "tests", runner, false, callbacks)).rejects.toThrow(/@smoke-test/);
  });

  it("does not throw for a strict subset selection using a plain identifier tag like '@smoke'", async () => {
    await writeFeature("login.feature", "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n");
    await writeFeature("checkout.feature", "@regression\nFeature: Checkout\n  Scenario: y\n    Given b\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn().mockResolvedValue(["@smoke"]),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await expect(runEjecutor(tmpProject, "tests", runner, false, callbacks)).resolves.toBeDefined();
    expect(runner.receivedCalls[0].markerExpression).toBe("smoke");
  });

  it("passes markerExpression: null when every available tag is selected (run everything)", async () => {
    await writeFeature("login.feature", "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn().mockResolvedValue(["@smoke"]),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(runner.receivedCalls[0].markerExpression).toBeNull();
  });

  it("skips tag selection entirely when no feature has any tag", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(callbacks.selectTags).not.toHaveBeenCalled();
    expect(runner.receivedCalls[0].markerExpression).toBeNull();
  });

  it('maps capture mode "off" to screenshot/video off', async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(runner.receivedCalls[0].screenshotMode).toBe("off");
    expect(runner.receivedCalls[0].videoMode).toBe("off");
  });

  it('maps capture mode "only-on-failure" to screenshot only-on-failure / video retain-on-failure', async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("only-on-failure"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(runner.receivedCalls[0].screenshotMode).toBe("only-on-failure");
    expect(runner.receivedCalls[0].videoMode).toBe("retain-on-failure");
  });

  it('maps capture mode "always" to screenshot on / video on', async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("always"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(runner.receivedCalls[0].screenshotMode).toBe("on");
    expect(runner.receivedCalls[0].videoMode).toBe("on");
  });

  it("runs pytest with cwd = <testsDir> and writes the junit-xml under <testsDir>/results/latest.xml", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    const result = await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    const expectedCwd = path.join(tmpProject, "tests");
    const expectedXmlPath = path.join(expectedCwd, "results", "latest.xml");
    expect(runner.receivedCalls[0].cwd).toBe(expectedCwd);
    expect(result.junitXmlPath).toBe(expectedXmlPath);
    expect(runner.receivedCalls[0].junitXmlPath).toBe(expectedXmlPath);
    const dirExists = await fs
      .stat(path.join(expectedCwd, "results"))
      .then((s) => s.isDirectory(), () => false);
    expect(dirExists).toBe(true);
  });

  it("computes htmlReportPath under <testsDir>/results/latest.html and passes it to the TestRunner", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    const result = await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    const expectedHtmlPath = path.join(tmpProject, "tests", "results", "latest.html");
    expect(result.htmlReportPath).toBe(expectedHtmlPath);
    expect(runner.receivedCalls[0].htmlReportPath).toBe(expectedHtmlPath);
  });

  it("returns exitCode and browserSetupWarning from the TestRunner result", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([
      { exitCode: 1, browserSetupWarning: 'Ejecuta "playwright install".' },
    ]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    const result = await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(result.exitCode).toBe(1);
    expect(result.browserSetupWarning).toBe('Ejecuta "playwright install".');
  });

  it("defaults testEnv to an empty object when not given", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(runner.receivedCalls[0].env).toEqual({});
  });

  it("forwards the given testEnv to the runner", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks, { AGENTE_QA_APP_URL: "https://mi-app.com" });

    expect(runner.receivedCalls[0].env).toEqual({ AGENTE_QA_APP_URL: "https://mi-app.com" });
  });

  it("passes headed: false and verboseSteps: false when headedMode is false", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, false, callbacks);

    expect(runner.receivedCalls[0].headed).toBe(false);
    expect(runner.receivedCalls[0].verboseSteps).toBe(false);
  });

  it("passes headed: true and verboseSteps: true when headedMode is true", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, true, callbacks);

    expect(runner.receivedCalls[0].headed).toBe(true);
    expect(runner.receivedCalls[0].verboseSteps).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/ejecutor/runEjecutor.test.ts`
Expected: FAIL — `runEjecutor` no acepta todavía el 4º parámetro `headedMode` (error de tipos: demasiados argumentos / argumento de tipo incorrecto).

- [ ] **Step 3: Implement**

`core/src/agents/ejecutor/runEjecutor.ts` (fichero completo):

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TestRunner } from "../../testRun/testRunner.js";
import { listFeatureFiles } from "../generador/listFeatureFiles.js";
import { listAvailableTags } from "./listAvailableTags.js";

export type CaptureMode = "off" | "only-on-failure" | "always";

export interface ExecutorCallbacks {
  selectTags(availableTags: string[]): Promise<string[]>;
  selectCaptureMode(): Promise<CaptureMode>;
  onOutput(chunk: string): void;
}

export interface EjecutorResult {
  exitCode: number;
  junitXmlPath: string;
  htmlReportPath: string;
  browserSetupWarning?: string;
}

const PYTEST_MARKER_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function buildMarkerExpression(availableTags: string[], selectedTags: string[]): string | null {
  const allSelected =
    selectedTags.length === availableTags.length && availableTags.every((tag) => selectedTags.includes(tag));
  if (allSelected) return null;
  return selectedTags
    .map((tag) => {
      const stripped = tag.replace(/^@/, "");
      if (!PYTEST_MARKER_TOKEN.test(stripped)) {
        throw new Error(
          `El tag "${tag}" no se puede usar como filtro de pytest (solo se permiten letras, números y "_", empezando por letra o "_"). Selecciona otro subconjunto de tags.`
        );
      }
      return stripped;
    })
    .join(" or ");
}

function captureModeToFlags(mode: CaptureMode): {
  screenshotMode: "off" | "only-on-failure" | "on";
  videoMode: "off" | "retain-on-failure" | "on";
} {
  switch (mode) {
    case "off":
      return { screenshotMode: "off", videoMode: "off" };
    case "only-on-failure":
      return { screenshotMode: "only-on-failure", videoMode: "retain-on-failure" };
    case "always":
      return { screenshotMode: "on", videoMode: "on" };
  }
}

export async function runEjecutor(
  projectRoot: string,
  testsDir: string,
  runner: TestRunner,
  headedMode: boolean,
  callbacks: ExecutorCallbacks,
  testEnv: Record<string, string> = {}
): Promise<EjecutorResult> {
  const featureFiles = await listFeatureFiles(projectRoot, testsDir);
  if (featureFiles.length === 0) {
    throw new Error("No hay tests generados todavía. Usa 'Generar tests Playwright' primero.");
  }

  const availableTags = await listAvailableTags(projectRoot, testsDir);

  let markerExpression: string | null = null;
  if (availableTags.length > 0) {
    const selectedTags = await callbacks.selectTags(availableTags);
    markerExpression = buildMarkerExpression(availableTags, selectedTags);
  }

  const mode = await callbacks.selectCaptureMode();
  const { screenshotMode, videoMode } = captureModeToFlags(mode);

  const cwd = path.join(projectRoot, testsDir);
  const resultsDir = path.join(cwd, "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const junitXmlPath = path.join(resultsDir, "latest.xml");
  const htmlReportPath = path.join(resultsDir, "latest.html");

  const result = await runner.run({
    cwd,
    markerExpression,
    screenshotMode,
    videoMode,
    headed: headedMode,
    verboseSteps: headedMode,
    junitXmlPath,
    htmlReportPath,
    onOutput: callbacks.onOutput,
    env: testEnv,
  });

  return {
    exitCode: result.exitCode,
    junitXmlPath,
    htmlReportPath,
    browserSetupWarning: result.browserSetupWarning,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/ejecutor/runEjecutor.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/ejecutor/runEjecutor.ts core/src/agents/ejecutor/runEjecutor.test.ts
git commit -m "feat(core): thread headedMode through runEjecutor into TestRunOptions"
```

---

## Task 4: `withTestRunnerSpinner`

**Files:**
- Modify: `cli/src/util/spinner.ts`
- Modify: `cli/src/util/spinner.test.ts`

**Interfaces:**
- Consumes: `TestRunner`, `TestRunOptions`, `TestRunResult` (Task 2, exportados ya desde `@agente-qa/core`)
- Produces: `withTestRunnerSpinner(runner: TestRunner): TestRunner` — arranca un spinner antes de `runner.run()`, lo para en el primer `onOutput`; si `run()` lanza antes de que llegue ningún chunk, marca el spinner como fallido con `.fail(...)`.

- [ ] **Step 1: Write the failing test**

Reemplaza `cli/src/util/spinner.test.ts` en su totalidad (añade `stop` al mock del spinner y un `describe` nuevo):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, Message, CodeChecker, CodeFile, TestRunner, TestRunOptions } from "@agente-qa/core";

const spinnerInstance = {
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
  stop: vi.fn(),
};
spinnerInstance.start.mockReturnValue(spinnerInstance);

const oraFactory = vi.fn((_text: string) => spinnerInstance);

vi.mock("ora", () => ({
  default: (text: string) => oraFactory(text),
}));

import { withLLMSpinner, withCodeCheckerSpinner, withTestRunnerSpinner } from "./spinner.js";

describe("withLLMSpinner", () => {
  beforeEach(() => {
    oraFactory.mockClear();
    spinnerInstance.start.mockClear();
    spinnerInstance.succeed.mockClear();
    spinnerInstance.fail.mockClear();
    spinnerInstance.stop.mockClear();
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
    spinnerInstance.stop.mockClear();
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
    const files = [{ path: "a.py", content: "pass\n" }];

    await wrapped.check(files);

    expect(check).toHaveBeenCalledWith(files);
  });
});

describe("withTestRunnerSpinner", () => {
  beforeEach(() => {
    oraFactory.mockClear();
    spinnerInstance.start.mockClear();
    spinnerInstance.succeed.mockClear();
    spinnerInstance.fail.mockClear();
    spinnerInstance.stop.mockClear();
  });

  function baseOptions(onOutput: (chunk: string) => void): TestRunOptions {
    return {
      cwd: "/tmp/project/tests",
      markerExpression: null,
      screenshotMode: "off",
      videoMode: "off",
      headed: false,
      verboseSteps: false,
      junitXmlPath: "/tmp/project/tests/results/latest.xml",
      htmlReportPath: "/tmp/project/tests/results/latest.html",
      onOutput,
      env: {},
    };
  }

  it("starts a spinner before running, and stops it as soon as the first output chunk arrives", async () => {
    const chunks: string[] = [];
    const runner: TestRunner = {
      run: vi.fn(async (options: TestRunOptions) => {
        options.onOutput("primera línea\n");
        options.onOutput("segunda línea\n");
        return { exitCode: 0 };
      }),
    };
    const wrapped = withTestRunnerSpinner(runner);

    const result = await wrapped.run(baseOptions((chunk) => chunks.push(chunk)));

    expect(oraFactory).toHaveBeenCalledWith("Ejecutando tests...");
    expect(spinnerInstance.start).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.stop).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(["primera línea\n", "segunda línea\n"]);
    expect(result).toEqual({ exitCode: 0 });
  });

  it("stops the spinner even if the runner never emits any output", async () => {
    const runner: TestRunner = { run: vi.fn().mockResolvedValue({ exitCode: 0 }) };
    const wrapped = withTestRunnerSpinner(runner);

    await wrapped.run(baseOptions(() => {}));

    expect(spinnerInstance.stop).toHaveBeenCalledTimes(1);
  });

  it("marks the spinner as failed and rethrows when the runner throws before emitting any output", async () => {
    const boom = new Error("no se pudo lanzar pytest");
    const runner: TestRunner = { run: vi.fn().mockRejectedValue(boom) };
    const wrapped = withTestRunnerSpinner(runner);

    await expect(wrapped.run(baseOptions(() => {}))).rejects.toBe(boom);
    expect(spinnerInstance.fail).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.stop).not.toHaveBeenCalled();
  });

  it("does not call fail when the runner throws after already emitting output (spinner already stopped)", async () => {
    const boom = new Error("pytest crasheó a medias");
    const runner: TestRunner = {
      run: vi.fn(async (options: TestRunOptions) => {
        options.onOutput("algo de output\n");
        throw boom;
      }),
    };
    const wrapped = withTestRunnerSpinner(runner);

    await expect(wrapped.run(baseOptions(() => {}))).rejects.toBe(boom);
    expect(spinnerInstance.stop).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.fail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/util/spinner.test.ts`
Expected: FAIL — `withTestRunnerSpinner` no existe todavía en `./spinner.js`.

- [ ] **Step 3: Implement**

`cli/src/util/spinner.ts` (fichero completo):

```ts
import ora from "ora";
import type {
  LLMProvider,
  Message,
  CodeChecker,
  CodeFile,
  CodeCheckResult,
  TestRunner,
  TestRunOptions,
  TestRunResult,
} from "@agente-qa/core";

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

export function withTestRunnerSpinner(runner: TestRunner): TestRunner {
  return {
    async run(options: TestRunOptions): Promise<TestRunResult> {
      const spinner = ora("Ejecutando tests...").start();
      let spinnerStopped = false;
      const wrappedOnOutput = (chunk: string): void => {
        if (!spinnerStopped) {
          spinnerStopped = true;
          spinner.stop();
        }
        options.onOutput(chunk);
      };
      try {
        const result = await runner.run({ ...options, onOutput: wrappedOnOutput });
        if (!spinnerStopped) {
          spinner.stop();
        }
        return result;
      } catch (err) {
        if (!spinnerStopped) {
          spinner.fail("Fallo al ejecutar los tests.");
        }
        throw err;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/util/spinner.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/util/spinner.ts cli/src/util/spinner.test.ts
git commit -m "feat(cli): add withTestRunnerSpinner, stops on first pytest output"
```

---

## Task 5: `core/src/config/projectGitignore.ts`

**Files:**
- Create: `core/src/config/projectGitignore.ts`
- Test: `core/src/config/projectGitignore.test.ts`
- Modify: `core/src/index.ts`
- Modify: `core/src/index.test.ts`

**Interfaces:**
- Produces: `projectGitignorePath(projectRoot: string): string`; `readProjectGitignoreEntries(projectRoot: string): Promise<string[]>` (líneas no vacías, recortadas); `appendProjectGitignoreEntries(projectRoot: string, entries: string[]): Promise<void>` (crea el fichero si no existe, añade sin tocar lo ya presente, no-op si `entries` está vacío).

- [ ] **Step 1: Write the failing test**

`core/src/config/projectGitignore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectGitignorePath,
  readProjectGitignoreEntries,
  appendProjectGitignoreEntries,
} from "./projectGitignore.js";

describe("projectGitignore", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-gitignore-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  describe("readProjectGitignoreEntries", () => {
    it("returns an empty array when no .gitignore exists", async () => {
      expect(await readProjectGitignoreEntries(tmpProject)).toEqual([]);
    });

    it("returns trimmed, non-empty lines from an existing .gitignore", async () => {
      await fs.writeFile(projectGitignorePath(tmpProject), "node_modules\n\n  tests/results  \n", "utf-8");
      expect(await readProjectGitignoreEntries(tmpProject)).toEqual(["node_modules", "tests/results"]);
    });
  });

  describe("appendProjectGitignoreEntries", () => {
    it("creates the .gitignore when it doesn't exist yet", async () => {
      await appendProjectGitignoreEntries(tmpProject, ["node_modules"]);
      expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe("node_modules\n");
    });

    it("appends to an existing .gitignore without touching what's already there", async () => {
      await fs.writeFile(projectGitignorePath(tmpProject), "dist\n", "utf-8");
      await appendProjectGitignoreEntries(tmpProject, ["node_modules", "tests/results"]);
      expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe(
        "dist\nnode_modules\ntests/results\n"
      );
    });

    it("adds a leading newline when the existing file doesn't end with one", async () => {
      await fs.writeFile(projectGitignorePath(tmpProject), "dist", "utf-8");
      await appendProjectGitignoreEntries(tmpProject, ["node_modules"]);
      expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe("dist\nnode_modules\n");
    });

    it("does nothing when entries is empty", async () => {
      await appendProjectGitignoreEntries(tmpProject, []);
      const exists = await fs.stat(projectGitignorePath(tmpProject)).then(() => true, () => false);
      expect(exists).toBe(false);
    });
  });
});
```

Añade este `it` dentro del `describe("@agente-qa/core public API", ...)` existente en `core/src/index.test.ts` (justo después del bloque `"exports the config functions"`):

```ts
  it("exports the project gitignore functions", () => {
    expect(typeof core.projectGitignorePath).toBe("function");
    expect(typeof core.readProjectGitignoreEntries).toBe("function");
    expect(typeof core.appendProjectGitignoreEntries).toBe("function");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/config/projectGitignore.test.ts core/src/index.test.ts`
Expected: FAIL — `Cannot find module './projectGitignore.js'`; `core.projectGitignorePath` etc. `undefined`.

- [ ] **Step 3: Implement**

`core/src/config/projectGitignore.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";

export function projectGitignorePath(projectRoot: string): string {
  return path.join(projectRoot, ".gitignore");
}

export async function readProjectGitignoreEntries(projectRoot: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(projectGitignorePath(projectRoot), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function appendProjectGitignoreEntries(projectRoot: string, entries: string[]): Promise<void> {
  if (entries.length === 0) return;

  const filePath = projectGitignorePath(projectRoot);
  let existing: string;
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      existing = "";
    } else {
      throw err;
    }
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const block = `${needsLeadingNewline ? "\n" : ""}${entries.join("\n")}\n`;
  await fs.appendFile(filePath, block, "utf-8");
}
```

En `core/src/index.ts`, añade justo después del bloque de exports de `projectConfig.js`:

```ts
export {
  projectGitignorePath,
  readProjectGitignoreEntries,
  appendProjectGitignoreEntries,
} from "./config/projectGitignore.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/config/projectGitignore.test.ts core/src/index.test.ts`
Expected: PASS (5 + el total ya existente de `index.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add core/src/config/projectGitignore.ts core/src/config/projectGitignore.test.ts core/src/index.ts core/src/index.test.ts
git commit -m "feat(core): add projectGitignore helpers and export them"
```

---

## Task 6: `init.ts` pregunta modo headed y entradas de `.gitignore`

**Files:**
- Modify: `cli/src/prompts/types.ts`
- Modify: `cli/src/prompts/inquirerPrompts.ts`
- Modify: `cli/src/commands/init.ts`
- Modify: `cli/src/commands/init.test.ts`

**Interfaces:**
- Consumes: `saveProjectConfig` (Task 1, ahora acepta `headedMode` opcional en la entrada), `readProjectGitignoreEntries`/`appendProjectGitignoreEntries` (Task 5)
- Produces: `InitPrompts` gana `confirmHeadedMode(): Promise<boolean>` y `selectGitignoreEntries(candidates: string[]): Promise<string[]>`; `InitResult` gana `gitignoreEntriesAdded: string[]`.

- [ ] **Step 1: Write the failing test**

Reemplaza `cli/src/commands/init.test.ts` en su totalidad:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectConfig, projectEnvPath, projectGitignorePath } from "@agente-qa/core";
import { runInit } from "./init.js";
import type { InitPrompts } from "../prompts/types.js";

function prompts(overrides: Partial<InitPrompts> = {}): InitPrompts {
  return {
    inputTestsDir: async () => "tests",
    confirmHeadedMode: async () => false,
    selectGitignoreEntries: async (candidates) => candidates,
    ...overrides,
  };
}

describe("runInit", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-init-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("saves the project config from the prompt answers", async () => {
    await runInit(prompts(), tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests", headedMode: false });
  });

  it("saves headedMode: true when the user confirms it", async () => {
    await runInit(prompts({ confirmHeadedMode: async () => true }), tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests", headedMode: true });
  });

  it("creates the .env template when it doesn't exist yet, and reports it as created", async () => {
    const result = await runInit(prompts(), tmpProject);

    expect(result.envCreated).toBe(true);
    expect(result.envPath).toBe(projectEnvPath(tmpProject));
    const exists = await fs.stat(projectEnvPath(tmpProject)).then(() => true, () => false);
    expect(exists).toBe(true);
  });

  it("does not overwrite an existing .env, and reports it as not created", async () => {
    await runInit(prompts(), tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");

    const result = await runInit(prompts(), tmpProject);

    expect(result.envCreated).toBe(false);
    expect(await fs.readFile(projectEnvPath(tmpProject), "utf-8")).toBe(
      "AGENTE_QA_APP_URL=https://mi-app.com\n"
    );
  });

  it("asks about .gitignore entries and writes what the user chose when the project has no .gitignore yet", async () => {
    const result = await runInit(prompts(), tmpProject);

    expect(result.gitignoreEntriesAdded).toEqual(["node_modules", "tests/results", "tests/test-results"]);
    expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe(
      "node_modules\ntests/results\ntests/test-results\n"
    );
  });

  it("only asks about entries that are missing, leaving already-present ones untouched", async () => {
    await fs.writeFile(projectGitignorePath(tmpProject), "node_modules\n", "utf-8");
    let askedWith: string[] = [];

    const result = await runInit(
      prompts({
        selectGitignoreEntries: async (candidates) => {
          askedWith = candidates;
          return candidates;
        },
      }),
      tmpProject
    );

    expect(askedWith).toEqual(["tests/results", "tests/test-results"]);
    expect(result.gitignoreEntriesAdded).toEqual(["tests/results", "tests/test-results"]);
    expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe(
      "node_modules\ntests/results\ntests/test-results\n"
    );
  });

  it("never calls selectGitignoreEntries when every candidate is already present", async () => {
    await fs.writeFile(
      projectGitignorePath(tmpProject),
      "node_modules\ntests/results\ntests/test-results\n",
      "utf-8"
    );
    let called = false;

    const result = await runInit(
      prompts({
        selectGitignoreEntries: async (candidates) => {
          called = true;
          return candidates;
        },
      }),
      tmpProject
    );

    expect(called).toBe(false);
    expect(result.gitignoreEntriesAdded).toEqual([]);
  });

  it("respects a partial selection from selectGitignoreEntries (user unchecked some candidates)", async () => {
    const result = await runInit(prompts({ selectGitignoreEntries: async () => ["node_modules"] }), tmpProject);

    expect(result.gitignoreEntriesAdded).toEqual(["node_modules"]);
    expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe("node_modules\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: FAIL — `InitPrompts` no tiene `confirmHeadedMode`/`selectGitignoreEntries` (error de tipos); `runInit` no devuelve `gitignoreEntriesAdded`.

- [ ] **Step 3: Implement**

En `cli/src/prompts/types.ts`, reemplaza solo la interfaz `InitPrompts`:

```ts
export interface InitPrompts {
  inputTestsDir(): Promise<string>;
  confirmHeadedMode(): Promise<boolean>;
  selectGitignoreEntries(candidates: string[]): Promise<string[]>;
}
```

En `cli/src/prompts/inquirerPrompts.ts`, reemplaza solo el bloque `realInitPrompts` (deja el resto del fichero igual, incluido el import de `select`/`input`/`checkbox` ya existente en la primera línea):

```ts
export const realInitPrompts: InitPrompts = {
  async inputTestsDir() {
    return input({ message: "¿En qué carpeta guardamos los tests? (relativa al proyecto)", default: "tests" });
  },
  async confirmHeadedMode() {
    return select<boolean>({
      message: "¿Ejecutar los tests con el navegador visible?",
      choices: [
        { name: "No, en segundo plano (recomendado)", value: false },
        { name: "Sí, ver el navegador mientras corren", value: true },
      ],
      default: false,
    });
  },
  async selectGitignoreEntries(candidates) {
    return checkbox({
      message: "¿Qué añado al .gitignore del proyecto?",
      choices: candidates.map((entry) => ({ name: entry, value: entry, checked: true })),
    });
  },
};
```

`cli/src/commands/init.ts` (fichero completo):

```ts
import {
  ensureProjectEnvTemplate,
  saveProjectConfig,
  readProjectGitignoreEntries,
  appendProjectGitignoreEntries,
} from "@agente-qa/core";
import type { InitPrompts } from "../prompts/types.js";

export interface InitResult {
  testsDir: string;
  envPath: string;
  envCreated: boolean;
  gitignoreEntriesAdded: string[];
}

function gitignoreCandidates(testsDir: string): string[] {
  return ["node_modules", `${testsDir}/results`, `${testsDir}/test-results`];
}

export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  const headedMode = await prompts.confirmHeadedMode();
  await saveProjectConfig(projectRoot, { testsDir, headedMode });

  const { created, path: envPath } = await ensureProjectEnvTemplate(projectRoot);

  const existingGitignoreEntries = await readProjectGitignoreEntries(projectRoot);
  const candidates = gitignoreCandidates(testsDir);
  const missing = candidates.filter((entry) => !existingGitignoreEntries.includes(entry));
  let gitignoreEntriesAdded: string[] = [];
  if (missing.length > 0) {
    gitignoreEntriesAdded = await prompts.selectGitignoreEntries(missing);
    await appendProjectGitignoreEntries(projectRoot, gitignoreEntriesAdded);
  }

  return { testsDir, envPath, envCreated: created, gitignoreEntriesAdded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/prompts/types.ts cli/src/prompts/inquirerPrompts.ts cli/src/commands/init.ts cli/src/commands/init.test.ts
git commit -m "feat(cli): ask headed mode and missing .gitignore entries during init/config"
```

---

## Task 7: `execute.ts` usa el spinner y el modo headed

**Files:**
- Modify: `cli/src/commands/execute.ts`
- Modify: `cli/src/commands/execute.test.ts`

**Interfaces:**
- Consumes: `withTestRunnerSpinner` (Task 4), `runEjecutor` con `headedMode` (Task 3), `ProjectConfig.headedMode` (Task 1)

- [ ] **Step 1: Write the failing test**

Reemplaza `cli/src/commands/execute.test.ts` en su totalidad:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, ensureProjectEnvTemplate, projectEnvPath } from "@agente-qa/core";
import type { ExecutorPrompts } from "../prompts/types.js";

const realTestRunnerRunMock = vi.fn();
const withTestRunnerSpinnerMock = vi.fn((runner: unknown) => runner);

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    realTestRunner: { run: (...args: unknown[]) => realTestRunnerRunMock(...args) },
  };
});

vi.mock("../util/spinner.js", () => ({
  withTestRunnerSpinner: (runner: unknown) => withTestRunnerSpinnerMock(runner),
}));

import { runExecuteTests } from "./execute.js";

describe("runExecuteTests", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-execute-project-"));
    realTestRunnerRunMock.mockReset();
    withTestRunnerSpinnerMock.mockClear();
    withTestRunnerSpinnerMock.mockImplementation((runner: unknown) => runner);
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
    };
    await expect(runExecuteTests(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws a clear error when there are no generated tests yet", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");
    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
    };
    await expect(runExecuteTests(prompts, tmpProject)).rejects.toThrow(/Generar tests Playwright/);
  });

  it("throws a clear error naming AGENTE_QA_APP_URL when it's missing from the .env, without invoking the real test runner", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "@smoke\nFeature: Login\n", "utf-8");

    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
    };

    await expect(runExecuteTests(prompts, tmpProject)).rejects.toThrow(/AGENTE_QA_APP_URL/);
    expect(realTestRunnerRunMock).not.toHaveBeenCalled();
  });

  it("runs through the fake prompts and the mocked real test runner, returning its result", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "@smoke\nFeature: Login\n", "utf-8");

    realTestRunnerRunMock.mockResolvedValue({ exitCode: 0 });

    const prompts: ExecutorPrompts = {
      selectTags: vi.fn().mockResolvedValue(["@smoke"]),
      selectCaptureMode: vi.fn().mockResolvedValue("only-on-failure"),
    };

    const result = await runExecuteTests(prompts, tmpProject);

    expect(prompts.selectTags).toHaveBeenCalledWith(["@smoke"]);
    expect(result.exitCode).toBe(0);
    expect(result.junitXmlPath).toBe(path.join(tmpProject, "tests", "results", "latest.xml"));
    expect(realTestRunnerRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotMode: "only-on-failure", videoMode: "retain-on-failure" })
    );
  });

  it("passes the app URL and test credentials from the .env into the runner's env option", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
    await fs.writeFile(
      projectEnvPath(tmpProject),
      "AGENTE_QA_APP_URL=https://staging.mi-app.com\nAGENTE_QA_TEST_USERNAME=qa\nAGENTE_QA_TEST_PASSWORD=pwd\n",
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

  it("defaults to headless (headed: false, verboseSteps: false) when headedMode wasn't set at init", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");
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
      expect.objectContaining({ headed: false, verboseSteps: false })
    );
  });

  it("passes headed: true and verboseSteps: true through when the project config has headedMode: true", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", headedMode: true });
    await ensureProjectEnvTemplate(tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");
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
      expect.objectContaining({ headed: true, verboseSteps: true })
    );
  });

  it("wraps the real test runner with the spinner decorator before using it", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "Feature: Login\n", "utf-8");

    realTestRunnerRunMock.mockResolvedValue({ exitCode: 0 });

    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
    };

    await runExecuteTests(prompts, tmpProject);

    expect(withTestRunnerSpinnerMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/commands/execute.test.ts`
Expected: FAIL — `execute.ts` no importa/usa todavía `withTestRunnerSpinner` ni lee `headedMode`; `runEjecutor` se sigue llamando con la firma antigua (error de tipos).

- [ ] **Step 3: Implement**

`cli/src/commands/execute.ts` (fichero completo):

```ts
import path from "node:path";
import {
  loadProjectConfig,
  loadProjectEnv,
  requireAppUrl,
  projectEnvPath,
  testEnvVars,
  realTestRunner,
  runEjecutor,
  type ExecutorCallbacks,
  type EjecutorResult,
} from "@agente-qa/core";
import type { ExecutorPrompts } from "../prompts/types.js";
import { withTestRunnerSpinner } from "../util/spinner.js";

export async function runExecuteTests(prompts: ExecutorPrompts, projectRoot: string): Promise<EjecutorResult> {
  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  requireAppUrl(env, projectEnvPath(projectRoot));

  const callbacks: ExecutorCallbacks = {
    selectTags: (availableTags) => prompts.selectTags(availableTags),
    selectCaptureMode: () => prompts.selectCaptureMode(),
    onOutput: (chunk) => {
      process.stdout.write(chunk);
    },
  };

  return runEjecutor(
    projectRoot,
    projectConfig.testsDir,
    withTestRunnerSpinner(realTestRunner),
    projectConfig.headedMode,
    callbacks,
    testEnvVars(env)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/commands/execute.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/execute.ts cli/src/commands/execute.test.ts
git commit -m "feat(cli): wrap the real test runner with a spinner and pass headedMode through"
```

---

## Task 8: `cli/src/util/openFile.ts`

**Files:**
- Create: `cli/src/util/openFile.ts`
- Test: `cli/src/util/openFile.test.ts`

**Interfaces:**
- Produces: `resolveOpenCommand(kind: "markdown" | "html", filePath: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { command: string; args: string[] }` (pura, testeada exhaustivamente); `openFile(kind: "markdown" | "html", filePath: string): Promise<void>` (spawn real, no testeada — ver Global Constraints).

- [ ] **Step 1: Write the failing test**

`cli/src/util/openFile.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveOpenCommand } from "./openFile.js";

describe("resolveOpenCommand", () => {
  it("opens a markdown file with 'code' when inside a VSCode terminal", () => {
    expect(resolveOpenCommand("markdown", "/tmp/summary.md", { TERM_PROGRAM: "vscode" }, "linux")).toEqual({
      command: "code",
      args: ["/tmp/summary.md"],
    });
  });

  it("opens an html file with the OS opener even inside a VSCode terminal", () => {
    expect(resolveOpenCommand("html", "/tmp/report.html", { TERM_PROGRAM: "vscode" }, "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/report.html"],
    });
  });

  it("opens a markdown file with the OS opener when not inside VSCode", () => {
    expect(resolveOpenCommand("markdown", "/tmp/summary.md", {}, "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/summary.md"],
    });
  });

  it('uses \'cmd /c start "" <path>\' on win32', () => {
    expect(resolveOpenCommand("html", "C:\\tmp\\report.html", {}, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "C:\\tmp\\report.html"],
    });
  });

  it("uses 'open' on darwin", () => {
    expect(resolveOpenCommand("html", "/tmp/report.html", {}, "darwin")).toEqual({
      command: "open",
      args: ["/tmp/report.html"],
    });
  });

  it("uses 'xdg-open' on any other platform", () => {
    expect(resolveOpenCommand("markdown", "/tmp/summary.md", {}, "freebsd")).toEqual({
      command: "xdg-open",
      args: ["/tmp/summary.md"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/util/openFile.test.ts`
Expected: FAIL — `Cannot find module './openFile.js'`.

- [ ] **Step 3: Implement**

`cli/src/util/openFile.ts`:

```ts
import { spawn } from "node:child_process";

export type FileKind = "markdown" | "html";

export interface OpenCommand {
  command: string;
  args: string[];
}

export function resolveOpenCommand(
  kind: FileKind,
  filePath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): OpenCommand {
  if (kind === "markdown" && env.TERM_PROGRAM === "vscode") {
    return { command: "code", args: [filePath] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", filePath] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [filePath] };
  }
  return { command: "xdg-open", args: [filePath] };
}

function trySpawn(cmd: OpenCommand): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd.command, cmd.args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function openFile(kind: FileKind, filePath: string): Promise<void> {
  const primary = resolveOpenCommand(kind, filePath, process.env, process.platform);
  const launched = await trySpawn(primary);
  if (launched || primary.command !== "code") return;

  // "code" wasn't on PATH even though we're inside a VSCode terminal — fall
  // back to the operating system's own opener instead of failing silently.
  const fallback = resolveOpenCommand(kind, filePath, {}, process.platform);
  await trySpawn(fallback);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/util/openFile.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/util/openFile.ts cli/src/util/openFile.test.ts
git commit -m "feat(cli): add openFile (resolveOpenCommand tested, real spawn deliberately untested)"
```

---

## Task 9: `reports.ts` abre los ficheros generados

**Files:**
- Modify: `cli/src/commands/reports.ts`
- Modify: `cli/src/commands/reports.test.ts`

**Interfaces:**
- Consumes: `openFile` (Task 8)

- [ ] **Step 1: Write the failing test**

Reemplaza `cli/src/commands/reports.test.ts` en su totalidad:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig } from "@agente-qa/core";
import type { ReportesPrompts } from "../prompts/types.js";

const openFileMock = vi.fn();
vi.mock("../util/openFile.js", () => ({
  openFile: (...args: unknown[]) => openFileMock(...args),
}));

import { runGenerateReports } from "./reports.js";

const sampleXml = `<testsuites>
  <testsuite name="pytest" tests="1" time="0.4">
    <testcase classname="tests.test_x" name="test_ok" time="0.4" />
  </testsuite>
</testsuites>`;

describe("runGenerateReports", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-reports-project-"));
    openFileMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: ReportesPrompts = { selectDetailLevel: vi.fn() };
    await expect(runGenerateReports(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws a clear error when there are no results yet", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    const prompts: ReportesPrompts = { selectDetailLevel: vi.fn() };
    await expect(runGenerateReports(prompts, tmpProject)).rejects.toThrow(/Ejecutar tests/);
  });

  it("reads the junit-xml, asks for the detail level, and returns the result", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    const resultsDir = path.join(tmpProject, "tests", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, "latest.xml"), sampleXml, "utf-8");

    const prompts: ReportesPrompts = {
      selectDetailLevel: vi.fn().mockResolvedValue("resumen"),
    };

    const result = await runGenerateReports(prompts, tmpProject);

    expect(prompts.selectDetailLevel).toHaveBeenCalledTimes(1);
    expect(result.totalTests).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.summaryPath).toBe(path.join(resultsDir, "summary.md"));
  });

  it('opens only the markdown summary when the chosen level is "resumen"', async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    const resultsDir = path.join(tmpProject, "tests", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, "latest.xml"), sampleXml, "utf-8");

    const prompts: ReportesPrompts = {
      selectDetailLevel: vi.fn().mockResolvedValue("resumen"),
    };

    const result = await runGenerateReports(prompts, tmpProject);

    expect(openFileMock).toHaveBeenCalledTimes(1);
    expect(openFileMock).toHaveBeenCalledWith("markdown", result.summaryPath);
  });

  it('opens both the markdown summary and the html report when the chosen level is "completo"', async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    const resultsDir = path.join(tmpProject, "tests", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, "latest.xml"), sampleXml, "utf-8");

    const prompts: ReportesPrompts = {
      selectDetailLevel: vi.fn().mockResolvedValue("completo"),
    };

    const result = await runGenerateReports(prompts, tmpProject);

    expect(openFileMock).toHaveBeenCalledTimes(2);
    expect(openFileMock).toHaveBeenCalledWith("markdown", result.summaryPath);
    expect(openFileMock).toHaveBeenCalledWith("html", result.htmlReportPath);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/commands/reports.test.ts`
Expected: FAIL — `reports.ts` no llama a `openFile` todavía; el mock de `../util/openFile.js` nunca se invoca.

- [ ] **Step 3: Implement**

`cli/src/commands/reports.ts` (fichero completo):

```ts
import {
  loadProjectConfig,
  runReportes,
  type ReportesCallbacks,
  type ReportesResult,
} from "@agente-qa/core";
import type { ReportesPrompts } from "../prompts/types.js";
import { openFile } from "../util/openFile.js";

export async function runGenerateReports(
  prompts: ReportesPrompts,
  projectRoot: string
): Promise<ReportesResult> {
  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  let detailLevel: "resumen" | "completo" = "resumen";
  const callbacks: ReportesCallbacks = {
    selectDetailLevel: async () => {
      detailLevel = await prompts.selectDetailLevel();
      return detailLevel;
    },
  };

  const result = await runReportes(projectRoot, projectConfig.testsDir, callbacks);

  await openFile("markdown", result.summaryPath);
  if (detailLevel === "completo") {
    await openFile("html", result.htmlReportPath);
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/commands/reports.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/reports.ts cli/src/commands/reports.test.ts
git commit -m "feat(cli): open the generated report files after 'Ver/generar reportes'"
```

---

## Task 10: `menu.ts` informa de las entradas de `.gitignore` añadidas

**Files:**
- Modify: `cli/src/menu.ts`
- Modify: `cli/src/menu.test.ts`

**Interfaces:**
- Consumes: `InitResult.gitignoreEntriesAdded` (Task 6)

- [ ] **Step 1: Write the failing test**

En `cli/src/menu.test.ts`, actualiza el mock de `runInitMock` en el test `"routes 'config' to runInit"` (añade `gitignoreEntriesAdded: []`) y añade un test nuevo justo después de ese bloque:

```ts
  it("routes 'config' to runInit", async () => {
    const choices: MenuChoice[] = ["config", "exit"];
    let i = 0;
    runInitMock.mockResolvedValue({
      testsDir: "tests",
      envPath: "/project/test/.agente-qa/.env",
      envCreated: true,
      gitignoreEntriesAdded: [],
    });

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      projectRoot: "/project/test",
    });

    expect(runInitMock).toHaveBeenCalledTimes(1);
  });

  it("prints which .gitignore entries were added when runInit reports some", async () => {
    const choices: MenuChoice[] = ["config", "exit"];
    let i = 0;
    runInitMock.mockResolvedValue({
      testsDir: "tests",
      envPath: "/project/test/.agente-qa/.env",
      envCreated: false,
      gitignoreEntriesAdded: ["node_modules", "tests/results"],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      projectRoot: "/project/test",
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Añadido al .gitignore: node_modules, tests/results")
    );

    logSpy.mockRestore();
  });
```

(El resto de `cli/src/menu.test.ts` no cambia.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/menu.test.ts`
Expected: FAIL — el nuevo test no encuentra el mensaje del `.gitignore` en ningún `console.log`.

- [ ] **Step 3: Implement**

En `cli/src/menu.ts`, dentro del `case "config":`, añade una línea justo antes del `break;` (deja el resto del `switch` igual):

```ts
      case "config": {
        try {
          const result = await runInit(deps.initPrompts, deps.projectRoot);
          console.log("Configuración de tests guardada.");
          if (result.envCreated) {
            console.log(
              `Se ha creado ${result.envPath} — rellena las variables a mano antes de usar el resto de comandos.`
            );
          } else {
            console.log(`Ya existía ${result.envPath} — revísalo si quieres cambiar algo.`);
          }
          if (result.gitignoreEntriesAdded.length > 0) {
            console.log(`Añadido al .gitignore: ${result.gitignoreEntriesAdded.join(", ")}`);
          }
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/menu.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/menu.ts cli/src/menu.test.ts
git commit -m "feat(cli): print .gitignore entries added by init/config"
```

---

## Full verification (run once all tasks are complete)

```bash
npx tsc -p core/tsconfig.json --noEmit
npx tsc -p cli/tsconfig.json --noEmit
npx vitest run
```

Todas deben quedar limpias/verdes — es la definición de "hecho" de este proyecto (CLAUDE.md).
