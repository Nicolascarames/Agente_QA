# Core Foundations + Agente 1 (Intake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared `core` engine (credentials/config storage, multi-LLM provider abstraction, reusable pattern library) and the `cli` npm package's foundations, ending with Agente 1 (intake) fully working end to end: a user pastes a text description, the system asks clarifying questions if needed, matches it against a known pattern when applicable, produces an approved Gherkin `.feature` file, and offers to learn new patterns.

**Architecture:** npm-workspaces monorepo (`core/` + `cli/`). `core` is pure domain logic with zero interactive I/O — every place it needs input from a human, it takes an injected async callback, so it never assumes a terminal. `cli` provides the real terminal implementation of those callbacks (via `@inquirer/prompts` and `node:readline`) and the Commander-based entry point.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Vitest, Zod, Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@ai-sdk/google`), Commander, `@inquirer/prompts`.

## Global Constraints

- TypeScript strict mode across `core` and `cli`; no `any` in production code.
- Node.js >= 22 (LTS) — raised from the original >=20 during Task 1's review: `@ai-sdk/*` declares `engines.node >= 22`, so >=20 was unenforceable in practice.
- Never commit secrets. API keys only ever live in `~/.agente-qa/credentials.json` (outside any git repo).
- `core` has no direct terminal I/O (no `console.log`/`readline` inside `core/src`) — all human interaction crosses an injected callback interface, so the same engine can later power the Claude Code plugin surface too.
- Any step where the agent could act on an ambiguous or unconfirmed assumption must instead ask — never silently guess.
- Gherkin plans require the user's explicit approval before being treated as final.
- Learned patterns are only ever saved after explicit user confirmation, never silently.

---

## File Structure

```
Agente_QA/
  package.json                      # root workspaces + scripts
  tsconfig.base.json
  vitest.config.ts
  .gitignore
  core/
    package.json
    tsconfig.json
    src/
      index.ts                      # public API barrel
      util/
        slugify.ts
      config/
        credentials.ts
        projectConfig.ts
      llm/
        provider.ts                 # LLMProvider, Message
        parseJson.ts
        testUtils.ts                # FakeLLMProvider
        factory.ts
        providers/
          anthropic.ts
          openai.ts
          google.ts
      schemas/
        pattern.ts
        gherkinPlan.ts
      patterns/
        builtin/
          login.ts
          logout.ts
          signup.ts
          passwordReset.ts
        registry.ts
      prompts/
        intake.ts
      agents/
        intake/
          ambiguityChecker.ts
          gherkinGenerator.ts
          writeFeatureFile.ts
          runIntake.ts
  cli/
    package.json
    tsconfig.json
    bin/
      agente-qa.ts
    src/
      prompts/
        types.ts
        inquirerPrompts.ts
      commands/
        init.ts
        chat.ts
      menu.ts
```

---

## Task 1: Monorepo scaffolding

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `core/package.json`, `core/tsconfig.json`
- Create: `cli/package.json`, `cli/tsconfig.json`
- Create: `core/src/util/slugify.ts`
- Test: `core/src/util/slugify.test.ts`

**Interfaces:**
- Produces: `slugify(text: string): string`

- [ ] **Step 1: Create the scaffolding files**

`package.json`:
```json
{
  "name": "agente-qa-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["core", "cli"],
  "scripts": {
    "test": "vitest run",
    "build": "npm run build --workspace=core && npm run build --workspace=cli"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["core/src/**/*.test.ts", "cli/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@agente-qa/core": path.resolve(__dirname, "core/src/index.ts"),
    },
  },
});
```

`.gitignore`:
```
node_modules/
dist/
*.log
```

`core/package.json`:
```json
{
  "name": "@agente-qa/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  }
}
```

`core/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

`cli/package.json`:
```json
{
  "name": "agente-qa",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "agente-qa": "./dist/bin/agente-qa.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agente-qa/core": "*"
  }
}
```

`cli/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src", "bin"]
}
```

- [ ] **Step 2: Install dependencies**

Run, from the repo root:
```bash
npm install -D typescript vitest @types/node
npm install zod --workspace=core
npm install ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google --workspace=core
npm install commander @inquirer/prompts --workspace=cli
```

- [ ] **Step 3: Write the failing test**

`core/src/util/slugify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { slugify } from "./slugify.js";

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Login de Usuario")).toBe("login-de-usuario");
  });

  it("strips accents and non-alphanumeric characters", () => {
    expect(slugify("¿Puedo iniciar sesión?!")).toBe("puedo-iniciar-sesion");
  });

  it("collapses repeated separators and trims leading/trailing hyphens", () => {
    expect(slugify("  --Hola   Mundo--  ")).toBe("hola-mundo");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run core/src/util/slugify.test.ts`
Expected: FAIL (`Cannot find module './slugify.js'`)

- [ ] **Step 5: Implement**

`core/src/util/slugify.ts`:
```ts
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run core/src/util/slugify.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json vitest.config.ts .gitignore core/package.json core/tsconfig.json cli/package.json cli/tsconfig.json core/src/util/slugify.ts core/src/util/slugify.test.ts package-lock.json
git commit -m "chore: scaffold monorepo (core + cli workspaces)"
```

---

## Task 2: Credentials storage

**Files:**
- Create: `core/src/config/credentials.ts`
- Test: `core/src/config/credentials.test.ts`

**Interfaces:**
- Produces: `ProviderName` (`"anthropic" | "openai" | "google"`), `Credentials { provider: ProviderName; apiKey: string }`, `credentialsPath(homeDir: string): string`, `saveCredentials(creds: Credentials, homeDir: string): Promise<void>`, `loadCredentials(homeDir: string): Promise<Credentials | null>`

- [ ] **Step 1: Write the failing test**

`core/src/config/credentials.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, loadCredentials, credentialsPath } from "./credentials.js";

describe("credentials", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("returns null when no credentials file exists", async () => {
    expect(await loadCredentials(tmpHome)).toBeNull();
  });

  it("saves and loads credentials round-trip", async () => {
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test-123" }, tmpHome);
    expect(await loadCredentials(tmpHome)).toEqual({ provider: "anthropic", apiKey: "sk-test-123" });
  });

  it("writes the file at <home>/.agente-qa/credentials.json", async () => {
    await saveCredentials({ provider: "openai", apiKey: "sk-test-456" }, tmpHome);
    const exists = await fs.stat(credentialsPath(tmpHome)).then(() => true, () => false);
    expect(exists).toBe(true);
    expect(credentialsPath(tmpHome)).toBe(path.join(tmpHome, ".agente-qa", "credentials.json"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/config/credentials.test.ts`
Expected: FAIL (`Cannot find module './credentials.js'`)

- [ ] **Step 3: Implement**

`core/src/config/credentials.ts`:
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ProviderNameSchema = z.enum(["anthropic", "openai", "google"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const CredentialsSchema = z.object({
  provider: ProviderNameSchema,
  apiKey: z.string().min(1),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export function credentialsPath(homeDir: string): string {
  return path.join(homeDir, ".agente-qa", "credentials.json");
}

export async function saveCredentials(creds: Credentials, homeDir: string): Promise<void> {
  const filePath = credentialsPath(homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(creds, null, 2), "utf-8");
}

export async function loadCredentials(homeDir: string): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(credentialsPath(homeDir), "utf-8");
    return CredentialsSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/config/credentials.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/config/credentials.ts core/src/config/credentials.test.ts
git commit -m "feat(core): add credentials storage"
```

---

## Task 3: Project config storage

**Files:**
- Create: `core/src/config/projectConfig.ts`
- Test: `core/src/config/projectConfig.test.ts`

**Interfaces:**
- Produces: `ProjectConfig { testsDir: string }`, `projectConfigPath(projectRoot: string): string`, `saveProjectConfig(projectRoot: string, config: ProjectConfig): Promise<void>`, `loadProjectConfig(projectRoot: string): Promise<ProjectConfig | null>`

- [ ] **Step 1: Write the failing test**

`core/src/config/projectConfig.test.ts`:
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

  it("saves and loads project config round-trip", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests" });
  });

  it("writes the file at <project>/.agente-qa/config.json", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "qa-tests" });
    expect(projectConfigPath(tmpProject)).toBe(path.join(tmpProject, ".agente-qa", "config.json"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/config/projectConfig.test.ts`
Expected: FAIL (`Cannot find module './projectConfig.js'`)

- [ ] **Step 3: Implement**

`core/src/config/projectConfig.ts`:
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "config.json");
}

export async function saveProjectConfig(projectRoot: string, config: ProjectConfig): Promise<void> {
  const filePath = projectConfigPath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), "utf-8");
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
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/config/projectConfig.ts core/src/config/projectConfig.test.ts
git commit -m "feat(core): add project config storage"
```

---

## Task 4: LLM provider contract + JSON parsing + fake test double

**Files:**
- Create: `core/src/llm/provider.ts`, `core/src/llm/parseJson.ts`, `core/src/llm/testUtils.ts`
- Test: `core/src/llm/parseJson.test.ts`, `core/src/llm/testUtils.test.ts`

**Interfaces:**
- Produces: `Message { role: "system"|"user"|"assistant"; content: string }`, `LLMProvider { generate(messages: Message[]): Promise<string> }`, `LLMResponseParseError`, `parseJsonResponse<T>(schema: ZodType<T>, raw: string): T`, `FakeLLMProvider` (implements `LLMProvider`, constructed with `string[]` of scripted responses, exposes `receivedCalls: Message[][]`)

- [ ] **Step 1: Write the failing tests**

`core/src/llm/parseJson.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseJsonResponse, LLMResponseParseError } from "./parseJson.js";

const schema = z.object({ ok: z.boolean() });

describe("parseJsonResponse", () => {
  it("parses plain JSON", () => {
    expect(parseJsonResponse(schema, '{"ok": true}')).toEqual({ ok: true });
  });

  it("strips markdown code fences", () => {
    expect(parseJsonResponse(schema, '```json\n{"ok": false}\n```')).toEqual({ ok: false });
  });

  it("throws LLMResponseParseError on invalid JSON", () => {
    expect(() => parseJsonResponse(schema, "not json")).toThrow(LLMResponseParseError);
  });

  it("throws LLMResponseParseError when the schema doesn't match", () => {
    expect(() => parseJsonResponse(schema, '{"ok": "yes"}')).toThrow(LLMResponseParseError);
  });
});
```

`core/src/llm/testUtils.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "./testUtils.js";

describe("FakeLLMProvider", () => {
  it("returns scripted responses in order and records calls", async () => {
    const fake = new FakeLLMProvider(["first", "second"]);
    expect(await fake.generate([{ role: "user", content: "a" }])).toBe("first");
    expect(await fake.generate([{ role: "user", content: "b" }])).toBe("second");
    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0]).toEqual([{ role: "user", content: "a" }]);
  });

  it("throws when out of scripted responses", async () => {
    const fake = new FakeLLMProvider([]);
    await expect(fake.generate([{ role: "user", content: "a" }])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run core/src/llm/parseJson.test.ts core/src/llm/testUtils.test.ts`
Expected: FAIL (modules don't exist)

- [ ] **Step 3: Implement**

`core/src/llm/provider.ts`:
```ts
export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  generate(messages: Message[]): Promise<string>;
}
```

`core/src/llm/parseJson.ts`:
```ts
import type { ZodType } from "zod";

export class LLMResponseParseError extends Error {}

export function parseJsonResponse<T>(schema: ZodType<T>, raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    throw new LLMResponseParseError(`La respuesta del modelo no es JSON válido: ${cleaned}`);
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw new LLMResponseParseError(`La respuesta del modelo no cumple el esquema esperado: ${result.error.message}`);
  }
  return result.data;
}
```

`core/src/llm/testUtils.ts`:
```ts
import type { LLMProvider, Message } from "./provider.js";

export class FakeLLMProvider implements LLMProvider {
  private responses: string[];
  public receivedCalls: Message[][] = [];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async generate(messages: Message[]): Promise<string> {
    this.receivedCalls.push(messages);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("FakeLLMProvider: no hay más respuestas programadas");
    }
    return next;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/llm/parseJson.test.ts core/src/llm/testUtils.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/llm/provider.ts core/src/llm/parseJson.ts core/src/llm/testUtils.ts core/src/llm/parseJson.test.ts core/src/llm/testUtils.test.ts
git commit -m "feat(core): add LLM provider contract, JSON parsing and fake test double"
```

---

## Task 5: Anthropic provider adapter

**Files:**
- Create: `core/src/llm/providers/anthropic.ts`
- Test: `core/src/llm/providers/anthropic.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `Message` (Task 4)
- Produces: `ANTHROPIC_DEFAULT_MODEL: string`, `createAnthropicProvider(apiKey: string, model?: string): LLMProvider`

- [ ] **Step 1: Write the failing test**

`core/src/llm/providers/anthropic.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const anthropicModelMock = vi.fn((modelId: string) => ({ modelId }));
const createAnthropicMock = vi.fn(() => anthropicModelMock);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: (...args: unknown[]) => createAnthropicMock(...args),
}));

import { createAnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "./anthropic.js";

describe("createAnthropicProvider", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createAnthropicMock.mockClear();
    anthropicModelMock.mockClear();
  });

  it("configures the Anthropic client with the given API key", () => {
    createAnthropicProvider("sk-ant-test");
    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: "sk-ant-test" });
  });

  it("calls generateText with the default model and returns the text", async () => {
    generateTextMock.mockResolvedValue({ text: "hola" });
    const provider = createAnthropicProvider("sk-ant-test");
    const result = await provider.generate([{ role: "user", content: "hi" }]);

    expect(anthropicModelMock).toHaveBeenCalledWith(ANTHROPIC_DEFAULT_MODEL);
    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: ANTHROPIC_DEFAULT_MODEL },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBe("hola");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/llm/providers/anthropic.test.ts`
Expected: FAIL (`Cannot find module './anthropic.js'`)

- [ ] **Step 3: Implement**

`core/src/llm/providers/anthropic.ts`:
```ts
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LLMProvider, Message } from "../provider.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";

export function createAnthropicProvider(apiKey: string, model: string = ANTHROPIC_DEFAULT_MODEL): LLMProvider {
  const anthropic = createAnthropic({ apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      const result = await generateText({ model: anthropic(model), messages });
      return result.text;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/llm/providers/anthropic.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/llm/providers/anthropic.ts core/src/llm/providers/anthropic.test.ts
git commit -m "feat(core): add Anthropic provider adapter"
```

---

## Task 6: OpenAI provider adapter

**Files:**
- Create: `core/src/llm/providers/openai.ts`
- Test: `core/src/llm/providers/openai.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `Message` (Task 4)
- Produces: `OPENAI_DEFAULT_MODEL: string`, `createOpenAIProvider(apiKey: string, model?: string): LLMProvider`

Before implementing, check `@ai-sdk/openai`'s current documentation for the recommended default chat model id at implementation time — `gpt-5.1` below is this plan's best-effort placeholder for "the current flagship OpenAI chat model" and may need updating.

- [ ] **Step 1: Write the failing test**

`core/src/llm/providers/openai.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const openaiModelMock = vi.fn((modelId: string) => ({ modelId }));
const createOpenAIMock = vi.fn(() => openaiModelMock);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (...args: unknown[]) => createOpenAIMock(...args),
}));

import { createOpenAIProvider, OPENAI_DEFAULT_MODEL } from "./openai.js";

describe("createOpenAIProvider", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createOpenAIMock.mockClear();
    openaiModelMock.mockClear();
  });

  it("configures the OpenAI client with the given API key", () => {
    createOpenAIProvider("sk-oa-test");
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "sk-oa-test" });
  });

  it("calls generateText with the default model and returns the text", async () => {
    generateTextMock.mockResolvedValue({ text: "hola" });
    const provider = createOpenAIProvider("sk-oa-test");
    const result = await provider.generate([{ role: "user", content: "hi" }]);

    expect(openaiModelMock).toHaveBeenCalledWith(OPENAI_DEFAULT_MODEL);
    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: OPENAI_DEFAULT_MODEL },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBe("hola");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/llm/providers/openai.test.ts`
Expected: FAIL (`Cannot find module './openai.js'`)

- [ ] **Step 3: Implement**

`core/src/llm/providers/openai.ts`:
```ts
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMProvider, Message } from "../provider.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5.1";

export function createOpenAIProvider(apiKey: string, model: string = OPENAI_DEFAULT_MODEL): LLMProvider {
  const openai = createOpenAI({ apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      const result = await generateText({ model: openai(model), messages });
      return result.text;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/llm/providers/openai.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/llm/providers/openai.ts core/src/llm/providers/openai.test.ts
git commit -m "feat(core): add OpenAI provider adapter"
```

---

## Task 7: Google provider adapter

**Files:**
- Create: `core/src/llm/providers/google.ts`
- Test: `core/src/llm/providers/google.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `Message` (Task 4)
- Produces: `GOOGLE_DEFAULT_MODEL: string`, `createGoogleProvider(apiKey: string, model?: string): LLMProvider`

Before implementing, check `@ai-sdk/google`'s current documentation for the recommended default model id at implementation time — `gemini-3-pro` below is this plan's best-effort placeholder and may need updating.

- [ ] **Step 1: Write the failing test**

`core/src/llm/providers/google.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const googleModelMock = vi.fn((modelId: string) => ({ modelId }));
const createGoogleMock = vi.fn(() => googleModelMock);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (...args: unknown[]) => createGoogleMock(...args),
}));

import { createGoogleProvider, GOOGLE_DEFAULT_MODEL } from "./google.js";

describe("createGoogleProvider", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createGoogleMock.mockClear();
    googleModelMock.mockClear();
  });

  it("configures the Google client with the given API key", () => {
    createGoogleProvider("goog-test");
    expect(createGoogleMock).toHaveBeenCalledWith({ apiKey: "goog-test" });
  });

  it("calls generateText with the default model and returns the text", async () => {
    generateTextMock.mockResolvedValue({ text: "hola" });
    const provider = createGoogleProvider("goog-test");
    const result = await provider.generate([{ role: "user", content: "hi" }]);

    expect(googleModelMock).toHaveBeenCalledWith(GOOGLE_DEFAULT_MODEL);
    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: GOOGLE_DEFAULT_MODEL },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBe("hola");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/llm/providers/google.test.ts`
Expected: FAIL (`Cannot find module './google.js'`)

- [ ] **Step 3: Implement**

`core/src/llm/providers/google.ts`:
```ts
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LLMProvider, Message } from "../provider.js";

export const GOOGLE_DEFAULT_MODEL = "gemini-3-pro";

export function createGoogleProvider(apiKey: string, model: string = GOOGLE_DEFAULT_MODEL): LLMProvider {
  const google = createGoogleGenerativeAI({ apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      const result = await generateText({ model: google(model), messages });
      return result.text;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/llm/providers/google.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/llm/providers/google.ts core/src/llm/providers/google.test.ts
git commit -m "feat(core): add Google provider adapter"
```

---

## Task 8: Provider factory

**Files:**
- Create: `core/src/llm/factory.ts`
- Test: `core/src/llm/factory.test.ts`

**Interfaces:**
- Consumes: `Credentials` (Task 2), `LLMProvider` (Task 4), `createAnthropicProvider`/`createOpenAIProvider`/`createGoogleProvider` (Tasks 5-7)
- Produces: `createProvider(credentials: Credentials): LLMProvider`

- [ ] **Step 1: Write the failing test**

`core/src/llm/factory.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const createAnthropicProviderMock = vi.fn(() => ({ generate: vi.fn() }));
const createOpenAIProviderMock = vi.fn(() => ({ generate: vi.fn() }));
const createGoogleProviderMock = vi.fn(() => ({ generate: vi.fn() }));

vi.mock("./providers/anthropic.js", () => ({
  createAnthropicProvider: (...args: unknown[]) => createAnthropicProviderMock(...args),
}));
vi.mock("./providers/openai.js", () => ({
  createOpenAIProvider: (...args: unknown[]) => createOpenAIProviderMock(...args),
}));
vi.mock("./providers/google.js", () => ({
  createGoogleProvider: (...args: unknown[]) => createGoogleProviderMock(...args),
}));

import { createProvider } from "./factory.js";

describe("createProvider", () => {
  beforeEach(() => {
    createAnthropicProviderMock.mockClear();
    createOpenAIProviderMock.mockClear();
    createGoogleProviderMock.mockClear();
  });

  it("dispatches to the Anthropic adapter", () => {
    createProvider({ provider: "anthropic", apiKey: "k" });
    expect(createAnthropicProviderMock).toHaveBeenCalledWith("k");
  });

  it("dispatches to the OpenAI adapter", () => {
    createProvider({ provider: "openai", apiKey: "k" });
    expect(createOpenAIProviderMock).toHaveBeenCalledWith("k");
  });

  it("dispatches to the Google adapter", () => {
    createProvider({ provider: "google", apiKey: "k" });
    expect(createGoogleProviderMock).toHaveBeenCalledWith("k");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/llm/factory.test.ts`
Expected: FAIL (`Cannot find module './factory.js'`)

- [ ] **Step 3: Implement**

`core/src/llm/factory.ts`:
```ts
import type { Credentials } from "../config/credentials.js";
import type { LLMProvider } from "./provider.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createGoogleProvider } from "./providers/google.js";

export function createProvider(credentials: Credentials): LLMProvider {
  switch (credentials.provider) {
    case "anthropic":
      return createAnthropicProvider(credentials.apiKey);
    case "openai":
      return createOpenAIProvider(credentials.apiKey);
    case "google":
      return createGoogleProvider(credentials.apiKey);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/llm/factory.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/llm/factory.ts core/src/llm/factory.test.ts
git commit -m "feat(core): add provider factory"
```

---

## Task 9: Pattern schema + built-in patterns

**Files:**
- Create: `core/src/schemas/pattern.ts`
- Create: `core/src/patterns/builtin/login.ts`, `core/src/patterns/builtin/logout.ts`, `core/src/patterns/builtin/signup.ts`, `core/src/patterns/builtin/passwordReset.ts`
- Test: `core/src/patterns/builtin/builtin.test.ts`

**Interfaces:**
- Produces: `Pattern { name: string; description: string; gherkinTemplate: string; pageObjectTemplate: string }`, `loginPattern`, `logoutPattern`, `signupPattern`, `passwordResetPattern` (all `Pattern`)

- [ ] **Step 1: Write the failing test**

`core/src/patterns/builtin/builtin.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PatternSchema } from "../../schemas/pattern.js";
import { loginPattern } from "./login.js";
import { logoutPattern } from "./logout.js";
import { signupPattern } from "./signup.js";
import { passwordResetPattern } from "./passwordReset.js";

describe("built-in patterns", () => {
  const patterns = [loginPattern, logoutPattern, signupPattern, passwordResetPattern];

  it("all conform to PatternSchema", () => {
    for (const pattern of patterns) {
      expect(() => PatternSchema.parse(pattern)).not.toThrow();
    }
  });

  it("all have unique names", () => {
    const names = patterns.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all Gherkin templates start with 'Feature:'", () => {
    for (const pattern of patterns) {
      expect(pattern.gherkinTemplate.trimStart().startsWith("Feature:")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/patterns/builtin/builtin.test.ts`
Expected: FAIL (modules don't exist)

- [ ] **Step 3: Implement**

`core/src/schemas/pattern.ts`:
```ts
import { z } from "zod";

export const PatternSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  gherkinTemplate: z.string().min(1),
  pageObjectTemplate: z.string(),
});
export type Pattern = z.infer<typeof PatternSchema>;
```

`core/src/patterns/builtin/login.ts`:
```ts
import type { Pattern } from "../../schemas/pattern.js";

export const loginPattern: Pattern = {
  name: "login",
  description: "Inicio de sesión con credenciales válidas e inválidas",
  gherkinTemplate: `Feature: Inicio de sesión
  Como usuario registrado
  Quiero iniciar sesión con mis credenciales
  Para acceder a mi cuenta

  @smoke
  Scenario: Login con credenciales válidas
    Given estoy en la página de login
    When introduzco un usuario y contraseña válidos
    And pulso el botón de iniciar sesión
    Then accedo a mi área privada

  @regression
  Scenario: Login con credenciales inválidas
    Given estoy en la página de login
    When introduzco un usuario o contraseña incorrectos
    And pulso el botón de iniciar sesión
    Then veo un mensaje de error de credenciales inválidas
`,
  pageObjectTemplate: `class LoginPage:
    def __init__(self, page):
        self.page = page
        self.username_input = page.get_by_label("Usuario")
        self.password_input = page.get_by_label("Contraseña")
        self.submit_button = page.get_by_role("button", name="Iniciar sesión")
        self.error_message = page.get_by_role("alert")

    def goto(self, base_url: str):
        self.page.goto(f"{base_url}/login")

    def login(self, username: str, password: str):
        self.username_input.fill(username)
        self.password_input.fill(password)
        self.submit_button.click()
`,
};
```

`core/src/patterns/builtin/logout.ts`:
```ts
import type { Pattern } from "../../schemas/pattern.js";

export const logoutPattern: Pattern = {
  name: "logout",
  description: "Cierre de sesión de un usuario autenticado",
  gherkinTemplate: `Feature: Cierre de sesión
  Como usuario autenticado
  Quiero cerrar sesión
  Para proteger mi cuenta en un dispositivo compartido

  @smoke
  Scenario: Logout desde el menú de usuario
    Given he iniciado sesión correctamente
    When abro el menú de usuario
    And pulso "Cerrar sesión"
    Then vuelvo a la pantalla de login
    And ya no puedo acceder a páginas privadas sin volver a iniciar sesión
`,
  pageObjectTemplate: `class LogoutFlow:
    def __init__(self, page):
        self.page = page
        self.user_menu_button = page.get_by_role("button", name="Menú de usuario")
        self.logout_option = page.get_by_role("menuitem", name="Cerrar sesión")

    def logout(self):
        self.user_menu_button.click()
        self.logout_option.click()
`,
};
```

`core/src/patterns/builtin/signup.ts`:
```ts
import type { Pattern } from "../../schemas/pattern.js";

export const signupPattern: Pattern = {
  name: "signup",
  description: "Registro de una cuenta nueva",
  gherkinTemplate: `Feature: Registro de usuario
  Como visitante nuevo
  Quiero crear una cuenta
  Para poder usar la aplicación

  @smoke
  Scenario: Registro con datos válidos
    Given estoy en la página de registro
    When relleno el formulario con datos válidos y únicos
    And pulso el botón de crear cuenta
    Then veo confirmación de que mi cuenta se ha creado
    And puedo iniciar sesión con las credenciales recién creadas

  @regression
  Scenario: Registro con un email ya existente
    Given estoy en la página de registro
    When relleno el formulario con un email ya registrado
    And pulso el botón de crear cuenta
    Then veo un mensaje de error indicando que el email ya existe
`,
  pageObjectTemplate: `class SignupPage:
    def __init__(self, page):
        self.page = page
        self.email_input = page.get_by_label("Email")
        self.password_input = page.get_by_label("Contraseña")
        self.submit_button = page.get_by_role("button", name="Crear cuenta")
        self.error_message = page.get_by_role("alert")

    def goto(self, base_url: str):
        self.page.goto(f"{base_url}/signup")

    def signup(self, email: str, password: str):
        self.email_input.fill(email)
        self.password_input.fill(password)
        self.submit_button.click()
`,
};
```

`core/src/patterns/builtin/passwordReset.ts`:
```ts
import type { Pattern } from "../../schemas/pattern.js";

export const passwordResetPattern: Pattern = {
  name: "password-reset",
  description: "Recuperación de contraseña olvidada por email",
  gherkinTemplate: `Feature: Recuperación de contraseña
  Como usuario que olvidó su contraseña
  Quiero solicitar un enlace de recuperación
  Para poder volver a acceder a mi cuenta

  @smoke
  Scenario: Solicitar recuperación con un email registrado
    Given estoy en la página de "contraseña olvidada"
    When introduzco el email de una cuenta existente
    And pulso el botón de enviar
    Then veo confirmación de que se ha enviado un email de recuperación
`,
  pageObjectTemplate: `class PasswordResetPage:
    def __init__(self, page):
        self.page = page
        self.email_input = page.get_by_label("Email")
        self.submit_button = page.get_by_role("button", name="Enviar")
        self.confirmation_message = page.get_by_text("Te hemos enviado un email")

    def goto(self, base_url: str):
        self.page.goto(f"{base_url}/password-reset")

    def request_reset(self, email: str):
        self.email_input.fill(email)
        self.submit_button.click()
`,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/patterns/builtin/builtin.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/schemas/pattern.ts core/src/patterns/builtin/
git commit -m "feat(core): add pattern schema and built-in login/logout/signup/password-reset patterns"
```

---

## Task 10: Pattern registry

**Files:**
- Create: `core/src/patterns/registry.ts`
- Test: `core/src/patterns/registry.test.ts`

**Interfaces:**
- Consumes: `Pattern`, `PatternSchema` (Task 9), `slugify` (Task 1)
- Produces: `loadBuiltinPatterns(): Pattern[]`, `loadProjectPatterns(projectRoot: string): Promise<Pattern[]>`, `loadAllPatterns(projectRoot: string): Promise<Pattern[]>`, `saveProjectPattern(projectRoot: string, pattern: Pattern): Promise<void>`

- [ ] **Step 1: Write the failing test**

`core/src/patterns/registry.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadBuiltinPatterns,
  loadProjectPatterns,
  loadAllPatterns,
  saveProjectPattern,
} from "./registry.js";
import type { Pattern } from "../schemas/pattern.js";

describe("pattern registry", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-patterns-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("loads the 4 built-in patterns", () => {
    const patterns = loadBuiltinPatterns();
    expect(patterns.map((p) => p.name).sort()).toEqual(
      ["login", "logout", "password-reset", "signup"].sort()
    );
  });

  it("returns an empty array of project patterns when none saved yet", async () => {
    expect(await loadProjectPatterns(tmpProject)).toEqual([]);
  });

  it("saves and reloads a project pattern", async () => {
    const custom: Pattern = {
      name: "checkout",
      description: "Flujo de compra completo",
      gherkinTemplate: "Feature: Checkout\n  Scenario: x\n    Given a\n",
      pageObjectTemplate: "class CheckoutPage:\n    pass\n",
    };
    await saveProjectPattern(tmpProject, custom);
    const projectPatterns = await loadProjectPatterns(tmpProject);
    expect(projectPatterns).toEqual([custom]);
  });

  it("loadAllPatterns combines built-in and project patterns", async () => {
    const custom: Pattern = {
      name: "checkout",
      description: "Flujo de compra completo",
      gherkinTemplate: "Feature: Checkout\n  Scenario: x\n    Given a\n",
      pageObjectTemplate: "",
    };
    await saveProjectPattern(tmpProject, custom);
    const all = await loadAllPatterns(tmpProject);
    expect(all.length).toBe(5);
    expect(all.some((p) => p.name === "checkout")).toBe(true);
    expect(all.some((p) => p.name === "login")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/patterns/registry.test.ts`
Expected: FAIL (`Cannot find module './registry.js'`)

- [ ] **Step 3: Implement**

`core/src/patterns/registry.ts`:
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { PatternSchema, type Pattern } from "../schemas/pattern.js";
import { slugify } from "../util/slugify.js";
import { loginPattern } from "./builtin/login.js";
import { logoutPattern } from "./builtin/logout.js";
import { signupPattern } from "./builtin/signup.js";
import { passwordResetPattern } from "./builtin/passwordReset.js";

function projectPatternsDir(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "templates");
}

export function loadBuiltinPatterns(): Pattern[] {
  return [loginPattern, logoutPattern, signupPattern, passwordResetPattern];
}

export async function loadProjectPatterns(projectRoot: string): Promise<Pattern[]> {
  const dir = projectPatternsDir(projectRoot);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const patterns: Pattern[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const raw = await fs.readFile(path.join(dir, file), "utf-8");
    patterns.push(PatternSchema.parse(JSON.parse(raw)));
  }
  return patterns;
}

export async function loadAllPatterns(projectRoot: string): Promise<Pattern[]> {
  return [...loadBuiltinPatterns(), ...(await loadProjectPatterns(projectRoot))];
}

export async function saveProjectPattern(projectRoot: string, pattern: Pattern): Promise<void> {
  const dir = projectPatternsDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${slugify(pattern.name)}.json`;
  await fs.writeFile(path.join(dir, fileName), JSON.stringify(pattern, null, 2), "utf-8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/patterns/registry.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/patterns/registry.ts core/src/patterns/registry.test.ts
git commit -m "feat(core): add pattern registry (built-in + project-learned patterns)"
```

---

## Task 11: Ambiguity checker

**Files:**
- Create: `core/src/prompts/intake.ts` (only `ambiguityCheckPrompt` for now), `core/src/agents/intake/ambiguityChecker.ts`
- Test: `core/src/agents/intake/ambiguityChecker.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `FakeLLMProvider`, `parseJsonResponse` (Task 4)
- Produces: `ambiguityCheckPrompt(text: string): string`, `AmbiguityCheck { ambiguous: boolean; questions: string[] }`, `checkAmbiguity(text: string, llm: LLMProvider): Promise<AmbiguityCheck>`

- [ ] **Step 1: Write the failing test**

`core/src/agents/intake/ambiguityChecker.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { checkAmbiguity } from "./ambiguityChecker.js";

describe("checkAmbiguity", () => {
  it("returns ambiguous=false with no questions when the model says so", async () => {
    const llm = new FakeLLMProvider(['{"ambiguous": false, "questions": []}']);
    const result = await checkAmbiguity("Probar el login con usuario y contraseña válidos", llm);
    expect(result).toEqual({ ambiguous: false, questions: [] });
  });

  it("returns the clarifying questions when the model flags ambiguity", async () => {
    const llm = new FakeLLMProvider([
      '{"ambiguous": true, "questions": ["¿Qué navegador?", "¿Qué URL?"]}',
    ]);
    const result = await checkAmbiguity("Probar que funciona", llm);
    expect(result.ambiguous).toBe(true);
    expect(result.questions).toEqual(["¿Qué navegador?", "¿Qué URL?"]);
  });

  it("sends the text inside the prompt to the model", async () => {
    const llm = new FakeLLMProvider(['{"ambiguous": false, "questions": []}']);
    await checkAmbiguity("mi petición concreta", llm);
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("mi petición concreta");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/intake/ambiguityChecker.test.ts`
Expected: FAIL (modules don't exist)

- [ ] **Step 3: Implement**

`core/src/prompts/intake.ts`:
```ts
export function ambiguityCheckPrompt(text: string): string {
  return `Eres un analista de QA que va a convertir la siguiente petición en un plan de pruebas Gherkin.

Antes de escribir el plan, decide si la petición tiene información suficiente (qué funcionalidad, qué flujo, qué resultado esperado) o si es demasiado ambigua para escribir escenarios precisos.

Responde EXCLUSIVAMENTE con un objeto JSON, sin texto adicional ni bloques de código, con esta forma exacta:
{"ambiguous": boolean, "questions": string[]}

Si "ambiguous" es true, "questions" debe tener entre 1 y 4 preguntas concretas que permitan completar la información que falta. Si "ambiguous" es false, "questions" debe ser un array vacío.

Petición del usuario:
"""
${text}
"""`;
}
```

`core/src/agents/intake/ambiguityChecker.ts`:
```ts
import { z } from "zod";
import type { LLMProvider } from "../../llm/provider.js";
import { parseJsonResponse } from "../../llm/parseJson.js";
import { ambiguityCheckPrompt } from "../../prompts/intake.js";

const AmbiguityCheckSchema = z.object({
  ambiguous: z.boolean(),
  questions: z.array(z.string()),
});
export type AmbiguityCheck = z.infer<typeof AmbiguityCheckSchema>;

export async function checkAmbiguity(text: string, llm: LLMProvider): Promise<AmbiguityCheck> {
  const raw = await llm.generate([
    { role: "system", content: "Eres un analista de QA experto en escribir especificaciones Gherkin precisas." },
    { role: "user", content: ambiguityCheckPrompt(text) },
  ]);
  return parseJsonResponse(AmbiguityCheckSchema, raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/intake/ambiguityChecker.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/intake.ts core/src/agents/intake/ambiguityChecker.ts core/src/agents/intake/ambiguityChecker.test.ts
git commit -m "feat(core): add Agent 1 ambiguity checker"
```

---

## Task 12: Pattern matcher

**Files:**
- Modify: `core/src/prompts/intake.ts` (add `patternMatchPrompt`)
- Create: `core/src/patterns/matcher.ts`
- Test: `core/src/patterns/matcher.test.ts`

**Interfaces:**
- Consumes: `Pattern` (Task 9), `LLMProvider`, `FakeLLMProvider`, `parseJsonResponse` (Task 4)
- Produces: `patternMatchPrompt(text: string, patterns: {name:string; description:string}[]): string`, `matchPattern(text: string, patterns: Pattern[], llm: LLMProvider): Promise<Pattern | null>`

- [ ] **Step 1: Write the failing test**

`core/src/patterns/matcher.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../llm/testUtils.js";
import { matchPattern } from "./matcher.js";
import type { Pattern } from "../schemas/pattern.js";

const patterns: Pattern[] = [
  { name: "login", description: "Inicio de sesión", gherkinTemplate: "Feature: x\n", pageObjectTemplate: "" },
  { name: "signup", description: "Registro", gherkinTemplate: "Feature: y\n", pageObjectTemplate: "" },
];

describe("matchPattern", () => {
  it("returns the matched pattern when the model names one", async () => {
    const llm = new FakeLLMProvider(['{"matchedPatternName": "login"}']);
    const result = await matchPattern("Quiero probar que se puede iniciar sesión", patterns, llm);
    expect(result?.name).toBe("login");
  });

  it("returns null when the model says no pattern matches", async () => {
    const llm = new FakeLLMProvider(['{"matchedPatternName": null}']);
    const result = await matchPattern("Quiero probar el carrito de la compra", patterns, llm);
    expect(result).toBeNull();
  });

  it("returns null without calling the model when there are no patterns", async () => {
    const llm = new FakeLLMProvider([]);
    const result = await matchPattern("cualquier cosa", [], llm);
    expect(result).toBeNull();
    expect(llm.receivedCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/patterns/matcher.test.ts`
Expected: FAIL (`Cannot find module './matcher.js'`)

- [ ] **Step 3: Implement**

Add to `core/src/prompts/intake.ts`:
```ts
export function patternMatchPrompt(
  text: string,
  patterns: { name: string; description: string }[]
): string {
  const patternList = patterns.map((p) => `- ${p.name}: ${p.description}`).join("\n");

  return `Tienes esta lista de patrones de prueba conocidos:
${patternList}

Petición del usuario:
"""
${text}
"""

¿La petición encaja claramente con alguno de estos patrones? Responde EXCLUSIVAMENTE con un objeto JSON, sin texto adicional, con esta forma exacta:
{"matchedPatternName": string | null}

Usa null si ningún patrón encaja con suficiente confianza.`;
}
```

`core/src/patterns/matcher.ts`:
```ts
import { z } from "zod";
import type { LLMProvider } from "../llm/provider.js";
import { parseJsonResponse } from "../llm/parseJson.js";
import { patternMatchPrompt } from "../prompts/intake.js";
import type { Pattern } from "../schemas/pattern.js";

const MatchResultSchema = z.object({ matchedPatternName: z.string().nullable() });

export async function matchPattern(
  text: string,
  patterns: Pattern[],
  llm: LLMProvider
): Promise<Pattern | null> {
  if (patterns.length === 0) return null;

  const raw = await llm.generate([
    { role: "system", content: "Identificas si una petición de QA encaja con un patrón de prueba conocido." },
    { role: "user", content: patternMatchPrompt(text, patterns.map((p) => ({ name: p.name, description: p.description }))) },
  ]);

  const result = parseJsonResponse(MatchResultSchema, raw);
  if (!result.matchedPatternName) return null;
  return patterns.find((p) => p.name === result.matchedPatternName) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/patterns/matcher.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/intake.ts core/src/patterns/matcher.ts core/src/patterns/matcher.test.ts
git commit -m "feat(core): add LLM-based pattern matcher"
```

---

## Task 13: Gherkin generator

**Files:**
- Modify: `core/src/prompts/intake.ts` (add `gherkinGenerationPrompt`)
- Create: `core/src/schemas/gherkinPlan.ts`, `core/src/agents/intake/gherkinGenerator.ts`
- Test: `core/src/agents/intake/gherkinGenerator.test.ts`

**Interfaces:**
- Consumes: `Pattern` (Task 9), `LLMProvider`, `FakeLLMProvider` (Task 4), `slugify` (Task 1)
- Produces: `GherkinPlan { fileName: string; featureText: string }`, `gherkinGenerationPrompt(text: string, matchedPattern: {name:string; gherkinTemplate:string} | null): string`, `generateGherkin(text: string, llm: LLMProvider, matchedPattern: Pattern | null): Promise<GherkinPlan>`

- [ ] **Step 1: Write the failing test**

`core/src/agents/intake/gherkinGenerator.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateGherkin } from "./gherkinGenerator.js";

describe("generateGherkin", () => {
  it("derives the file name by slugifying the Feature title", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login con credenciales válidas\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const plan = await generateGherkin("probar login", llm, null);
    expect(plan.fileName).toBe("login-con-credenciales-validas.feature");
    expect(plan.featureText).toContain("Feature: Login con credenciales válidas");
  });

  it("strips markdown code fences from the model response", async () => {
    const llm = new FakeLLMProvider([
      "```gherkin\nFeature: Checkout\n  Scenario: x\n    Given a\n```",
    ]);
    const plan = await generateGherkin("probar checkout", llm, null);
    expect(plan.featureText.startsWith("Feature: Checkout")).toBe(true);
    expect(plan.featureText).not.toContain("```");
  });

  it("falls back to a generic file name when no Feature title is found", async () => {
    const llm = new FakeLLMProvider(["contenido sin cabecera Feature"]);
    const plan = await generateGherkin("texto raro", llm, null);
    expect(plan.fileName).toBe("plan-de-pruebas.feature");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/intake/gherkinGenerator.test.ts`
Expected: FAIL (modules don't exist)

- [ ] **Step 3: Implement**

Add to `core/src/prompts/intake.ts`:
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

`core/src/schemas/gherkinPlan.ts`:
```ts
export interface GherkinPlan {
  fileName: string;
  featureText: string;
}
```

`core/src/agents/intake/gherkinGenerator.ts`:
```ts
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import { gherkinGenerationPrompt } from "../../prompts/intake.js";
import { slugify } from "../../util/slugify.js";

function extractFeatureTitle(featureText: string): string {
  const match = featureText.match(/^Feature:\s*(.+)$/m);
  return match ? match[1].trim() : "plan de pruebas";
}

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:gherkin)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export async function generateGherkin(
  text: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null
): Promise<GherkinPlan> {
  const raw = await llm.generate([
    { role: "system", content: "Eres un analista de QA experto en especificaciones Gherkin." },
    { role: "user", content: gherkinGenerationPrompt(text, matchedPattern) },
  ]);

  const featureText = stripCodeFences(raw);
  const fileName = `${slugify(extractFeatureTitle(featureText))}.feature`;

  return { fileName, featureText };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/intake/gherkinGenerator.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/intake.ts core/src/schemas/gherkinPlan.ts core/src/agents/intake/gherkinGenerator.ts core/src/agents/intake/gherkinGenerator.test.ts
git commit -m "feat(core): add Gherkin generator"
```

---

## Task 14: Write feature file to disk

**Files:**
- Create: `core/src/agents/intake/writeFeatureFile.ts`
- Test: `core/src/agents/intake/writeFeatureFile.test.ts`

**Interfaces:**
- Consumes: `GherkinPlan` (Task 13)
- Produces: `writeFeatureFile(projectRoot: string, testsDir: string, plan: GherkinPlan): Promise<string>` (returns the absolute path written)

- [ ] **Step 1: Write the failing test**

`core/src/agents/intake/writeFeatureFile.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFeatureFile } from "./writeFeatureFile.js";

describe("writeFeatureFile", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-write-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("writes the feature file under <testsDir>/features/", async () => {
    const plan = { fileName: "login.feature", featureText: "Feature: Login\n" };
    const filePath = await writeFeatureFile(tmpProject, "tests", plan);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toBe("Feature: Login\n");
  });

  it("creates intermediate directories if they don't exist", async () => {
    const plan = { fileName: "signup.feature", featureText: "Feature: Signup\n" };
    await writeFeatureFile(tmpProject, "qa/tests", plan);
    const exists = await fs
      .stat(path.join(tmpProject, "qa", "tests", "features", "signup.feature"))
      .then(() => true, () => false);
    expect(exists).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/intake/writeFeatureFile.test.ts`
Expected: FAIL (`Cannot find module './writeFeatureFile.js'`)

- [ ] **Step 3: Implement**

`core/src/agents/intake/writeFeatureFile.ts`:
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";

export async function writeFeatureFile(
  projectRoot: string,
  testsDir: string,
  plan: GherkinPlan
): Promise<string> {
  const dir = path.join(projectRoot, testsDir, "features");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, plan.fileName);
  await fs.writeFile(filePath, plan.featureText, "utf-8");
  return filePath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/intake/writeFeatureFile.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/intake/writeFeatureFile.ts core/src/agents/intake/writeFeatureFile.test.ts
git commit -m "feat(core): write approved Gherkin plans to disk"
```

---

## Task 15: Intake orchestrator (`runIntake`)

**Files:**
- Create: `core/src/agents/intake/runIntake.ts`
- Test: `core/src/agents/intake/runIntake.test.ts`

**Interfaces:**
- Consumes: `checkAmbiguity` (Task 11), `matchPattern` (Task 12), `generateGherkin` (Task 13), `writeFeatureFile` (Task 14), `saveProjectPattern` (Task 10), `Pattern`, `GherkinPlan`, `LLMProvider`, `FakeLLMProvider`
- Produces: `IntakeCallbacks { askUser(question: string): Promise<string>; presentForApproval(plan: GherkinPlan): Promise<{approved: boolean; feedback?: string}>; offerSavePattern(plan: GherkinPlan): Promise<{save: boolean; name?: string; description?: string}> }`, `runIntake(initialText: string, llm: LLMProvider, patterns: Pattern[], projectRoot: string, testsDir: string, callbacks: IntakeCallbacks): Promise<{plan: GherkinPlan; filePath: string}>`

This is the core behavioral contract of Agente 1: ask when ambiguous, reuse a matched pattern when found, require explicit approval (looping on feedback), and only offer to learn a new pattern when nothing matched. A pattern learned at this stage has an empty `pageObjectTemplate` — Agente 2 (a later plan) is what actually produces Playwright/POM code, so this plan cannot populate that field yet; a future plan updates learned patterns with it once generated.

- [ ] **Step 1: Write the failing test**

`core/src/agents/intake/runIntake.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { runIntake, type IntakeCallbacks } from "./runIntake.js";
import type { Pattern } from "../../schemas/pattern.js";

const loginPattern: Pattern = {
  name: "login",
  description: "Inicio de sesión",
  gherkinTemplate: "Feature: Login\n  Scenario: x\n    Given a\n",
  pageObjectTemplate: "",
};

describe("runIntake", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-intake-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("happy path: no ambiguity, matches a pattern, approved on first try, no save offer", async () => {
    const llm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);

    const callbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      offerSavePattern: vi.fn(),
    };

    const { plan, filePath } = await runIntake(
      "quiero probar el login",
      llm,
      [loginPattern],
      tmpProject,
      "tests",
      callbacks
    );

    expect(plan.fileName).toBe("login.feature");
    expect(callbacks.askUser).not.toHaveBeenCalled();
    expect(callbacks.offerSavePattern).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf-8")).toBe(plan.featureText);
  });

  it("ambiguous + no match: asks clarifying questions, loops on rejection, saves new pattern on approval", async () => {
    const llm = new FakeLLMProvider([
      '{"ambiguous": true, "questions": ["¿Qué navegador?"]}',
      '{"matchedPatternName": null}',
      "Feature: Caso custom\n  Scenario: x\n    Given a\n",
      "Feature: Caso custom v2\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);

    const callbacks: IntakeCallbacks = {
      askUser: vi.fn().mockResolvedValue("Chrome"),
      presentForApproval: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, feedback: "añade el resultado esperado" })
        .mockResolvedValueOnce({ approved: true }),
      offerSavePattern: vi
        .fn()
        .mockResolvedValue({ save: true, name: "caso-custom", description: "Caso de prueba a medida" }),
    };

    const { plan, filePath } = await runIntake(
      "quiero probar algo",
      llm,
      [],
      tmpProject,
      "tests",
      callbacks
    );

    expect(callbacks.askUser).toHaveBeenCalledWith("¿Qué navegador?");
    expect(plan.featureText).toContain("Caso custom v2");
    expect(await fs.readFile(filePath, "utf-8")).toBe(plan.featureText);

    const savedPatternRaw = await fs.readFile(
      path.join(tmpProject, ".agente-qa", "templates", "caso-custom.json"),
      "utf-8"
    );
    const savedPattern = JSON.parse(savedPatternRaw);
    expect(savedPattern.name).toBe("caso-custom");
    expect(savedPattern.gherkinTemplate).toBe(plan.featureText);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/intake/runIntake.test.ts`
Expected: FAIL (`Cannot find module './runIntake.js'`)

- [ ] **Step 3: Implement**

`core/src/agents/intake/runIntake.ts`:
```ts
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import { checkAmbiguity } from "./ambiguityChecker.js";
import { matchPattern } from "../../patterns/matcher.js";
import { generateGherkin } from "./gherkinGenerator.js";
import { writeFeatureFile } from "./writeFeatureFile.js";
import { saveProjectPattern } from "../../patterns/registry.js";

export interface IntakeCallbacks {
  askUser(question: string): Promise<string>;
  presentForApproval(plan: GherkinPlan): Promise<{ approved: boolean; feedback?: string }>;
  offerSavePattern(plan: GherkinPlan): Promise<{ save: boolean; name?: string; description?: string }>;
}

export async function runIntake(
  initialText: string,
  llm: LLMProvider,
  patterns: Pattern[],
  projectRoot: string,
  testsDir: string,
  callbacks: IntakeCallbacks
): Promise<{ plan: GherkinPlan; filePath: string }> {
  let text = initialText;

  const ambiguity = await checkAmbiguity(text, llm);
  if (ambiguity.ambiguous) {
    const answers: string[] = [];
    for (const question of ambiguity.questions) {
      const answer = await callbacks.askUser(question);
      answers.push(`${question}\n${answer}`);
    }
    text = `${text}\n\nAclaraciones:\n${answers.join("\n\n")}`;
  }

  const matched = await matchPattern(text, patterns, llm);

  let plan = await generateGherkin(text, llm, matched);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const decision = await callbacks.presentForApproval(plan);
    if (decision.approved) break;
    text = `${text}\n\nCambios solicitados sobre la versión anterior:\n${decision.feedback ?? ""}`;
    plan = await generateGherkin(text, llm, matched);
  }

  if (!matched) {
    const saveDecision = await callbacks.offerSavePattern(plan);
    if (saveDecision.save && saveDecision.name && saveDecision.description) {
      await saveProjectPattern(projectRoot, {
        name: saveDecision.name,
        description: saveDecision.description,
        gherkinTemplate: plan.featureText,
        pageObjectTemplate: "",
      });
    }
  }

  const filePath = await writeFeatureFile(projectRoot, testsDir, plan);

  return { plan, filePath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/intake/runIntake.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/intake/runIntake.ts core/src/agents/intake/runIntake.test.ts
git commit -m "feat(core): add Agente 1 orchestrator (runIntake)"
```

---

## Task 16: Core public API barrel

**Files:**
- Create: `core/src/index.ts`
- Test: `core/src/index.test.ts`

**Interfaces:**
- Consumes: every symbol produced in Tasks 1-15
- Produces: the `@agente-qa/core` public surface consumed by `cli`

- [ ] **Step 1: Write the failing test**

`core/src/index.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import * as core from "./index.js";

describe("@agente-qa/core public API", () => {
  it("exports the config functions", () => {
    expect(typeof core.saveCredentials).toBe("function");
    expect(typeof core.loadCredentials).toBe("function");
    expect(typeof core.saveProjectConfig).toBe("function");
    expect(typeof core.loadProjectConfig).toBe("function");
  });

  it("exports the LLM provider factory and fake test double", () => {
    expect(typeof core.createProvider).toBe("function");
    expect(typeof core.FakeLLMProvider).toBe("function");
  });

  it("exports the pattern registry", () => {
    expect(typeof core.loadAllPatterns).toBe("function");
    expect(typeof core.saveProjectPattern).toBe("function");
  });

  it("exports the intake orchestrator", () => {
    expect(typeof core.runIntake).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/index.test.ts`
Expected: FAIL (`Cannot find module './index.js'`)

- [ ] **Step 3: Implement**

`core/src/index.ts`:
```ts
export { slugify } from "./util/slugify.js";

export {
  ProviderNameSchema,
  CredentialsSchema,
  credentialsPath,
  saveCredentials,
  loadCredentials,
} from "./config/credentials.js";
export type { ProviderName, Credentials } from "./config/credentials.js";

export {
  ProjectConfigSchema,
  projectConfigPath,
  saveProjectConfig,
  loadProjectConfig,
} from "./config/projectConfig.js";
export type { ProjectConfig } from "./config/projectConfig.js";

export type { Message, LLMProvider } from "./llm/provider.js";
export { LLMResponseParseError, parseJsonResponse } from "./llm/parseJson.js";
export { FakeLLMProvider } from "./llm/testUtils.js";
export { createProvider } from "./llm/factory.js";

export { PatternSchema } from "./schemas/pattern.js";
export type { Pattern } from "./schemas/pattern.js";
export type { GherkinPlan } from "./schemas/gherkinPlan.js";

export {
  loadBuiltinPatterns,
  loadProjectPatterns,
  loadAllPatterns,
  saveProjectPattern,
} from "./patterns/registry.js";
export { matchPattern } from "./patterns/matcher.js";

export { checkAmbiguity } from "./agents/intake/ambiguityChecker.js";
export { generateGherkin } from "./agents/intake/gherkinGenerator.js";
export { writeFeatureFile } from "./agents/intake/writeFeatureFile.js";
export { runIntake } from "./agents/intake/runIntake.js";
export type { IntakeCallbacks } from "./agents/intake/runIntake.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/index.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Verify the whole core suite is still green**

Run: `npx vitest run core`
Expected: PASS (all core tests)

- [ ] **Step 6: Commit**

```bash
git add core/src/index.ts core/src/index.test.ts
git commit -m "feat(core): expose public API barrel"
```

---

## Task 17: CLI init command

**Files:**
- Create: `cli/src/prompts/types.ts`, `cli/src/commands/init.ts`
- Test: `cli/src/commands/init.test.ts`

**Interfaces:**
- Consumes: `ProviderName`, `saveCredentials`, `saveProjectConfig` (from `@agente-qa/core`)
- Produces: `InitPrompts { selectProvider(): Promise<ProviderName>; inputApiKey(provider: ProviderName): Promise<string>; inputTestsDir(): Promise<string> }`, `runInit(prompts: InitPrompts, homeDir: string, projectRoot: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

`cli/src/commands/init.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCredentials, loadProjectConfig } from "@agente-qa/core";
import { runInit } from "./init.js";
import type { InitPrompts } from "../prompts/types.js";

describe("runInit", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-init-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-init-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("saves credentials and project config from the prompt answers", async () => {
    const prompts: InitPrompts = {
      selectProvider: async () => "anthropic",
      inputApiKey: async () => "sk-ant-test",
      inputTestsDir: async () => "tests",
    };

    await runInit(prompts, tmpHome, tmpProject);

    expect(await loadCredentials(tmpHome)).toEqual({ provider: "anthropic", apiKey: "sk-ant-test" });
    expect(await loadProjectConfig(tmpProject)).toEqual({ testsDir: "tests" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: FAIL (modules don't exist)

- [ ] **Step 3: Implement**

`cli/src/prompts/types.ts`:
```ts
import type { ProviderName } from "@agente-qa/core";

export interface InitPrompts {
  selectProvider(): Promise<ProviderName>;
  inputApiKey(provider: ProviderName): Promise<string>;
  inputTestsDir(): Promise<string>;
}

export type MenuChoice = "create-plan" | "generate-tests" | "run-tests" | "reports" | "config" | "exit";

export interface MenuPrompts {
  selectMenuChoice(): Promise<MenuChoice>;
}

export interface ChatPrompts {
  inputInitialText(): Promise<string>;
  askUser(question: string): Promise<string>;
  presentForApproval(featureText: string): Promise<{ approved: boolean; feedback?: string }>;
  offerSavePattern(): Promise<{ save: boolean; name?: string; description?: string }>;
}
```

`cli/src/commands/init.ts`:
```ts
import { saveCredentials, saveProjectConfig } from "@agente-qa/core";
import type { InitPrompts } from "../prompts/types.js";

export async function runInit(prompts: InitPrompts, homeDir: string, projectRoot: string): Promise<void> {
  const provider = await prompts.selectProvider();
  const apiKey = await prompts.inputApiKey(provider);
  await saveCredentials({ provider, apiKey }, homeDir);

  const testsDir = await prompts.inputTestsDir();
  await saveProjectConfig(projectRoot, { testsDir });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add cli/src/prompts/types.ts cli/src/commands/init.ts cli/src/commands/init.test.ts
git commit -m "feat(cli): add init command"
```

---

## Task 18: CLI create-plan command (wires Agente 1)

**Files:**
- Create: `cli/src/commands/chat.ts`
- Test: `cli/src/commands/chat.test.ts`

**Interfaces:**
- Consumes: `createProvider`, `loadCredentials`, `loadProjectConfig`, `loadAllPatterns`, `runIntake`, `IntakeCallbacks` (from `@agente-qa/core`), `ChatPrompts` (Task 17)
- Produces: `runCreatePlan(prompts: ChatPrompts, homeDir: string, projectRoot: string): Promise<string>` (returns the written file path)

- [ ] **Step 1: Write the failing test**

`cli/src/commands/chat.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, saveProjectConfig, FakeLLMProvider } from "@agente-qa/core";
import type { ChatPrompts } from "../prompts/types.js";

const createProviderMock = vi.fn();

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
  };
});

import { runCreatePlan } from "./chat.js";

describe("runCreatePlan", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-chat-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-chat-project-"));
    createProviderMock.mockReset();
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
      offerSavePattern: vi.fn(),
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
      offerSavePattern: vi.fn(),
    };

    const filePath = await runCreatePlan(prompts, tmpHome, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toContain("Feature: Login");
    expect(prompts.offerSavePattern).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/commands/chat.test.ts`
Expected: FAIL (`Cannot find module './chat.js'`)

- [ ] **Step 3: Implement**

`cli/src/commands/chat.ts`:
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

  const llm = createProvider(credentials);
  const patterns = await loadAllPatterns(projectRoot);
  const initialText = await prompts.inputInitialText();

  const callbacks: IntakeCallbacks = {
    askUser: (question) => prompts.askUser(question),
    presentForApproval: (plan) => prompts.presentForApproval(plan.featureText),
    offerSavePattern: () => prompts.offerSavePattern(),
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/commands/chat.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/chat.ts cli/src/commands/chat.test.ts
git commit -m "feat(cli): wire Agente 1 into a create-plan command"
```

---

## Task 19: CLI main menu

**Files:**
- Create: `cli/src/menu.ts`
- Test: `cli/src/menu.test.ts`

**Interfaces:**
- Consumes: `MenuPrompts`, `MenuChoice`, `ChatPrompts`, `InitPrompts` (Task 17), `runCreatePlan` (Task 18), `runInit` (Task 17)
- Produces: `runMenuLoop(deps: { menuPrompts: MenuPrompts; chatPrompts: ChatPrompts; initPrompts: InitPrompts; homeDir: string; projectRoot: string }): Promise<void>`

- [ ] **Step 1: Write the failing test**

`cli/src/menu.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runCreatePlanMock = vi.fn();
const runInitMock = vi.fn();

vi.mock("./commands/chat.js", () => ({
  runCreatePlan: (...args: unknown[]) => runCreatePlanMock(...args),
}));
vi.mock("./commands/init.js", () => ({
  runInit: (...args: unknown[]) => runInitMock(...args),
}));

import { runMenuLoop } from "./menu.js";
import type { MenuChoice } from "./prompts/types.js";

describe("runMenuLoop", () => {
  beforeEach(() => {
    runCreatePlanMock.mockReset();
    runInitMock.mockReset();
  });

  it("routes 'create-plan' to runCreatePlan and exits on 'exit'", async () => {
    const choices: MenuChoice[] = ["create-plan", "exit"];
    let i = 0;
    runCreatePlanMock.mockResolvedValue("/tmp/tests/features/login.feature");

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runCreatePlanMock).toHaveBeenCalledTimes(1);
  });

  it("routes 'config' to runInit", async () => {
    const choices: MenuChoice[] = ["config", "exit"];
    let i = 0;

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runInitMock).toHaveBeenCalledTimes(1);
  });

  it("loops through multiple choices before exiting", async () => {
    const choices: MenuChoice[] = ["generate-tests", "run-tests", "reports", "exit"];
    let i = 0;

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(i).toBe(4);
    expect(runCreatePlanMock).not.toHaveBeenCalled();
    expect(runInitMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/menu.test.ts`
Expected: FAIL (`Cannot find module './menu.js'`)

- [ ] **Step 3: Implement**

`cli/src/menu.ts`:
```ts
import type { MenuPrompts, ChatPrompts, InitPrompts } from "./prompts/types.js";
import { runCreatePlan } from "./commands/chat.js";
import { runInit } from "./commands/init.js";

export interface MenuDeps {
  menuPrompts: MenuPrompts;
  chatPrompts: ChatPrompts;
  initPrompts: InitPrompts;
  homeDir: string;
  projectRoot: string;
}

export async function runMenuLoop(deps: MenuDeps): Promise<void> {
  console.log("Soy Agente_QA. ¿Qué quieres hacer?");
  let running = true;

  while (running) {
    const choice = await deps.menuPrompts.selectMenuChoice();

    switch (choice) {
      case "create-plan": {
        const filePath = await runCreatePlan(deps.chatPrompts, deps.homeDir, deps.projectRoot);
        console.log(`Plan guardado en ${filePath}`);
        break;
      }
      case "config": {
        await runInit(deps.initPrompts, deps.homeDir, deps.projectRoot);
        console.log("Configuración actualizada.");
        break;
      }
      case "generate-tests":
      case "run-tests":
      case "reports":
        console.log("Todavía no implementado en esta versión.");
        break;
      case "exit":
        running = false;
        break;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/menu.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/menu.ts cli/src/menu.test.ts
git commit -m "feat(cli): add main menu loop"
```

---

## Task 20: Real terminal prompts + CLI entry point

**Files:**
- Create: `cli/src/prompts/inquirerPrompts.ts`, `cli/bin/agente-qa.ts`

**Interfaces:**
- Consumes: `InitPrompts`, `MenuPrompts`, `ChatPrompts`, `MenuChoice` (Task 17), `ProviderName` (from `@agente-qa/core`), `runMenuLoop` (Task 19), `runInit` (Task 17)
- Produces: `realInitPrompts: InitPrompts`, `realMenuPrompts: MenuPrompts`, `buildRealChatPrompts(): ChatPrompts`, the `agente-qa` executable (`init` and `chat` commands)

This task is thin terminal-I/O glue over `@inquirer/prompts`, wiring the already-tested logic to a real terminal. It isn't unit tested itself — Task 18's `runCreatePlan` test and Task 19's `runMenuLoop` test already cover all the logic this glue calls into; this task is verified manually in Step 3.

- [ ] **Step 1: Implement the real prompts adapter**

`cli/src/prompts/inquirerPrompts.ts`:
```ts
import { select, input, password } from "@inquirer/prompts";
import type { ProviderName } from "@agente-qa/core";
import type { InitPrompts, MenuPrompts, MenuChoice, ChatPrompts } from "./types.js";

export const realInitPrompts: InitPrompts = {
  async selectProvider() {
    return select<ProviderName>({
      message: "¿Qué proveedor de LLM quieres usar?",
      choices: [
        { name: "Anthropic (Claude)", value: "anthropic" },
        { name: "OpenAI", value: "openai" },
        { name: "Google", value: "google" },
      ],
    });
  },
  async inputApiKey(provider) {
    return password({ message: `Pega tu API key de ${provider}:` });
  },
  async inputTestsDir() {
    return input({ message: "¿En qué carpeta guardamos los tests? (relativa al proyecto)", default: "tests" });
  },
};

export const realMenuPrompts: MenuPrompts = {
  async selectMenuChoice() {
    return select<MenuChoice>({
      message: "¿Qué quieres hacer?",
      choices: [
        { name: "Crear plan de pruebas desde un texto", value: "create-plan" },
        { name: "Generar tests Playwright desde un plan aprobado", value: "generate-tests" },
        { name: "Ejecutar tests", value: "run-tests" },
        { name: "Ver/generar reportes", value: "reports" },
        { name: "Configuración", value: "config" },
        { name: "Salir", value: "exit" },
      ],
    });
  },
};

export function buildRealChatPrompts(): ChatPrompts {
  return {
    async inputInitialText() {
      return input({ message: "¿Qué quieres probar? (pega el texto o descríbelo)" });
    },
    async askUser(question) {
      return input({ message: question });
    },
    async presentForApproval(featureText) {
      console.log(`\n${featureText}\n`);
      const approved = await select({
        message: "¿Apruebas este plan?",
        choices: [
          { name: "Sí, aprobar", value: true },
          { name: "No, pedir cambios", value: false },
        ],
      });
      if (approved) return { approved: true };
      const feedback = await input({ message: "¿Qué cambios quieres?" });
      return { approved: false, feedback };
    },
    async offerSavePattern() {
      const save = await select({
        message: "Esto parece un patrón reusable. ¿Lo guardo para la próxima vez?",
        choices: [
          { name: "Sí", value: true },
          { name: "No", value: false },
        ],
      });
      if (!save) return { save: false };
      const name = await input({ message: "Nombre del patrón:" });
      const description = await input({ message: "Descripción breve:" });
      return { save: true, name, description };
    },
  };
}
```

- [ ] **Step 2: Implement the entry point**

`cli/bin/agente-qa.ts`:
```ts
#!/usr/bin/env node
import { Command } from "commander";
import os from "node:os";
import { runInit } from "../src/commands/init.js";
import { runMenuLoop } from "../src/menu.js";
import { realInitPrompts, realMenuPrompts, buildRealChatPrompts } from "../src/prompts/inquirerPrompts.js";

const program = new Command();
program.name("agente-qa").description("Asistente agéntico de automatización de QA");

program
  .command("init")
  .description("Configura credenciales y preferencias del proyecto")
  .action(async () => {
    await runInit(realInitPrompts, os.homedir(), process.cwd());
    console.log("Configuración guardada.");
  });

program
  .command("chat")
  .description("Inicia la conversación con Agente_QA")
  .action(async () => {
    await runMenuLoop({
      menuPrompts: realMenuPrompts,
      chatPrompts: buildRealChatPrompts(),
      initPrompts: realInitPrompts,
      homeDir: os.homedir(),
      projectRoot: process.cwd(),
    });
  });

program.parseAsync(process.argv);
```

- [ ] **Step 3: Manual smoke test**

Run, from the repo root:
```bash
npm run build
node cli/dist/bin/agente-qa.js init
```
Expected: prompts for provider, API key, tests folder; afterwards `~/.agente-qa/credentials.json` and `<cwd>/.agente-qa/config.json` exist with the entered values.

```bash
node cli/dist/bin/agente-qa.js chat
```
Expected: prints the menu, selecting "Crear plan de pruebas desde un texto" walks through the real conversation and, on approval, prints the path of the written `.feature` file.

- [ ] **Step 4: Commit**

```bash
git add cli/src/prompts/inquirerPrompts.ts cli/bin/agente-qa.ts
git commit -m "feat(cli): add real terminal prompts and the agente-qa entry point"
```

---

## Task 21: End-to-end integration test

**Files:**
- Test: `cli/src/commands/chat.e2e.test.ts`

**Interfaces:**
- Consumes: `runCreatePlan` (Task 18), `saveCredentials`, `saveProjectConfig`, `loadAllPatterns` (from `@agente-qa/core`)

Proves the full real wiring works together — real config loading, the real pattern registry (built-in patterns, not fakes), and only the network-calling boundary (`ai`'s `generateText`) mocked.

- [ ] **Step 1: Write the test**

`cli/src/commands/chat.e2e.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, saveProjectConfig } from "@agente-qa/core";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

import { runCreatePlan } from "./chat.js";
import type { ChatPrompts } from "../prompts/types.js";

describe("end-to-end: create plan via the real wiring, only the network call mocked", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-e2e-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-e2e-project-"));
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test" }, tmpHome);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    generateTextMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
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
      offerSavePattern: vi.fn(),
    };

    const filePath = await runCreatePlan(prompts, tmpHome, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("Feature: Login");
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run cli/src/commands/chat.e2e.test.ts`
Expected: PASS (1 test)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (every test across `core` and `cli`)

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/chat.e2e.test.ts
git commit -m "test: add end-to-end coverage for the intake flow through the real wiring"
```

---

## Self-Review Notes

- **Spec coverage:** intake source = plain text (§5 Agente 1) → Task 18/21 (`inputInitialText`, no GitHub/Jira). Ambiguity → asks before assuming (§5, §8) → Task 11 + Task 15's clarifying loop. Pattern reuse (§6) → Tasks 9-10 (built-in login/logout/signup/password-reset) + Task 12 (matcher) + Task 15 (reuses matched template in the generation prompt). Explicit approval checkpoint (§5) → Task 15's approval loop. Pattern learning only on confirmation, local to the project (§6) → Task 15's `offerSavePattern` + Task 10's `saveProjectPattern`. Credentials/config storage split (§4) → Tasks 2-3. Multi-LLM API-key auth (§2, §4) → Tasks 5-8. Opening menu (§7) → Task 19/20. Error handling for "not initialized yet" → Task 18. Agent 2/3/4, GitHub/Jira intake, Copilot-style subscription adapters, and shared cross-project pattern sharing are explicitly out of scope per the spec's non-goals and are left for later plans.
- **Placeholder scan:** none — every step has concrete file content and real assertions. The two "verify current model id" notes (Tasks 6-7) are explicit, actionable instructions, not TBDs.
- **Type consistency:** `LLMProvider.generate(messages: Message[]): Promise<string>` is identical across the interface (Task 4), all three adapters (Tasks 5-7), and every consumer. `Pattern` and `GherkinPlan` shapes are defined once (Tasks 9, 13) and reused verbatim everywhere else. `IntakeCallbacks` (Task 15) and `ChatPrompts` (Task 17) match at the Task 18 adapter boundary. `ProviderName`/`Credentials`/`ProjectConfig` are defined once (Tasks 2-3) and reused by the factory (Task 8) and CLI (Tasks 17-18).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-core-foundations-agent1-intake.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
