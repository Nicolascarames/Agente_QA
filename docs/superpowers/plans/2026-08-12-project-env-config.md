# Project-scoped .env config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interactive-prompt LLM credentials (`~/.agente-qa/credentials.json`, global) and the missing "app under test" config with a single project-scoped `<projectRoot>/.agente-qa/.env` file that the user fills in by hand, and wire it through every command that needs it (LLM calls, and the app URL/test login credentials read by generated Playwright tests).

**Architecture:** New `core/src/config/projectEnv.ts` module owns the `.env` template, parsing (via `dotenv`), Zod validation, and two small helpers (`requireLlmConfig`, `testEnvVars`) that each CLI command uses to get exactly the slice of config it needs, with a friendly Spanish error naming the missing `AGENTE_QA_*` variable when something required is blank. `TestRunner`/`realTestRunner` gain an `env` option so the app URL/test credentials reach the `pytest` subprocess; the code-generation prompt is updated so generated Python never hardcodes them. `core/src/config/credentials.ts` (the old global store) is deleted outright — no migration, per explicit user decision.

**Tech Stack:** TypeScript (Node >=22, ESM/NodeNext), Zod v4, `dotenv` (new dependency, `parse()` only — never `config()`), Vitest.

## Global Constraints

- Idioma: mensajes de cara al usuario (errores, prompts, README) en castellano; código/identificadores/commits en inglés (Conventional Commits).
- `core/src` nunca hace I/O de terminal (nada de `console.*`/`readline`); toda interacción cruza callbacks inyectados o valores de retorno leídos por la capa `cli`.
- DI explícita: funciones de `core` reciben `projectRoot` como parámetro, nunca leen `process.cwd()` internamente.
- Imports relativos con sufijo `.js` aunque el fichero sea `.ts` (ESM NodeNext).
- Node >=22 (ya fijado en ambos `package.json`).
- Tras cualquier cambio de dependencias en un `package.json`, regenerar el lockfile en el mismo commit.
- `cli`'s `tsc` necesita `core/dist/` construido para resolver `@agente-qa/core` (`npm run build --workspace=core` antes de `npx tsc -p cli/tsconfig.json --noEmit`); `vitest run` no lo necesita (alía directo a `core/src`).
- Verificación por tarea: `npx vitest run <archivos tocados>` en verde + `npx tsc -p core/tsconfig.json --noEmit` (y `-p cli/tsconfig.json` cuando la tarea toca `cli`) limpio, antes de cada commit.

---

### Task 1: `core/src/config/projectEnv.ts` — plantilla, parseo y validación del `.env` de proyecto

**Files:**
- Modify: `core/package.json` (add `dotenv` dependency)
- Modify: `package-lock.json` (regenerated)
- Create: `core/src/config/projectEnv.ts`
- Test: `core/src/config/projectEnv.test.ts`
- Modify: `core/src/index.ts` (additive barrel exports — do NOT export `ProviderNameSchema`/`ProviderName` yet, `credentials.ts` still owns those names until Task 11)

**Interfaces:**
- Produces: `ProviderNameSchema` (zod enum `"anthropic"|"openai"|"google"|"openai-compatible"`), `ProviderName` (type), `ProjectEnvSchema` (zod object, all fields optional: `appUrl`, `testUsername`, `testPassword`, `llmProvider`, `llmApiKey`, `llmBaseURL`, `llmModel`), `ProjectEnv` (type), `LlmCredentials` (interface: `{ provider: ProviderName; apiKey: string; baseURL?: string; model?: string }`), `projectEnvPath(projectRoot: string): string`, `ensureProjectEnvTemplate(projectRoot: string): Promise<{ created: boolean; path: string }>`, `loadProjectEnv(projectRoot: string): Promise<ProjectEnv | null>`, `requireLlmConfig(env: ProjectEnv, envPath: string): LlmCredentials` (throws `Error` naming missing `AGENTE_QA_*` vars), `testEnvVars(env: ProjectEnv): Record<string, string>` (maps `appUrl`/`testUsername`/`testPassword` to their `AGENTE_QA_*` names, omitting absent ones).

- [ ] **Step 1: Add the `dotenv` dependency**

Run: `npm install dotenv@^17.4.2 --workspace=core`

This updates `core/package.json`'s `dependencies` and regenerates the root `package-lock.json` in one step.

- [ ] **Step 2: Write the failing test file**

Create `core/src/config/projectEnv.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectEnvPath,
  ensureProjectEnvTemplate,
  loadProjectEnv,
  requireLlmConfig,
  testEnvVars,
} from "./projectEnv.js";

describe("projectEnv", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-projectenv-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  describe("projectEnvPath", () => {
    it("points at <project>/.agente-qa/.env", () => {
      expect(projectEnvPath(tmpProject)).toBe(path.join(tmpProject, ".agente-qa", ".env"));
    });
  });

  describe("ensureProjectEnvTemplate", () => {
    it("creates the .env template and the .gitignore when neither exists", async () => {
      const result = await ensureProjectEnvTemplate(tmpProject);

      expect(result).toEqual({ created: true, path: projectEnvPath(tmpProject) });
      const envContent = await fs.readFile(projectEnvPath(tmpProject), "utf-8");
      expect(envContent).toContain("AGENTE_QA_APP_URL=");
      expect(envContent).toContain("AGENTE_QA_LLM_API_KEY=");

      const gitignoreContent = await fs.readFile(
        path.join(tmpProject, ".agente-qa", ".gitignore"),
        "utf-8"
      );
      expect(gitignoreContent).toBe(".env\n");
    });

    it("does not overwrite an existing .env", async () => {
      await ensureProjectEnvTemplate(tmpProject);
      await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");

      const result = await ensureProjectEnvTemplate(tmpProject);

      expect(result).toEqual({ created: false, path: projectEnvPath(tmpProject) });
      const envContent = await fs.readFile(projectEnvPath(tmpProject), "utf-8");
      expect(envContent).toBe("AGENTE_QA_APP_URL=https://mi-app.com\n");
    });

    describe.skipIf(process.platform === "win32")("file permissions (POSIX only)", () => {
      it("writes .env with mode 0600 (owner read/write only)", async () => {
        await ensureProjectEnvTemplate(tmpProject);
        const stats = await fs.stat(projectEnvPath(tmpProject));
        expect(stats.mode & 0o777).toBe(0o600);
      });
    });
  });

  describe("loadProjectEnv", () => {
    it("returns null when no .env file exists", async () => {
      expect(await loadProjectEnv(tmpProject)).toBeNull();
    });

    it("returns all-undefined fields when the file exists but is the blank template", async () => {
      await ensureProjectEnvTemplate(tmpProject);

      expect(await loadProjectEnv(tmpProject)).toEqual({
        appUrl: undefined,
        testUsername: undefined,
        testPassword: undefined,
        llmProvider: undefined,
        llmApiKey: undefined,
        llmBaseURL: undefined,
        llmModel: undefined,
      });
    });

    async function writeEnv(values: Record<string, string>): Promise<void> {
      await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
      const content = Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      await fs.writeFile(projectEnvPath(tmpProject), `${content}\n`, "utf-8");
    }

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

    it("treats a whitespace-only value as absent", async () => {
      await writeEnv({ AGENTE_QA_APP_URL: "   " });

      expect((await loadProjectEnv(tmpProject))?.appUrl).toBeUndefined();
    });

    it("throws a clear error naming AGENTE_QA_APP_URL when it's present but not a valid URL", async () => {
      await writeEnv({ AGENTE_QA_APP_URL: "not-a-url" });

      await expect(loadProjectEnv(tmpProject)).rejects.toThrow(/AGENTE_QA_APP_URL/);
    });

    it("throws a clear error naming AGENTE_QA_LLM_PROVIDER when it has an invalid value", async () => {
      await writeEnv({ AGENTE_QA_LLM_PROVIDER: "not-a-real-provider" });

      await expect(loadProjectEnv(tmpProject)).rejects.toThrow(/AGENTE_QA_LLM_PROVIDER/);
    });
  });

  describe("requireLlmConfig", () => {
    const envPath = "/fake/.agente-qa/.env";
    const blank = {
      appUrl: undefined,
      testUsername: undefined,
      testPassword: undefined,
      llmProvider: undefined,
      llmApiKey: undefined,
      llmBaseURL: undefined,
      llmModel: undefined,
    };

    it("returns provider/apiKey/baseURL/model when all needed fields are present", () => {
      const result = requireLlmConfig(
        {
          ...blank,
          llmProvider: "openai-compatible",
          llmApiKey: "k",
          llmBaseURL: "https://api.groq.com/openai/v1",
          llmModel: "llama-3.3-70b-versatile",
        },
        envPath
      );

      expect(result).toEqual({
        provider: "openai-compatible",
        apiKey: "k",
        baseURL: "https://api.groq.com/openai/v1",
        model: "llama-3.3-70b-versatile",
      });
    });

    it("throws naming AGENTE_QA_LLM_PROVIDER and AGENTE_QA_LLM_API_KEY when both are missing", () => {
      expect(() => requireLlmConfig(blank, envPath)).toThrow(
        /AGENTE_QA_LLM_PROVIDER.*AGENTE_QA_LLM_API_KEY/s
      );
    });

    it("throws naming AGENTE_QA_LLM_BASE_URL and AGENTE_QA_LLM_MODEL when provider is openai-compatible but they're missing", () => {
      expect(() =>
        requireLlmConfig({ ...blank, llmProvider: "openai-compatible", llmApiKey: "k" }, envPath)
      ).toThrow(/AGENTE_QA_LLM_BASE_URL.*AGENTE_QA_LLM_MODEL/s);
    });
  });

  describe("testEnvVars", () => {
    const blank = {
      appUrl: undefined,
      testUsername: undefined,
      testPassword: undefined,
      llmProvider: undefined,
      llmApiKey: undefined,
      llmBaseURL: undefined,
      llmModel: undefined,
    };

    it("maps present app-testing fields to their AGENTE_QA_* names", () => {
      expect(
        testEnvVars({ ...blank, appUrl: "https://mi-app.com", testUsername: "qa", testPassword: "pwd" })
      ).toEqual({
        AGENTE_QA_APP_URL: "https://mi-app.com",
        AGENTE_QA_TEST_USERNAME: "qa",
        AGENTE_QA_TEST_PASSWORD: "pwd",
      });
    });

    it("omits absent fields entirely rather than including them as empty strings", () => {
      expect(testEnvVars({ ...blank, appUrl: "https://mi-app.com" })).toEqual({
        AGENTE_QA_APP_URL: "https://mi-app.com",
      });
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run core/src/config/projectEnv.test.ts`
Expected: FAIL — cannot find module `./projectEnv.js`.

- [ ] **Step 4: Write the implementation**

Create `core/src/config/projectEnv.ts`:

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

export const ProviderNameSchema = z.enum(["anthropic", "openai", "google", "openai-compatible"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const ProjectEnvSchema = z.object({
  appUrl: z.string().url().optional(),
  testUsername: z.string().min(1).optional(),
  testPassword: z.string().min(1).optional(),
  llmProvider: ProviderNameSchema.optional(),
  llmApiKey: z.string().min(1).optional(),
  llmBaseURL: z.string().url().optional(),
  llmModel: z.string().min(1).optional(),
});
export type ProjectEnv = z.infer<typeof ProjectEnvSchema>;

export interface LlmCredentials {
  provider: ProviderName;
  apiKey: string;
  baseURL?: string;
  model?: string;
}

const ENV_VAR_KEYS: Record<keyof ProjectEnv, string> = {
  appUrl: "AGENTE_QA_APP_URL",
  testUsername: "AGENTE_QA_TEST_USERNAME",
  testPassword: "AGENTE_QA_TEST_PASSWORD",
  llmProvider: "AGENTE_QA_LLM_PROVIDER",
  llmApiKey: "AGENTE_QA_LLM_API_KEY",
  llmBaseURL: "AGENTE_QA_LLM_BASE_URL",
  llmModel: "AGENTE_QA_LLM_MODEL",
};

export function projectEnvDir(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa");
}

export function projectEnvPath(projectRoot: string): string {
  return path.join(projectEnvDir(projectRoot), ".env");
}

const ENV_TEMPLATE = `# .env de agente-qa para este proyecto.
# Este archivo NUNCA se sube a git (ver .agente-qa/.gitignore) — puedes guardar aquí
# datos sensibles (API keys, contraseñas de test) con tranquilidad.
# Rellena los valores que necesites y guarda el archivo. Las líneas que empiezan
# por "#" son solo explicación, no hace falta tocarlas.

# ── Aplicación bajo test ──────────────────────────────────────────────
# URL base de la app que vas a probar. Obligatoria para generar y ejecutar tests.
# Ejemplo: AGENTE_QA_APP_URL=https://staging.mi-app.com
AGENTE_QA_APP_URL=

# Usuario y contraseña de una cuenta de prueba, solo si vas a probar flujos de
# login. Opcional: si los dejas vacíos, no podrás generar/ejecutar escenarios
# que dependan de iniciar sesión.
# Ejemplo: AGENTE_QA_TEST_USERNAME=qa-tester@mi-app.com
AGENTE_QA_TEST_USERNAME=
# Ejemplo: AGENTE_QA_TEST_PASSWORD=Sup3rSecreta!
AGENTE_QA_TEST_PASSWORD=

# ── Proveedor LLM (genera y verifica los tests) ───────────────────────
# Uno de: anthropic | openai | google | openai-compatible
# Ejemplo: AGENTE_QA_LLM_PROVIDER=anthropic
AGENTE_QA_LLM_PROVIDER=

# Tu clave de API del proveedor elegido arriba. Obligatoria.
# Ejemplo: AGENTE_QA_LLM_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
AGENTE_QA_LLM_API_KEY=

# Solo si AGENTE_QA_LLM_PROVIDER=openai-compatible (Groq, Together, Ollama local...):
# Ejemplo: AGENTE_QA_LLM_BASE_URL=https://api.groq.com/openai/v1
AGENTE_QA_LLM_BASE_URL=
# Ejemplo: AGENTE_QA_LLM_MODEL=llama-3.3-70b-versatile
AGENTE_QA_LLM_MODEL=
`;

export async function ensureProjectEnvTemplate(
  projectRoot: string
): Promise<{ created: boolean; path: string }> {
  const dirPath = projectEnvDir(projectRoot);
  const filePath = projectEnvPath(projectRoot);

  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });

  const exists = await fs.stat(filePath).then(
    () => true,
    () => false
  );
  if (exists) {
    return { created: false, path: filePath };
  }

  await fs.writeFile(path.join(dirPath, ".gitignore"), ".env\n", "utf-8");
  await fs.writeFile(filePath, ENV_TEMPLATE, { encoding: "utf-8", mode: 0o600 });

  return { created: true, path: filePath };
}

export async function loadProjectEnv(projectRoot: string): Promise<ProjectEnv | null> {
  const filePath = projectEnvPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const parsed = parseDotenv(raw);
  const nonEmpty = (key: string): string | undefined => {
    const value = parsed[key];
    return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
  };

  const candidate = {
    appUrl: nonEmpty(ENV_VAR_KEYS.appUrl),
    testUsername: nonEmpty(ENV_VAR_KEYS.testUsername),
    testPassword: nonEmpty(ENV_VAR_KEYS.testPassword),
    llmProvider: nonEmpty(ENV_VAR_KEYS.llmProvider),
    llmApiKey: nonEmpty(ENV_VAR_KEYS.llmApiKey),
    llmBaseURL: nonEmpty(ENV_VAR_KEYS.llmBaseURL),
    llmModel: nonEmpty(ENV_VAR_KEYS.llmModel),
  };

  const result = ProjectEnvSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${ENV_VAR_KEYS[issue.path[0] as keyof ProjectEnv]}: ${issue.message}`)
      .join("\n");
    throw new Error(`El archivo ${filePath} tiene valores inválidos:\n${details}`);
  }

  return result.data;
}

export function requireLlmConfig(env: ProjectEnv, envPath: string): LlmCredentials {
  const missing: string[] = [];
  if (!env.llmProvider) missing.push(ENV_VAR_KEYS.llmProvider);
  if (!env.llmApiKey) missing.push(ENV_VAR_KEYS.llmApiKey);
  if (env.llmProvider === "openai-compatible") {
    if (!env.llmBaseURL) missing.push(ENV_VAR_KEYS.llmBaseURL);
    if (!env.llmModel) missing.push(ENV_VAR_KEYS.llmModel);
  }
  if (missing.length > 0) {
    throw new Error(`Faltan variables en ${envPath}: ${missing.join(", ")}. Rellénalas y guarda el archivo.`);
  }
  return {
    provider: env.llmProvider as ProviderName,
    apiKey: env.llmApiKey as string,
    baseURL: env.llmBaseURL,
    model: env.llmModel,
  };
}

export function testEnvVars(env: ProjectEnv): Record<string, string> {
  const vars: Record<string, string> = {};
  if (env.appUrl) vars[ENV_VAR_KEYS.appUrl] = env.appUrl;
  if (env.testUsername) vars[ENV_VAR_KEYS.testUsername] = env.testUsername;
  if (env.testPassword) vars[ENV_VAR_KEYS.testPassword] = env.testPassword;
  return vars;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run core/src/config/projectEnv.test.ts`
Expected: PASS (all cases; the POSIX-only permissions block is skipped on Windows).

- [ ] **Step 6: Export the new module from the barrel (additive only)**

In `core/src/index.ts`, add this block anywhere near the existing `./config/projectConfig.js` export (do **not** touch the existing `./config/credentials.js` export block yet — it still owns `ProviderNameSchema`/`ProviderName`, removed only in Task 11):

```typescript
export {
  ProjectEnvSchema,
  projectEnvPath,
  ensureProjectEnvTemplate,
  loadProjectEnv,
  requireLlmConfig,
  testEnvVars,
} from "./config/projectEnv.js";
export type { ProjectEnv, LlmCredentials } from "./config/projectEnv.js";
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add core/package.json package-lock.json core/src/config/projectEnv.ts core/src/config/projectEnv.test.ts core/src/index.ts
git commit -m "feat(core): add project-scoped .env config module"
```

---

### Task 2: Point `createProvider` at the new `LlmCredentials` type

**Files:**
- Modify: `core/src/llm/factory.ts`

**Interfaces:**
- Consumes: `LlmCredentials`, `ProviderName` from `../config/projectEnv.js` (Task 1).
- Produces: `createProvider(credentials: LlmCredentials): LLMProvider` (same behavior, new parameter type — no signature-shape change, `LlmCredentials` and the old `Credentials` type were structurally identical).

- [ ] **Step 1: Confirm the existing test still describes the desired behavior**

`core/src/llm/factory.test.ts` already calls `createProvider({...})` with plain object literals (no import of the `Credentials` type), so no test changes are needed for this task. Run it now to record the baseline:

Run: `npx vitest run core/src/llm/factory.test.ts`
Expected: PASS (baseline, using the old `credentials.ts`-typed `createProvider`).

- [ ] **Step 2: Update the import and error message**

Replace the full content of `core/src/llm/factory.ts`:

```typescript
import type { LlmCredentials } from "../config/projectEnv.js";
import type { LLMProvider } from "./provider.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createGoogleProvider } from "./providers/google.js";

export function createProvider(credentials: LlmCredentials): LLMProvider {
  switch (credentials.provider) {
    case "anthropic":
      return createAnthropicProvider(credentials.apiKey);
    case "openai":
      return createOpenAIProvider(credentials.apiKey);
    case "google":
      return createGoogleProvider(credentials.apiKey);
    case "openai-compatible": {
      if (!credentials.baseURL || !credentials.model) {
        throw new Error(
          "Faltan 'baseURL' o 'model' en las credenciales del proveedor 'openai-compatible'. Revisa el archivo .env del proyecto."
        );
      }
      return createOpenAIProvider(credentials.apiKey, credentials.model, credentials.baseURL);
    }
  }
}
```

- [ ] **Step 3: Run the test to verify it still passes**

Run: `npx vitest run core/src/llm/factory.test.ts`
Expected: PASS (the `/baseURL|model/` regex in the last test still matches the new message).

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add core/src/llm/factory.ts
git commit -m "refactor(core): point createProvider at the new LlmCredentials type"
```

---

### Task 3: `TestRunOptions` gains `env`, `realTestRunner` forwards it to the pytest subprocess

**Files:**
- Modify: `core/src/testRun/testRunner.ts`
- Modify: `core/src/testRun/realTestRunner.ts`
- Modify: `core/src/testRun/realTestRunner.test.ts`

**Interfaces:**
- Produces: `TestRunOptions.env: Record<string, string>` (new required field — merged with `process.env` before spawning `python`).

- [ ] **Step 1: Update `baseOptions()` and the existing inline run() call to include `env`, and add the new failing test**

In `core/src/testRun/realTestRunner.test.ts`, update `baseOptions()`:

```typescript
function baseOptions(overrides: Partial<TestRunOptions> = {}): TestRunOptions {
  return {
    cwd: process.cwd(),
    markerExpression: null,
    screenshotMode: "off",
    videoMode: "off",
    junitXmlPath: path.join(os.tmpdir(), "agente-qa-realtestrunner-preflight.xml"),
    htmlReportPath: path.join(os.tmpdir(), "agente-qa-realtestrunner-preflight.html"),
    onOutput: () => {},
    env: {},
    ...overrides,
  };
}
```

In the same file, add `env: {}` to the existing inline `realTestRunner.run({...})` call inside `"runs a trivial pytest-bdd scenario and writes the junit-xml and the html report"` (right after `onOutput: (chunk) => { output += chunk; },`):

```typescript
        const result = await realTestRunner.run({
          cwd: tmpDir,
          markerExpression: null,
          screenshotMode: "off",
          videoMode: "off",
          junitXmlPath,
          htmlReportPath,
          onOutput: (chunk) => {
            output += chunk;
          },
          env: {},
        });
```

Then add a new test in the same `describe.skipIf(!hasPytestStack)(...)` block, right after the existing `it("runs a trivial pytest-bdd scenario...")` block:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail on the type (env doesn't exist on TestRunOptions yet)**

Run: `npx vitest run core/src/testRun/realTestRunner.test.ts`
Expected: FAIL — TypeScript error, `env` does not exist on type `TestRunOptions`.

- [ ] **Step 3: Add `env` to `TestRunOptions`**

Replace the full content of `core/src/testRun/testRunner.ts`:

```typescript
export interface TestRunOptions {
  cwd: string;
  markerExpression: string | null;
  screenshotMode: "off" | "only-on-failure" | "on";
  videoMode: "off" | "retain-on-failure" | "on";
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

- [ ] **Step 4: Thread `env` through `realTestRunner`'s spawn calls**

Replace the full content of `core/src/testRun/realTestRunner.ts`:

```typescript
import { spawn } from "node:child_process";
import type { TestRunner, TestRunOptions, TestRunResult } from "./testRunner.js";

export class MissingTestToolError extends Error {
  constructor(detail: string) {
    super(
      `No se pudo ejecutar los tests: ${detail}. Instala las dependencias con "pip install pytest pytest-bdd pytest-playwright pytest-html" y luego "playwright install".`
    );
    this.name = "MissingTestToolError";
  }
}

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCapture(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runStreaming(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onOutput: (chunk: string) => void
): Promise<{ code: number | null; combinedOutput: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let combinedOutput = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      combinedOutput += text;
      onOutput(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      combinedOutput += text;
      onOutput(text);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, combinedOutput }));
  });
}

const BROWSER_MISSING_SIGNATURE = "playwright install";
const BROWSER_SETUP_WARNING = 'Parece que faltan los navegadores de Playwright. Ejecuta "playwright install".';

export function createRealTestRunner(options?: { pythonCommand?: string }): TestRunner {
  const pythonCommand = options?.pythonCommand ?? "python";

  return {
    async run(runOptions: TestRunOptions): Promise<TestRunResult> {
      const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...runOptions.env };

      let preflight: CaptureResult;
      try {
        preflight = await runCapture(
          pythonCommand,
          ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"],
          runOptions.cwd,
          mergedEnv
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new MissingTestToolError(`no se encontró "${pythonCommand}" en el sistema`);
        }
        throw err;
      }
      if (preflight.code !== 0) {
        throw new MissingTestToolError(
          `faltan dependencias Python (pytest, pytest-bdd, pytest-playwright o pytest-html)\n${preflight.stderr || preflight.stdout}`
        );
      }

      const args = ["-m", "pytest"];
      if (runOptions.markerExpression) {
        args.push("-m", runOptions.markerExpression);
      }
      args.push(`--screenshot=${runOptions.screenshotMode}`);
      args.push(`--video=${runOptions.videoMode}`);
      args.push(`--junitxml=${runOptions.junitXmlPath}`);
      args.push(`--html=${runOptions.htmlReportPath}`, "--self-contained-html");

      const { code, combinedOutput } = await runStreaming(
        pythonCommand,
        args,
        runOptions.cwd,
        mergedEnv,
        runOptions.onOutput
      );

      return {
        exitCode: code ?? 1,
        browserSetupWarning: combinedOutput.includes(BROWSER_MISSING_SIGNATURE)
          ? BROWSER_SETUP_WARNING
          : undefined,
      };
    },
  };
}

export const realTestRunner: TestRunner = createRealTestRunner();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run core/src/testRun/realTestRunner.test.ts`
Expected: PASS (the Python-dependent tests run only if `hasPytestStack`; the two "missing tool" tests always run and stay green).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add core/src/testRun/testRunner.ts core/src/testRun/realTestRunner.ts core/src/testRun/realTestRunner.test.ts
git commit -m "feat(core): thread custom env vars through the pytest test runner"
```

---

### Task 4: `runEjecutor` forwards a `testEnv` parameter to the `TestRunner`

**Files:**
- Modify: `core/src/agents/ejecutor/runEjecutor.ts`
- Modify: `core/src/agents/ejecutor/runEjecutor.test.ts`

**Interfaces:**
- Consumes: `TestRunOptions.env` (Task 3).
- Produces: `runEjecutor(projectRoot, testsDir, runner, callbacks, testEnv: Record<string, string> = {})` (new optional 5th parameter, defaults to `{}` — every existing call site keeps compiling unchanged).

- [ ] **Step 1: Write the failing tests**

In `core/src/agents/ejecutor/runEjecutor.test.ts`, add these two tests at the end of the `describe("runEjecutor", ...)` block, right before the closing `});`:

```typescript
  it("defaults testEnv to an empty object when not given", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, callbacks);

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

    await runEjecutor(tmpProject, "tests", runner, callbacks, { AGENTE_QA_APP_URL: "https://mi-app.com" });

    expect(runner.receivedCalls[0].env).toEqual({ AGENTE_QA_APP_URL: "https://mi-app.com" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/agents/ejecutor/runEjecutor.test.ts`
Expected: FAIL — `runner.receivedCalls[0].env` is `undefined`, not `{}` / not the passed object (and a TS error once Task 3 lands, since `env` is required on `TestRunOptions` but `runEjecutor` doesn't set it yet).

- [ ] **Step 3: Add the `testEnv` parameter and forward it**

In `core/src/agents/ejecutor/runEjecutor.ts`, update the function signature and the `runner.run(...)` call:

```typescript
export async function runEjecutor(
  projectRoot: string,
  testsDir: string,
  runner: TestRunner,
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

(Only the function signature line and the `runner.run({...})` call change; everything above/below stays as-is.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run core/src/agents/ejecutor/runEjecutor.test.ts`
Expected: PASS — all existing tests plus the 2 new ones.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add core/src/agents/ejecutor/runEjecutor.ts core/src/agents/ejecutor/runEjecutor.test.ts
git commit -m "feat(core): forward test env vars from runEjecutor to the TestRunner"
```

---

### Task 5: Generated tests read the app URL/test credentials from env vars, never literal values

**Files:**
- Modify: `core/src/prompts/generador.ts`
- Modify: `core/src/agents/generador/codeGenerator.test.ts`

**Interfaces:**
- No signature changes — this only changes the text of the prompt sent to the LLM.

- [ ] **Step 1: Write the failing test**

In `core/src/agents/generador/codeGenerator.test.ts`, add this test right after the existing `"sends the feature text, pattern skeleton, and exact naming to the model when a pattern matched"` test:

```typescript
  it("instructs the model to read the app URL and test credentials from environment variables, never literal values", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("AGENTE_QA_APP_URL");
    expect(userMessage?.content).toContain("AGENTE_QA_TEST_USERNAME");
    expect(userMessage?.content).toContain("AGENTE_QA_TEST_PASSWORD");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: FAIL — prompt doesn't mention `AGENTE_QA_APP_URL`.

- [ ] **Step 3: Add the instruction to the prompt**

In `core/src/prompts/generador.ts`, insert a new paragraph right after the sentence about `pytest-playwright`'s `page` fixture and before `"Genera EXACTAMENTE dos bloques..."`. The function becomes:

```typescript
  return `Eres un ingeniero de QA experto en Playwright + Python + pytest-bdd + Page Object Model.

Dado este archivo Gherkin ya aprobado, ubicado en "features/${naming.featureFileName}":
"""
${featureText}
"""

${patternSection}

El proyecto ya tiene instalado el plugin "pytest-playwright": el fixture "page" (una página de navegador ya lista) está disponible automáticamente en cualquier test, no lo definas tú ni escribas ningún conftest.py.

La URL de la aplicación bajo test y las credenciales de una cuenta de prueba NUNCA se escriben como texto literal en este código: se guarda en el repositorio del usuario. Léelas siempre con "os.environ": "os.environ[\"AGENTE_QA_APP_URL\"]" para la URL base, y si el escenario prueba un login, "os.environ[\"AGENTE_QA_TEST_USERNAME\"]" / "os.environ[\"AGENTE_QA_TEST_PASSWORD\"]" para usuario y contraseña.

Genera EXACTAMENTE dos bloques de código, cada uno empezando por una línea con este formato exacto "# FILE: <ruta>", seguida del contenido completo de ese archivo. No incluyas explicaciones fuera de los bloques ni bloques de código markdown (\`\`\`).

Los dos archivos, en este orden, usando exactamente estos nombres (no inventes otros):
1. "tests/test_${naming.slug}.py" — step definitions pytest-bdd. Importa "scenarios" de "pytest_bdd" y llama "scenarios(\"../features/${naming.featureFileName}\")". Importa de "pytest_bdd" solo los decoradores "given"/"when"/"then" que realmente vayas a usar según los pasos del feature (no importes los que no uses). Usa el fixture "page" (parámetro de las funciones step) para interactuar con el navegador a través del Page Object.
2. "pages/${naming.slug}_page.py" — clase(s) Page Object en Python (Playwright sync API) para las pantallas involucradas, recibiendo "page" en su constructor.${retrySection}`;
```

(Only the new paragraph is inserted; everything else in the template literal is unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add core/src/prompts/generador.ts core/src/agents/generador/codeGenerator.test.ts
git commit -m "feat(core): instruct generated tests to read app URL/test creds from env vars"
```

---

### Task 6: `init` creates the project `.env` template instead of asking for LLM credentials

**Files:**
- Modify: `cli/src/prompts/types.ts`
- Modify: `cli/src/prompts/inquirerPrompts.ts`
- Modify: `cli/src/commands/init.ts`
- Modify: `cli/src/commands/init.test.ts`
- Modify: `cli/bin/agente-qa.ts` (only the `init` command's `.action()` body)

**Interfaces:**
- Consumes: `ensureProjectEnvTemplate`, `saveProjectConfig` (already exported) from `@agente-qa/core`.
- Produces: `InitPrompts` shrinks to `{ inputTestsDir(): Promise<string> }`. `runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult>` where `InitResult = { testsDir: string; envPath: string; envCreated: boolean }` (drops the `homeDir` parameter it used to take).

- [ ] **Step 1: Write the failing test**

Replace the full content of `cli/src/commands/init.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectConfig, projectEnvPath } from "@agente-qa/core";
import { runInit } from "./init.js";
import type { InitPrompts } from "../prompts/types.js";

describe("runInit", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-init-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("saves the project config from the prompt answer", async () => {
    const prompts: InitPrompts = { inputTestsDir: async () => "tests" };

    await runInit(prompts, tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests" });
  });

  it("creates the .env template when it doesn't exist yet, and reports it as created", async () => {
    const prompts: InitPrompts = { inputTestsDir: async () => "tests" };

    const result = await runInit(prompts, tmpProject);

    expect(result.envCreated).toBe(true);
    expect(result.envPath).toBe(projectEnvPath(tmpProject));
    const exists = await fs.stat(projectEnvPath(tmpProject)).then(() => true, () => false);
    expect(exists).toBe(true);
  });

  it("does not overwrite an existing .env, and reports it as not created", async () => {
    const prompts: InitPrompts = { inputTestsDir: async () => "tests" };
    await runInit(prompts, tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");

    const result = await runInit(prompts, tmpProject);

    expect(result.envCreated).toBe(false);
    expect(await fs.readFile(projectEnvPath(tmpProject), "utf-8")).toBe(
      "AGENTE_QA_APP_URL=https://mi-app.com\n"
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: FAIL — `runInit` still has the old `(prompts, homeDir, projectRoot)` signature and `InitPrompts` still requires `selectProvider`/etc.

- [ ] **Step 3: Shrink `InitPrompts`**

Replace the `InitPrompts` interface in `cli/src/prompts/types.ts` (drop the `import type { ProviderName } from "@agente-qa/core";` line at the top too, since nothing in this file uses it anymore):

```typescript
export interface InitPrompts {
  inputTestsDir(): Promise<string>;
}
```

- [ ] **Step 4: Shrink `realInitPrompts`**

In `cli/src/prompts/inquirerPrompts.ts`, replace the import line and the `realInitPrompts` export:

```typescript
import { select, input, checkbox } from "@inquirer/prompts";
```

```typescript
export const realInitPrompts: InitPrompts = {
  async inputTestsDir() {
    return input({ message: "¿En qué carpeta guardamos los tests? (relativa al proyecto)", default: "tests" });
  },
};
```

(Remove the `password` import and the `selectProvider`/`inputApiKey`/`inputBaseURL`/`inputModel` methods entirely; everything else in the file — `realMenuPrompts`, `buildRealChatPrompts`, etc. — stays unchanged.)

- [ ] **Step 5: Rewrite `runInit`**

Replace the full content of `cli/src/commands/init.ts`:

```typescript
import { ensureProjectEnvTemplate, saveProjectConfig } from "@agente-qa/core";
import type { InitPrompts } from "../prompts/types.js";

export interface InitResult {
  testsDir: string;
  envPath: string;
  envCreated: boolean;
}

export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  await saveProjectConfig(projectRoot, { testsDir });

  const { created, path: envPath } = await ensureProjectEnvTemplate(projectRoot);

  return { testsDir, envPath, envCreated: created };
}
```

- [ ] **Step 6: Update the `init` command wiring in `bin/agente-qa.ts`**

In `cli/bin/agente-qa.ts`, replace only the `init` command block (leave the `chat` command and the `os` import as they are — the `chat` command still needs `os.homedir()` until Task 10):

```typescript
program
  .command("init")
  .description("Configura las preferencias del proyecto y crea la plantilla de .env si falta")
  .action(async () => {
    const result = await runInit(realInitPrompts, process.cwd());
    console.log("Configuración de tests guardada.");
    if (result.envCreated) {
      console.log(
        `Se ha creado ${result.envPath} — rellena las variables a mano antes de usar el resto de comandos.`
      );
    } else {
      console.log(`Ya existía ${result.envPath} — revísalo si quieres cambiar algo.`);
    }
  });
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run:
```bash
npm run build --workspace=core
npx tsc -p cli/tsconfig.json --noEmit
```
Expected: no errors. (`menu.ts` and `menu.test.ts` will still fail here because `MenuDeps` isn't updated yet — that's expected and fixed in Task 10; if the errors are anywhere other than `menu.ts`/`menu.test.ts`, stop and fix them before continuing.)

- [ ] **Step 9: Commit**

```bash
git add cli/src/prompts/types.ts cli/src/prompts/inquirerPrompts.ts cli/src/commands/init.ts cli/src/commands/init.test.ts cli/bin/agente-qa.ts
git commit -m "feat(cli): init creates the project .env template instead of asking for LLM credentials"
```

---

### Task 7: `runCreatePlan` reads LLM credentials from the project `.env`

**Files:**
- Modify: `cli/src/commands/chat.ts`
- Modify: `cli/src/commands/chat.test.ts`
- Modify: `cli/src/commands/chat.e2e.test.ts`

**Interfaces:**
- Consumes: `loadProjectEnv`, `requireLlmConfig`, `projectEnvPath` (Task 1), `createProvider` (Task 2).
- Produces: `runCreatePlan(prompts: ChatPrompts, projectRoot: string): Promise<string>` (drops the `homeDir` parameter).

- [ ] **Step 1: Write the failing tests**

Replace the full content of `cli/src/commands/chat.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, projectEnvPath, FakeLLMProvider } from "@agente-qa/core";
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
  withLLMSpinner: (provider: unknown) => withLLMSpinnerMock(provider),
}));

import { runCreatePlan } from "./chat.js";

async function writeEnv(projectRoot: string, values: Record<string, string>): Promise<void> {
  await fs.mkdir(path.join(projectRoot, ".agente-qa"), { recursive: true });
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await fs.writeFile(projectEnvPath(projectRoot), `${content}\n`, "utf-8");
}

describe("runCreatePlan", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-chat-project-"));
    createProviderMock.mockReset();
    withLLMSpinnerMock.mockClear();
    withLLMSpinnerMock.mockImplementation((provider: unknown) => provider);
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: ChatPrompts = {
      inputInitialText: vi.fn(),
      askUser: vi.fn(),
      presentForApproval: vi.fn(),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };
    await expect(runCreatePlan(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws naming the missing .env variable when the LLM API key is blank", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic" });
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

    const prompts: ChatPrompts = {
      inputInitialText: vi.fn(),
      askUser: vi.fn(),
      presentForApproval: vi.fn(),
      confirmOverwrite: vi.fn(),
    };

    await expect(runCreatePlan(prompts, tmpProject)).rejects.toThrow(/AGENTE_QA_LLM_API_KEY/);
  });

  it("loads env/config, runs intake through the fake LLM, and writes the feature file", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
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

    const filePath = await runCreatePlan(prompts, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toContain("Feature: Login");
  });

  it("wraps the LLM provider with the spinner decorator before using it", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
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

    await runCreatePlan(prompts, tmpProject);

    expect(withLLMSpinnerMock.mock.calls[0][0]).toBe(fake);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run cli/src/commands/chat.test.ts`
Expected: FAIL — `runCreatePlan` still expects `(prompts, homeDir, projectRoot)`.

- [ ] **Step 3: Rewrite `runCreatePlan`**

Replace the full content of `cli/src/commands/chat.ts`:

```typescript
import {
  createProvider,
  loadProjectEnv,
  requireLlmConfig,
  loadProjectConfig,
  loadAllPatterns,
  runIntake,
  projectEnvPath,
  type IntakeCallbacks,
} from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";
import { withLLMSpinner } from "../util/spinner.js";

export async function runCreatePlan(prompts: ChatPrompts, projectRoot: string): Promise<string> {
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const llmCredentials = requireLlmConfig(env, projectEnvPath(projectRoot));

  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const llm = withLLMSpinner(createProvider(llmCredentials));
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run cli/src/commands/chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Update and run the e2e test**

Replace the full content of `cli/src/commands/chat.e2e.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, projectEnvPath } from "@agente-qa/core";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));
vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => provider,
}));

import { runCreatePlan } from "./chat.js";
import type { ChatPrompts } from "../prompts/types.js";

describe("end-to-end: create plan via the real wiring, only the network call mocked", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-e2e-project-"));
    await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
    await fs.writeFile(
      projectEnvPath(tmpProject),
      "AGENTE_QA_LLM_PROVIDER=anthropic\nAGENTE_QA_LLM_API_KEY=sk-test\n",
      "utf-8"
    );
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    generateTextMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("matches the built-in login pattern and writes an approved feature file", async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: '{"ambiguous": false, "questions": []}' })
      .mockResolvedValueOnce({ text: '{"matchedPatternName": "login"}' })
      .mockResolvedValueOnce({
        text: "Feature: Login\n  Scenario: acceso válido\n    Given a\n    When b\n    Then c\n",
      });

    const prompts: ChatPrompts = {
      inputInitialText: vi.fn().mockResolvedValue("Quiero probar que el login funciona"),
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const filePath = await runCreatePlan(prompts, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("Feature: Login");
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });
});
```

Run: `npx vitest run cli/src/commands/chat.e2e.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run:
```bash
npm run build --workspace=core
npx tsc -p cli/tsconfig.json --noEmit
```
Expected: no errors other than in `menu.ts`/`menu.test.ts` (fixed in Task 10).

- [ ] **Step 7: Commit**

```bash
git add cli/src/commands/chat.ts cli/src/commands/chat.test.ts cli/src/commands/chat.e2e.test.ts
git commit -m "feat(cli): create plan reads LLM credentials from the project .env"
```

---

### Task 8: `runGenerateTests` reads LLM credentials from the project `.env`

**Files:**
- Modify: `cli/src/commands/generate.ts`
- Modify: `cli/src/commands/generate.test.ts`
- Modify: `cli/src/commands/generate.e2e.test.ts`

**Interfaces:**
- Consumes: same as Task 7.
- Produces: `runGenerateTests(prompts: GeneratorPrompts, projectRoot: string): Promise<string[]>` (drops `homeDir`).

- [ ] **Step 1: Write the failing tests**

Replace the full content of `cli/src/commands/generate.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, projectEnvPath, FakeLLMProvider, realCodeChecker } from "@agente-qa/core";
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
  withLLMSpinner: (provider: unknown) => withLLMSpinnerMock(provider),
  withCodeCheckerSpinner: (checker: unknown) => withCodeCheckerSpinnerMock(checker),
}));

import { runGenerateTests } from "./generate.js";

async function writeEnv(projectRoot: string, values: Record<string, string>): Promise<void> {
  await fs.mkdir(path.join(projectRoot, ".agente-qa"), { recursive: true });
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await fs.writeFile(projectEnvPath(projectRoot), `${content}\n`, "utf-8");
}

describe("runGenerateTests", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-generate-project-"));
    createProviderMock.mockReset();
    realCodeCheckerCheckMock.mockReset();
    withLLMSpinnerMock.mockClear();
    withLLMSpinnerMock.mockImplementation((provider: unknown) => provider);
    withCodeCheckerSpinnerMock.mockClear();
    withCodeCheckerSpinnerMock.mockImplementation((checker: unknown) => checker);
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws a clear error when there are no approved .feature files yet", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpProject)).rejects.toThrow(/Crear plan de pruebas/);
  });

  it("lists feature files, generates code through the fake LLM, and writes the test files", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
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

    const writtenPaths = await runGenerateTests(prompts, tmpProject);

    expect(prompts.selectFeatureFile).toHaveBeenCalledWith(["login.feature"]);
    expect(writtenPaths).toHaveLength(2);
    expect(
      await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")
    ).toContain("scenarios(");
  });

  it("wraps the LLM provider and the code checker with their spinner decorators before using them", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
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

    await runGenerateTests(prompts, tmpProject);

    expect(withLLMSpinnerMock.mock.calls[0][0]).toBe(fake);
    expect(withCodeCheckerSpinnerMock.mock.calls[0][0]).toBe(realCodeChecker);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: FAIL — `runGenerateTests` still expects `(prompts, homeDir, projectRoot)`.

- [ ] **Step 3: Rewrite `runGenerateTests`**

Replace the full content of `cli/src/commands/generate.ts`:

```typescript
import path from "node:path";
import {
  createProvider,
  loadProjectEnv,
  requireLlmConfig,
  loadProjectConfig,
  loadAllPatterns,
  listFeatureFiles,
  realCodeChecker,
  runGenerador,
  projectEnvPath,
  type GeneratorCallbacks,
} from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";
import { withLLMSpinner, withCodeCheckerSpinner } from "../util/spinner.js";

export async function runGenerateTests(prompts: GeneratorPrompts, projectRoot: string): Promise<string[]> {
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const llmCredentials = requireLlmConfig(env, projectEnvPath(projectRoot));

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

  const llm = withLLMSpinner(createProvider(llmCredentials));
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: PASS.

- [ ] **Step 5: Update and run the e2e test**

Replace the full content of `cli/src/commands/generate.e2e.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { saveProjectConfig, projectEnvPath } from "@agente-qa/core";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}
const hasPython = commandExists("python");
const hasRuff = commandExists("ruff");

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));
vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => provider,
  withCodeCheckerSpinner: (checker: unknown) => checker,
}));

import { runGenerateTests } from "./generate.js";
import type { GeneratorPrompts } from "../prompts/types.js";

describe.skipIf(!hasPython || !hasRuff)(
  "end-to-end: generate tests via the real wiring, only the network call mocked",
  () => {
    let tmpProject: string;

    beforeEach(async () => {
      tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-gen-e2e-project-"));
      await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
      await fs.writeFile(
        projectEnvPath(tmpProject),
        "AGENTE_QA_LLM_PROVIDER=anthropic\nAGENTE_QA_LLM_API_KEY=sk-test\n",
        "utf-8"
      );
      await saveProjectConfig(tmpProject, { testsDir: "tests" });
      const featuresDir = path.join(tmpProject, "tests", "features");
      await fs.mkdir(featuresDir, { recursive: true });
      await fs.writeFile(
        path.join(featuresDir, "login.feature"),
        "# agente-qa:pattern=login\nFeature: Login\n  Scenario: x\n    Given a\n",
        "utf-8"
      );
      generateTextMock.mockReset();
    });

    afterEach(async () => {
      await fs.rm(tmpProject, { recursive: true, force: true });
    });

    it("generates and writes tests/pages for the built-in login pattern", async () => {
      generateTextMock.mockResolvedValueOnce({
        text: `# FILE: tests/test_login.py
from pytest_bdd import scenarios

scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page
`,
      });

      const prompts: GeneratorPrompts = {
        selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
        offerSavePattern: vi.fn(),
        confirmOverwrite: vi.fn().mockResolvedValue(true),
      };

      const writtenPaths = await runGenerateTests(prompts, tmpProject);

      expect(writtenPaths).toHaveLength(2);
      expect(prompts.offerSavePattern).not.toHaveBeenCalled();
    });
  }
);
```

Run: `npx vitest run cli/src/commands/generate.e2e.test.ts`
Expected: PASS (or skipped, if `python`/`ruff` aren't on `PATH`).

- [ ] **Step 6: Typecheck**

Run:
```bash
npm run build --workspace=core
npx tsc -p cli/tsconfig.json --noEmit
```
Expected: no errors other than in `menu.ts`/`menu.test.ts` (fixed in Task 10).

- [ ] **Step 7: Commit**

```bash
git add cli/src/commands/generate.ts cli/src/commands/generate.test.ts cli/src/commands/generate.e2e.test.ts
git commit -m "feat(cli): generate tests reads LLM credentials from the project .env"
```

---

### Task 9: `runExecuteTests` forwards the app URL/test credentials from the project `.env`

**Files:**
- Modify: `cli/src/commands/execute.ts`
- Modify: `cli/src/commands/execute.test.ts`
- Modify: `cli/src/commands/execute.e2e.test.ts`

**Interfaces:**
- Consumes: `loadProjectEnv`, `testEnvVars` (Task 1), `runEjecutor`'s new `testEnv` parameter (Task 4).
- Produces: `runExecuteTests` keeps its existing `(prompts, projectRoot)` signature — no change there, only its internals and its precondition (the `.env` must now exist too, not just `config.json`).

- [ ] **Step 1: Write the failing tests**

Replace the full content of `cli/src/commands/execute.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, ensureProjectEnvTemplate, projectEnvPath } from "@agente-qa/core";
import type { ExecutorPrompts } from "../prompts/types.js";

const realTestRunnerRunMock = vi.fn();

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    realTestRunner: { run: (...args: unknown[]) => realTestRunnerRunMock(...args) },
  };
});

import { runExecuteTests } from "./execute.js";

describe("runExecuteTests", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-execute-project-"));
    realTestRunnerRunMock.mockReset();
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
    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
    };
    await expect(runExecuteTests(prompts, tmpProject)).rejects.toThrow(/Generar tests Playwright/);
  });

  it("runs through the fake prompts and the mocked real test runner, returning its result", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run cli/src/commands/execute.test.ts`
Expected: FAIL — `runExecuteTests` doesn't check/forward the `.env` yet, so the new test's `env` expectation isn't met (and `ensureProjectEnvTemplate`/`projectEnvPath` aren't imported yet in `execute.ts`'s dependency graph is irrelevant here — the test itself already imports what it needs from the real `@agente-qa/core`).

- [ ] **Step 3: Rewrite `runExecuteTests`**

Replace the full content of `cli/src/commands/execute.ts`:

```typescript
import {
  loadProjectConfig,
  loadProjectEnv,
  testEnvVars,
  realTestRunner,
  runEjecutor,
  type ExecutorCallbacks,
  type EjecutorResult,
} from "@agente-qa/core";
import type { ExecutorPrompts } from "../prompts/types.js";

export async function runExecuteTests(prompts: ExecutorPrompts, projectRoot: string): Promise<EjecutorResult> {
  const projectConfig = await loadProjectConfig(projectRoot);
  if (!projectConfig) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }
  const env = await loadProjectEnv(projectRoot);
  if (!env) {
    throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  }

  const callbacks: ExecutorCallbacks = {
    selectTags: (availableTags) => prompts.selectTags(availableTags),
    selectCaptureMode: () => prompts.selectCaptureMode(),
    onOutput: (chunk) => {
      process.stdout.write(chunk);
    },
  };

  return runEjecutor(projectRoot, projectConfig.testsDir, realTestRunner, callbacks, testEnvVars(env));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run cli/src/commands/execute.test.ts`
Expected: PASS.

- [ ] **Step 5: Update and run the e2e test**

In `cli/src/commands/execute.e2e.test.ts`, add `ensureProjectEnvTemplate` to the import from `@agente-qa/core` and call it in `beforeEach`:

```typescript
import { saveProjectConfig, ensureProjectEnvTemplate } from "@agente-qa/core";
```

```typescript
    beforeEach(async () => {
      tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-exec-e2e-project-"));
      await saveProjectConfig(tmpProject, { testsDir: "tests" });
      await ensureProjectEnvTemplate(tmpProject);
      const featuresDir = path.join(tmpProject, "tests", "features");
```

(Only these two changes — the new import name and the one new line in `beforeEach`; the rest of the file, including the feature/test file writing and the `it(...)` block, stays exactly as-is.)

Run: `npx vitest run cli/src/commands/execute.e2e.test.ts`
Expected: PASS (or skipped, if the pytest stack isn't on `PATH`).

- [ ] **Step 6: Typecheck**

Run:
```bash
npm run build --workspace=core
npx tsc -p cli/tsconfig.json --noEmit
```
Expected: no errors other than in `menu.ts`/`menu.test.ts` (fixed in Task 10).

- [ ] **Step 7: Commit**

```bash
git add cli/src/commands/execute.ts cli/src/commands/execute.test.ts cli/src/commands/execute.e2e.test.ts
git commit -m "feat(cli): execute tests forwards app URL/test creds from the project .env"
```

---

### Task 10: Drop `homeDir` from `MenuDeps`/`bin/agente-qa.ts`

**Files:**
- Modify: `cli/src/menu.ts`
- Modify: `cli/src/menu.test.ts`
- Modify: `cli/bin/agente-qa.ts` (only the `chat` command's `.action()` body, plus the `os` import)

**Interfaces:**
- Produces: `MenuDeps` drops the `homeDir: string` field.

- [ ] **Step 1: Update the failing test expectations**

In `cli/src/menu.test.ts`, remove every occurrence of the line `      homeDir: "/home/test",` (it appears once inside each of the 9 `runMenuLoop({...})` call sites in this file — delete all of them, leaving `projectRoot: "/project/test",` as the last field in each object).

Then, in the `"routes 'config' to runInit"` test specifically, add a `mockResolvedValue` before the call (since `runInit` now returns an `InitResult` object that the `"config"` case destructures):

```typescript
  it("routes 'config' to runInit", async () => {
    const choices: MenuChoice[] = ["config", "exit"];
    let i = 0;
    runInitMock.mockResolvedValue({
      testsDir: "tests",
      envPath: "/project/test/.agente-qa/.env",
      envCreated: true,
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run cli/src/menu.test.ts`
Expected: FAIL — `MenuDeps` still requires `homeDir`, and `runCreatePlan`/`runGenerateTests`/`runInit` are still called with the old 3-arg signatures inside `menu.ts`.

- [ ] **Step 3: Update `menu.ts`**

Replace the full content of `cli/src/menu.ts`:

```typescript
import type {
  MenuPrompts,
  ChatPrompts,
  InitPrompts,
  GeneratorPrompts,
  ExecutorPrompts,
  ReportesPrompts,
} from "./prompts/types.js";
import { runCreatePlan } from "./commands/chat.js";
import { runInit } from "./commands/init.js";
import { runGenerateTests } from "./commands/generate.js";
import { runExecuteTests } from "./commands/execute.js";
import { runGenerateReports } from "./commands/reports.js";

export interface MenuDeps {
  menuPrompts: MenuPrompts;
  chatPrompts: ChatPrompts;
  initPrompts: InitPrompts;
  generatorPrompts: GeneratorPrompts;
  executorPrompts: ExecutorPrompts;
  reportesPrompts: ReportesPrompts;
  projectRoot: string;
}

export async function runMenuLoop(deps: MenuDeps): Promise<void> {
  console.log("Soy Agente_QA. ¿Qué quieres hacer?");
  let running = true;

  while (running) {
    const choice = await deps.menuPrompts.selectMenuChoice();

    switch (choice) {
      case "create-plan": {
        try {
          const filePath = await runCreatePlan(deps.chatPrompts, deps.projectRoot);
          console.log(`Plan guardado en ${filePath}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "generate-tests": {
        try {
          const writtenPaths = await runGenerateTests(deps.generatorPrompts, deps.projectRoot);
          console.log(`Tests generados:\n${writtenPaths.join("\n")}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "run-tests": {
        try {
          const result = await runExecuteTests(deps.executorPrompts, deps.projectRoot);
          let status: string;
          switch (result.exitCode) {
            case 0:
              status = "Todos los tests pasaron.";
              break;
            case 1:
              status = "Algunos tests fallaron.";
              break;
            case 5:
              status = "No se ejecutó ningún test (revisa el filtro de tags seleccionado).";
              break;
            default:
              status = `La ejecución de pytest no se completó correctamente (código de salida ${result.exitCode}).`;
              break;
          }
          console.log(`${status} Resultados en ${result.junitXmlPath}`);
          if (result.browserSetupWarning) {
            console.log(result.browserSetupWarning);
          }
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "reports": {
        try {
          const result = await runGenerateReports(deps.reportesPrompts, deps.projectRoot);
          console.log(
            `Resumen: ${result.passed} pasados, ${result.failed} fallidos, ${result.skipped} omitidos (${result.totalTests} en total).`
          );
          console.log(`Resumen Markdown: ${result.summaryPath}`);
          console.log(`Reporte extendido (HTML): ${result.htmlReportPath}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
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
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "exit":
        running = false;
        break;
    }
  }
}
```

- [ ] **Step 4: Update `bin/agente-qa.ts`'s `chat` command wiring**

In `cli/bin/agente-qa.ts`, remove the `import os from "node:os";` line entirely (nothing in the file needs it anymore — the `init` command stopped using it in Task 6), and remove the `homeDir: os.homedir(),` line from the `chat` command's `runMenuLoop({...})` call:

```typescript
program
  .command("chat")
  .description("Inicia la conversación con Agente_QA")
  .action(async () => {
    await runMenuLoop({
      menuPrompts: realMenuPrompts,
      chatPrompts: buildRealChatPrompts(),
      initPrompts: realInitPrompts,
      generatorPrompts: buildRealGeneratorPrompts(),
      executorPrompts: buildRealExecutorPrompts(),
      reportesPrompts: buildRealReportesPrompts(),
      projectRoot: process.cwd(),
    });
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run cli/src/menu.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run:
```bash
npm run build --workspace=core
npx tsc -p cli/tsconfig.json --noEmit
```
Expected: no errors anywhere in `cli`.

- [ ] **Step 7: Commit**

```bash
git add cli/src/menu.ts cli/src/menu.test.ts cli/bin/agente-qa.ts
git commit -m "refactor(cli): drop unused homeDir plumbing now that credentials are project-scoped"
```

---

### Task 11: Delete the old global `credentials.ts` module

**Files:**
- Delete: `core/src/config/credentials.ts`
- Delete: `core/src/config/credentials.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Removes: `ProviderNameSchema`/`ProviderName` from `./config/credentials.js` (re-exported from `./config/projectEnv.js` instead — same names, same values, since `projectEnv.ts` already defines its own copy in Task 1), `CredentialsSchema`, `credentialsPath`, `saveCredentials`, `loadCredentials`, `Credentials`.

- [ ] **Step 1: Verify nothing still imports `config/credentials`**

Run: `grep -rn "config/credentials" core/src cli/src cli/bin`
Expected: no output. (If anything shows up, stop — a prior task's cleanup was incomplete; fix that reference before continuing rather than deleting the module out from under it.)

- [ ] **Step 2: Delete the old module and its test**

Run:
```bash
git rm core/src/config/credentials.ts core/src/config/credentials.test.ts
```

- [ ] **Step 3: Finalize the barrel — remove the old exports, complete the `projectEnv` ones**

In `core/src/index.ts`, remove this block entirely:

```typescript
export {
  ProviderNameSchema,
  CredentialsSchema,
  credentialsPath,
  saveCredentials,
  loadCredentials,
} from "./config/credentials.js";
export type { ProviderName, Credentials } from "./config/credentials.js";
```

And replace the `projectEnv` export block added in Task 1 with this (adds `ProviderNameSchema`/`ProviderName`, which now have no other owner):

```typescript
export {
  ProviderNameSchema,
  ProjectEnvSchema,
  projectEnvPath,
  ensureProjectEnvTemplate,
  loadProjectEnv,
  requireLlmConfig,
  testEnvVars,
} from "./config/projectEnv.js";
export type { ProviderName, ProjectEnv, LlmCredentials } from "./config/projectEnv.js";
```

- [ ] **Step 4: Run the full core test suite**

Run: `npx vitest run --dir core`
Expected: PASS — every remaining test in `core` is green (nothing references the deleted module anymore).

- [ ] **Step 5: Typecheck both packages**

Run:
```bash
npx tsc -p core/tsconfig.json --noEmit
npm run build --workspace=core
npx tsc -p cli/tsconfig.json --noEmit
```
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every test in the monorepo is green.

- [ ] **Step 7: Commit**

```bash
git add core/src/index.ts
git commit -m "chore(core): remove the old global credentials.json module"
```

---

### Task 12: Update the README for the new `.env` flow

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Replace the `init` description and the provider/API-key section**

In `README.md`, replace lines 71 through 95 (from the `` `init` lanza el asistente... `` paragraph through the closing ` ``` ` of the "Otro" example) with:

```markdown
`init` pregunta en qué carpeta del proyecto guardar los tests, y crea (si no existe ya) una plantilla `.env` en `<proyecto>/.agente-qa/.env` — fuera de git (`.agente-qa/.gitignore` ya la excluye). Ahí rellenas a mano, con un editor de texto, la URL de la aplicación que vas a probar, un usuario/contraseña de prueba (opcional, solo si vas a probar login) y el proveedor/API key/modelo del LLM. `init` nunca pide estos valores por chat ni sobrescribe el archivo si ya existe.

### Proveedor LLM — opciones y cómo conseguir cada API key

| `AGENTE_QA_LLM_PROVIDER` | Proveedor real | Dónde conseguir la API key | Modelo por defecto |
|---|---|---|---|
| `anthropic` | Anthropic | https://console.anthropic.com/settings/keys | `claude-sonnet-5` |
| `openai` | OpenAI | https://platform.openai.com/api-keys | `gpt-5.1` |
| `google` | Google AI Studio (Gemini API, `generativelanguage.googleapis.com`) — **no** Vertex AI | https://aistudio.google.com/apikey | `gemini-3.6-flash` |
| `openai-compatible` | Cualquier API que implemente el protocolo de OpenAI: Groq, Together AI, Ollama en local, etc. | La del proveedor elegido | El que tú indiques — no hay uno por defecto |

Para las tres primeras opciones basta con `AGENTE_QA_LLM_PROVIDER` + `AGENTE_QA_LLM_API_KEY`. Para `openai-compatible` hacen falta además:

- **`AGENTE_QA_LLM_BASE_URL`**: la que exponga ese proveedor, p. ej. `https://api.groq.com/openai/v1` (Groq) o `http://localhost:11434/v1` (Ollama en local).
- **`AGENTE_QA_LLM_MODEL`**: el nombre exacto que ese proveedor use para el modelo, p. ej. `llama-3.3-70b-versatile` (Groq) o `llama3.3` (Ollama).

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

- [ ] **Step 2: Proofread the surrounding sections**

Read the paragraph right after (starting `"Alternativa en local desde el propio repositorio..."`) and confirm it doesn't reference `init`'s old interactive prompts or `credentials.json` — it shouldn't need any change, just confirm.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the new project .env config flow"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (ubicación/protección) → Task 1 + 6; §2 (variables/plantilla/validación por comando) → Task 1, 7, 8, 9; §3 (módulos) → each bullet maps 1:1 to Tasks 1–11; README → Task 12. Fuera de alcance del spec (sin migración, sin mover `testsDir`) respetado — ningún task lo toca.
- **Type consistency checked:** `LlmCredentials`/`ProviderName` (Task 1) flow unchanged into `factory.ts` (Task 2); `TestRunOptions.env` (Task 3) flows into `runEjecutor`'s `testEnv` param (Task 4) and `execute.ts`'s `testEnvVars(env)` call (Task 9); `InitResult` (Task 6) is consumed identically by `bin/agente-qa.ts` (Task 6) and `menu.ts`'s `"config"` case (Task 10).
- **Ordering verified:** every task that deletes/renames something (Task 11) comes after every consumer has already migrated (Tasks 2, 6–10); every task that touches a `cli` file importing `@agente-qa/core` includes the `npm run build --workspace=core` reminder before its `cli` typecheck.
