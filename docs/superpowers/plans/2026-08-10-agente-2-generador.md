# Agente 2 (Generador) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Agente 2 (Generador): takes a `.feature` approved by Agente 1 and generates Playwright tests (Python, pytest-bdd, Page Object Model), with an automatic compile/lint self-check loop before writing anything to the user's project. Wired end to end into the CLI's "Generar tests Playwright" menu option.

**Architecture:** New `core/src/agents/generador/` module (mirrors the existing `intake/` module) plus a new `core/src/codeCheck/` module providing an injectable `CodeChecker` (same DI pattern as `LLMProvider`: an interface, a fake for tests, a real implementation that shells out to `ruff`/`python`). Includes a scope correction to already-shipped Agente 1 code: pattern-saving moves from Agente 1 to Agente 2, and Agente 1 now stamps which pattern (if any) it matched into the `.feature` file so Agente 2 can read it back in a separate session.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Vitest, Zod, existing `LLMProvider`/`FakeLLMProvider` DI pattern, Node `child_process` (new: shells out to `ruff` + `python -m py_compile`).

## Global Constraints

- TypeScript strict mode across `core` and `cli`; no `any` in production code.
- Node.js >= 22.
- `core` has no direct terminal I/O (no `console.log`/`readline` inside `core/src`) — all human interaction crosses an injected callback interface. Shelling out to `ruff`/`python` via `child_process` is NOT terminal I/O with the user and does not violate this — same principle already applies to `LLMProvider` calling an external API.
- Learned patterns are only ever saved after explicit user confirmation, never silently.
- Any step where the agent could act on an ambiguous or unconfirmed assumption must instead ask — never silently guess.
- New in this plan: generating and writing test files to the user's project only happens after the generated code passes an automated compile/lint check (`CodeChecker`) — never write code that hasn't passed that check.
- New in this plan: `ruff`/`python` may not be installed on the host machine. That is a distinct failure mode from "the generated code has an error" — it must fail immediately with a clear message, never be retried through the auto-correction loop.

Spec reference: `docs/superpowers/specs/2026-08-10-agente-2-generador-design.md` (read this first — it has the full reasoning for every decision below; this plan only re-states what's needed to implement).

---

## File Structure

```
core/src/
  schemas/
    gherkinPlan.ts            # MODIFY: add matchedPatternName
  agents/
    intake/
      runIntake.ts             # MODIFY: remove pattern-saving
      gherkinGenerator.ts       # MODIFY: propagate matchedPatternName
      writeFeatureFile.ts       # MODIFY: write pattern header comment
    generador/
      parseFeatureHeader.ts     # NEW
      codeGenerator.ts           # NEW
      writeTestFiles.ts          # NEW
      listFeatureFiles.ts        # NEW
      runGenerador.ts             # NEW
  codeCheck/
    codeChecker.ts               # NEW: CodeChecker interface
    testUtils.ts                  # NEW: FakeCodeChecker
    realCodeChecker.ts            # NEW: real ruff/py_compile implementation
  prompts/
    generador.ts                 # NEW: code generation prompt
  index.ts                        # MODIFY: export new public surface
cli/src/
  prompts/
    types.ts                     # MODIFY: remove ChatPrompts.offerSavePattern, add GeneratorPrompts
    inquirerPrompts.ts            # MODIFY: remove offerSavePattern from buildRealChatPrompts, add buildRealGeneratorPrompts
  commands/
    chat.ts                      # MODIFY: remove offerSavePattern wiring
    generate.ts                   # NEW: runGenerateTests
  menu.ts                         # MODIFY: wire "generate-tests" to runGenerateTests
```

---

## Task 1: Pattern metadata round-trip (`GherkinPlan.matchedPatternName` + header write/read)

**Files:**
- Modify: `core/src/schemas/gherkinPlan.ts`
- Modify: `core/src/agents/intake/gherkinGenerator.ts`
- Test: `core/src/agents/intake/gherkinGenerator.test.ts`
- Modify: `core/src/agents/intake/writeFeatureFile.ts`
- Test: `core/src/agents/intake/writeFeatureFile.test.ts`
- Create: `core/src/agents/generador/parseFeatureHeader.ts`
- Test: `core/src/agents/generador/parseFeatureHeader.test.ts`

**Interfaces:**
- Consumes: `Pattern` (existing)
- Produces: `GherkinPlan { fileName: string; featureText: string; matchedPatternName: string | null }`, `parseFeatureHeader(featureText: string): string | null`

- [ ] **Step 1: Write the failing tests**

Add to `core/src/agents/intake/gherkinGenerator.test.ts` (append these two `it` blocks inside the existing `describe`):

```ts
  it("sets matchedPatternName to the matched pattern's name", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const matchedPattern = {
      name: "login",
      description: "Inicio de sesión",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "",
    };
    const plan = await generateGherkin("probar login", llm, matchedPattern);
    expect(plan.matchedPatternName).toBe("login");
  });

  it("sets matchedPatternName to null when no pattern matched", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Checkout\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const plan = await generateGherkin("probar checkout", llm, null);
    expect(plan.matchedPatternName).toBeNull();
  });
```

Replace `core/src/agents/intake/writeFeatureFile.test.ts` in full:

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
    const plan = { fileName: "login.feature", featureText: "Feature: Login\n", matchedPatternName: null };
    const filePath = await writeFeatureFile(tmpProject, "tests", plan);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toBe("Feature: Login\n");
  });

  it("creates intermediate directories if they don't exist", async () => {
    const plan = { fileName: "signup.feature", featureText: "Feature: Signup\n", matchedPatternName: null };
    await writeFeatureFile(tmpProject, "qa/tests", plan);
    const exists = await fs
      .stat(path.join(tmpProject, "qa", "tests", "features", "signup.feature"))
      .then(() => true, () => false);
    expect(exists).toBe(true);
  });

  it("prepends a pattern header comment when matchedPatternName is set", async () => {
    const plan = { fileName: "login.feature", featureText: "Feature: Login\n", matchedPatternName: "login" };
    const filePath = await writeFeatureFile(tmpProject, "tests", plan);

    expect(await fs.readFile(filePath, "utf-8")).toBe("# agente-qa:pattern=login\nFeature: Login\n");
  });

  it("writes no header when matchedPatternName is null", async () => {
    const plan = { fileName: "checkout.feature", featureText: "Feature: Checkout\n", matchedPatternName: null };
    const filePath = await writeFeatureFile(tmpProject, "tests", plan);

    expect(await fs.readFile(filePath, "utf-8")).toBe("Feature: Checkout\n");
  });
});
```

Create `core/src/agents/generador/parseFeatureHeader.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseFeatureHeader } from "./parseFeatureHeader.js";

describe("parseFeatureHeader", () => {
  it("reads the pattern name from the header comment", () => {
    expect(parseFeatureHeader("# agente-qa:pattern=login\nFeature: Login\n")).toBe("login");
  });

  it("returns null when there's no header", () => {
    expect(parseFeatureHeader("Feature: Checkout\n")).toBeNull();
  });

  it("returns null when the comment is on a line other than the first", () => {
    expect(parseFeatureHeader("Feature: Login\n# agente-qa:pattern=login\n")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run core/src/agents/intake/gherkinGenerator.test.ts core/src/agents/intake/writeFeatureFile.test.ts core/src/agents/generador/parseFeatureHeader.test.ts`
Expected: FAIL — `writeFeatureFile.test.ts` fails on type/behavior mismatch (no `matchedPatternName` handling yet), `parseFeatureHeader.test.ts` fails with `Cannot find module './parseFeatureHeader.js'`.

- [ ] **Step 3: Implement**

`core/src/schemas/gherkinPlan.ts`:
```ts
export interface GherkinPlan {
  fileName: string;
  featureText: string;
  matchedPatternName: string | null;
}
```

`core/src/agents/intake/gherkinGenerator.ts` (full file):
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

  if (!/^\s*(@\S+\s*)*Feature:/.test(featureText)) {
    throw new Error(
      `La respuesta del modelo no parece un archivo Gherkin válido (no empieza por "Feature:"): ${featureText.slice(0, 80)}...`
    );
  }

  const fileName = `${slugify(extractFeatureTitle(featureText))}.feature`;

  return { fileName, featureText, matchedPatternName: matchedPattern?.name ?? null };
}
```

`core/src/agents/intake/writeFeatureFile.ts` (full file):
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";

export function featureFilePath(projectRoot: string, testsDir: string, fileName: string): string {
  return path.join(projectRoot, testsDir, "features", fileName);
}

export async function featureFileExists(
  projectRoot: string,
  testsDir: string,
  fileName: string
): Promise<boolean> {
  try {
    await fs.access(featureFilePath(projectRoot, testsDir, fileName));
    return true;
  } catch {
    return false;
  }
}

export async function writeFeatureFile(
  projectRoot: string,
  testsDir: string,
  plan: GherkinPlan
): Promise<string> {
  const dir = path.join(projectRoot, testsDir, "features");
  await fs.mkdir(dir, { recursive: true });
  const filePath = featureFilePath(projectRoot, testsDir, plan.fileName);
  const content = plan.matchedPatternName
    ? `# agente-qa:pattern=${plan.matchedPatternName}\n${plan.featureText}`
    : plan.featureText;
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}
```

`core/src/agents/generador/parseFeatureHeader.ts`:
```ts
export function parseFeatureHeader(featureText: string): string | null {
  const firstLine = featureText.split("\n", 1)[0];
  const match = firstLine.match(/^# agente-qa:pattern=(.+)$/);
  return match ? match[1].trim() : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/agents/intake/gherkinGenerator.test.ts core/src/agents/intake/writeFeatureFile.test.ts core/src/agents/generador/parseFeatureHeader.test.ts`
Expected: PASS (7 + 4 + 3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/schemas/gherkinPlan.ts core/src/agents/intake/gherkinGenerator.ts core/src/agents/intake/gherkinGenerator.test.ts core/src/agents/intake/writeFeatureFile.ts core/src/agents/intake/writeFeatureFile.test.ts core/src/agents/generador/parseFeatureHeader.ts core/src/agents/generador/parseFeatureHeader.test.ts
git commit -m "feat(core): round-trip matched pattern name through the .feature file"
```

---

## Task 2: Remove pattern-saving from Agente 1

**Files:**
- Modify: `core/src/agents/intake/runIntake.ts`
- Modify: `core/src/agents/intake/runIntake.test.ts`
- Modify: `cli/src/prompts/types.ts`
- Modify: `cli/src/prompts/inquirerPrompts.ts`
- Modify: `cli/src/commands/chat.ts`
- Modify: `cli/src/commands/chat.test.ts`
- Modify: `cli/src/commands/chat.e2e.test.ts`

**Interfaces:**
- Produces: `IntakeCallbacks { askUser, presentForApproval, confirmOverwrite }` (removes `offerSavePattern`), `ChatPrompts` without `offerSavePattern`

- [ ] **Step 1: Update the tests first**

Replace `core/src/agents/intake/runIntake.test.ts` in full:

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

  it("happy path: no ambiguity, matches a pattern, approved on first try", async () => {
    const llm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);

    const callbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
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
    expect(plan.matchedPatternName).toBe("login");
    expect(callbacks.askUser).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf-8")).toContain(plan.featureText);
  });

  it("ambiguous + no match: asks clarifying questions and loops on rejection", async () => {
    // Note: no scripted response for pattern matching here — matchPattern (Task 12)
    // short-circuits with zero LLM calls when the patterns list is empty (see
    // matcher.test.ts: "returns null without calling the model when there are no
    // patterns"), so only 3 LLM calls actually happen: ambiguity check, initial
    // generation, and regeneration after rejection feedback.
    const llm = new FakeLLMProvider([
      '{"ambiguous": true, "questions": ["¿Qué navegador?"]}',
      "Feature: Caso custom\n  Scenario: x\n    Given a\n",
      "Feature: Caso custom v2\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);

    const callbacks: IntakeCallbacks = {
      askUser: vi.fn().mockResolvedValue("Chrome"),
      presentForApproval: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, feedback: "añade el resultado esperado" })
        .mockResolvedValueOnce({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
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
    expect(plan.matchedPatternName).toBeNull();
    expect(await fs.readFile(filePath, "utf-8")).toBe(plan.featureText);

    // The regeneration call (after rejection) must show the model the previous
    // plan's featureText alongside the feedback, so it can apply the requested
    // change relative to something concrete instead of regenerating blind.
    // receivedCalls[0] = ambiguity check, [1] = initial generation,
    // [2] = regeneration after rejection (matchPattern makes no LLM call here
    // since patterns is empty).
    const firstPlanText = "Feature: Caso custom\n  Scenario: x\n    Given a\n";
    const regenerationMessages = llm.receivedCalls[2];
    const regenerationPrompt = regenerationMessages[regenerationMessages.length - 1].content;
    expect(regenerationPrompt).toContain(firstPlanText);
    expect(regenerationPrompt).toContain("añade el resultado esperado");
  });

  it("asks for confirmation before overwriting an existing feature file, and honors the answer", async () => {
    // First run: creates tests/features/login.feature from scratch.
    const firstRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const firstRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };
    const { plan: firstPlan, filePath } = await runIntake(
      "quiero probar el login",
      firstRunLlm,
      [loginPattern],
      tmpProject,
      "tests",
      firstRunCallbacks
    );
    expect(firstRunCallbacks.confirmOverwrite).not.toHaveBeenCalled();
    const originalContent = await fs.readFile(filePath, "utf-8");
    expect(originalContent).toContain(firstPlan.featureText);

    // Second run against the same project/filename, with confirmOverwrite -> false:
    // must reject and leave the original file untouched (the reproduction from the review).
    const rejectRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: y\n    Given a2\n    When b2\n    Then c2\n",
    ]);
    const confirmOverwriteReject = vi.fn().mockResolvedValue(false);
    const rejectRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: confirmOverwriteReject,
    };
    await expect(
      runIntake(
        "quiero probar el login otra vez",
        rejectRunLlm,
        [loginPattern],
        tmpProject,
        "tests",
        rejectRunCallbacks
      )
    ).rejects.toThrow(/Cancelado/);
    expect(confirmOverwriteReject).toHaveBeenCalledWith(filePath);
    expect(await fs.readFile(filePath, "utf-8")).toBe(originalContent);

    // Third run, with confirmOverwrite -> true: must succeed and overwrite the file.
    const acceptRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: z\n    Given a3\n    When b3\n    Then c3\n",
    ]);
    const acceptRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };
    const { plan: thirdPlan } = await runIntake(
      "quiero probar el login de nuevo",
      acceptRunLlm,
      [loginPattern],
      tmpProject,
      "tests",
      acceptRunCallbacks
    );
    expect(thirdPlan.featureText).not.toBe(originalContent);
    expect(await fs.readFile(filePath, "utf-8")).toContain(thirdPlan.featureText);
  });
});
```

(Note: assertions changed from `toBe(plan.featureText)` to `toContain(plan.featureText)` where the matched-pattern happy paths are involved, because the written file now has the `# agente-qa:pattern=login\n` header prepended by Task 1 — `toBe` would fail against the header-prefixed content.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/intake/runIntake.test.ts`
Expected: FAIL — `IntakeCallbacks` objects above don't match the current interface shape yet in a way that breaks nothing structurally (TS is structurally typed and extra required `offerSavePattern` in the old interface makes these literals fail to compile), so this fails at typecheck/build, not at assertion time. That's expected — it fails because `offerSavePattern` is still required by the current `runIntake.ts`.

- [ ] **Step 3: Implement**

`core/src/agents/intake/runIntake.ts` (full file):
```ts
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import { checkAmbiguity } from "./ambiguityChecker.js";
import { matchPattern } from "../../patterns/matcher.js";
import { generateGherkin } from "./gherkinGenerator.js";
import { writeFeatureFile, featureFileExists, featureFilePath } from "./writeFeatureFile.js";

export interface IntakeCallbacks {
  askUser(question: string): Promise<string>;
  presentForApproval(plan: GherkinPlan): Promise<{ approved: boolean; feedback?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
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
    text = `${text}\n\nPlan anterior:\n"""\n${plan.featureText}\n"""\n\nCambios solicitados sobre el plan anterior:\n${decision.feedback ?? ""}`;
    plan = await generateGherkin(text, llm, matched);
  }

  const alreadyExists = await featureFileExists(projectRoot, testsDir, plan.fileName);
  if (alreadyExists) {
    const targetPath = featureFilePath(projectRoot, testsDir, plan.fileName);
    const overwrite = await callbacks.confirmOverwrite(targetPath);
    if (!overwrite) {
      throw new Error(`Cancelado: ya existe ${targetPath} y no se sobrescribió.`);
    }
  }

  const filePath = await writeFeatureFile(projectRoot, testsDir, plan);

  return { plan, filePath };
}
```

`cli/src/prompts/types.ts` (full file):
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
  confirmOverwrite(filePath: string): Promise<boolean>;
}
```

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

In `cli/src/prompts/inquirerPrompts.ts`, remove the `offerSavePattern` method from `buildRealChatPrompts` (it will move to `buildRealGeneratorPrompts` in Task 10). Full file after the change:
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
    return password({
      message: `Pega tu API key de ${provider}:`,
      validate: (value) => value.trim().length > 0 || "La API key no puede estar vacía.",
    });
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
    async confirmOverwrite(filePath) {
      return select({
        message: `Ya existe un archivo en ${filePath}. ¿Lo sobrescribo?`,
        choices: [
          { name: "Sí", value: true },
          { name: "No", value: false },
        ],
      });
    },
  };
}
```

Replace `cli/src/commands/chat.test.ts` in full:
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
});
```

Replace `cli/src/commands/chat.e2e.test.ts` in full:
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
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const filePath = await runCreatePlan(prompts, tmpHome, tmpProject);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("Feature: Login");
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/agents/intake/runIntake.test.ts cli/src/commands/chat.test.ts cli/src/commands/chat.e2e.test.ts`
Expected: PASS (3 + 2 + 1 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/intake/runIntake.ts core/src/agents/intake/runIntake.test.ts cli/src/prompts/types.ts cli/src/prompts/inquirerPrompts.ts cli/src/commands/chat.ts cli/src/commands/chat.test.ts cli/src/commands/chat.e2e.test.ts
git commit -m "refactor(core): move pattern-saving out of Agente 1, it now belongs to Agente 2"
```

---

## Task 3: `CodeChecker` interface + `FakeCodeChecker`

**Files:**
- Create: `core/src/codeCheck/codeChecker.ts`
- Create: `core/src/codeCheck/testUtils.ts`
- Test: `core/src/codeCheck/testUtils.test.ts`

**Interfaces:**
- Produces: `CodeFile { path: string; content: string }`, `CodeCheckResult { ok: boolean; errors?: string }`, `CodeChecker { check(files: CodeFile[]): Promise<CodeCheckResult> }`, `FakeCodeChecker` (implements `CodeChecker`, constructed with `CodeCheckResult[]` of scripted results, exposes `receivedCalls: CodeFile[][]`)

- [ ] **Step 1: Write the failing test**

`core/src/codeCheck/testUtils.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FakeCodeChecker } from "./testUtils.js";

describe("FakeCodeChecker", () => {
  it("returns scripted results in order and records the files it was called with", async () => {
    const fake = new FakeCodeChecker([{ ok: false, errors: "boom" }, { ok: true }]);

    const first = await fake.check([{ path: "a.py", content: "x = 1\n" }]);
    expect(first).toEqual({ ok: false, errors: "boom" });

    const second = await fake.check([{ path: "b.py", content: "y = 2\n" }]);
    expect(second).toEqual({ ok: true });

    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0]).toEqual([{ path: "a.py", content: "x = 1\n" }]);
  });

  it("throws when out of scripted results", async () => {
    const fake = new FakeCodeChecker([]);
    await expect(fake.check([{ path: "a.py", content: "x = 1\n" }])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/codeCheck/testUtils.test.ts`
Expected: FAIL (`Cannot find module './testUtils.js'`)

- [ ] **Step 3: Implement**

`core/src/codeCheck/codeChecker.ts`:
```ts
export interface CodeFile {
  path: string;
  content: string;
}

export interface CodeCheckResult {
  ok: boolean;
  errors?: string;
}

export interface CodeChecker {
  check(files: CodeFile[]): Promise<CodeCheckResult>;
}
```

`core/src/codeCheck/testUtils.ts`:
```ts
import type { CodeChecker, CodeFile, CodeCheckResult } from "./codeChecker.js";

export class FakeCodeChecker implements CodeChecker {
  private results: CodeCheckResult[];
  public receivedCalls: CodeFile[][] = [];

  constructor(results: CodeCheckResult[]) {
    this.results = [...results];
  }

  async check(files: CodeFile[]): Promise<CodeCheckResult> {
    this.receivedCalls.push(files);
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("FakeCodeChecker: no hay más resultados programados");
    }
    return next;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/codeCheck/testUtils.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/codeCheck/codeChecker.ts core/src/codeCheck/testUtils.ts core/src/codeCheck/testUtils.test.ts
git commit -m "feat(core): add CodeChecker contract and fake test double"
```

---

## Task 4: Real `CodeChecker` (ruff + py_compile)

**Files:**
- Create: `core/src/codeCheck/realCodeChecker.ts`
- Test: `core/src/codeCheck/realCodeChecker.test.ts`

**Interfaces:**
- Consumes: `CodeChecker`, `CodeFile`, `CodeCheckResult` (Task 3)
- Produces: `MissingCodeToolError`, `createRealCodeChecker(options?: { pythonCommand?: string; ruffCommand?: string }): CodeChecker`, `realCodeChecker: CodeChecker`

- [ ] **Step 1: Write the failing test**

`core/src/codeCheck/realCodeChecker.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRealCodeChecker, realCodeChecker, MissingCodeToolError } from "./realCodeChecker.js";

function commandExists(cmd: string): boolean {
  const result = spawnSync(cmd, ["--version"]);
  return result.error === undefined;
}

const hasPython = commandExists("python");
const hasRuff = commandExists("ruff");

describe("realCodeChecker missing tool handling", () => {
  it("throws MissingCodeToolError when the python command doesn't exist", async () => {
    const checker = createRealCodeChecker({ pythonCommand: "agente-qa-definitely-missing-python" });
    await expect(
      checker.check([{ path: "tests/test_x.py", content: "x = 1\n" }])
    ).rejects.toThrow(MissingCodeToolError);
  });

  it("throws MissingCodeToolError when the ruff command doesn't exist", async () => {
    const checker = createRealCodeChecker({
      pythonCommand: hasPython ? "python" : "python3",
      ruffCommand: "agente-qa-definitely-missing-ruff",
    });
    if (!hasPython) return; // can't isolate the ruff failure without a working python step first
    await expect(
      checker.check([{ path: "tests/test_x.py", content: "x = 1\n" }])
    ).rejects.toThrow(MissingCodeToolError);
  });
});

describe.skipIf(!hasPython || !hasRuff)("realCodeChecker (requires Python + ruff on PATH)", () => {
  it("reports ok:true for valid, clean Python", async () => {
    const result = await realCodeChecker.check([
      { path: "tests/test_ok.py", content: "def test_ok():\n    assert True\n" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("reports ok:false with a syntax error", async () => {
    const result = await realCodeChecker.check([
      { path: "tests/test_bad.py", content: "def test_bad(:\n    pass\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/codeCheck/realCodeChecker.test.ts`
Expected: FAIL (`Cannot find module './realCodeChecker.js'`)

- [ ] **Step 3: Implement**

`core/src/codeCheck/realCodeChecker.ts`:
```ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CodeChecker, CodeFile, CodeCheckResult } from "./codeChecker.js";

export class MissingCodeToolError extends Error {
  constructor(tool: string) {
    super(
      `No se encontró "${tool}" en el sistema. Instala Python y ruff ("pip install ruff") para poder generar tests Playwright.`
    );
    this.name = "MissingCodeToolError";
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
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

async function runOrThrowMissing(
  command: string,
  args: string[],
  cwd: string,
  toolName: string
): Promise<RunResult> {
  try {
    return await runCommand(command, args, cwd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingCodeToolError(toolName);
    }
    throw err;
  }
}

export function createRealCodeChecker(options?: {
  pythonCommand?: string;
  ruffCommand?: string;
}): CodeChecker {
  const pythonCommand = options?.pythonCommand ?? "python";
  const ruffCommand = options?.ruffCommand ?? "ruff";

  return {
    async check(files: CodeFile[]): Promise<CodeCheckResult> {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-codecheck-"));
      try {
        const absolutePaths: string[] = [];
        for (const file of files) {
          const target = path.join(tmpDir, file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.content, "utf-8");
          absolutePaths.push(target);
        }

        const errors: string[] = [];

        const compile = await runOrThrowMissing(
          pythonCommand,
          ["-m", "py_compile", ...absolutePaths],
          tmpDir,
          "python"
        );
        if (compile.code !== 0) {
          errors.push(compile.stderr || compile.stdout);
        }

        const lint = await runOrThrowMissing(ruffCommand, ["check", tmpDir], tmpDir, "ruff");
        if (lint.code !== 0) {
          errors.push(lint.stdout || lint.stderr);
        }

        return errors.length === 0 ? { ok: true } : { ok: false, errors: errors.join("\n\n") };
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

export const realCodeChecker: CodeChecker = createRealCodeChecker();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/codeCheck/realCodeChecker.test.ts`
Expected: PASS. The "missing tool" tests (2) always run and pass regardless of environment. The "requires Python + ruff" tests (2) pass if those tools are on PATH, otherwise they're skipped (not failed) — check the output for `↓ skipped` vs `✓`.

- [ ] **Step 5: Commit**

```bash
git add core/src/codeCheck/realCodeChecker.ts core/src/codeCheck/realCodeChecker.test.ts
git commit -m "feat(core): add real CodeChecker backed by ruff + py_compile"
```

---

## Task 5: Code generation (prompt + `codeGenerator.ts`)

**Files:**
- Create: `core/src/prompts/generador.ts`
- Create: `core/src/agents/generador/codeGenerator.ts`
- Test: `core/src/agents/generador/codeGenerator.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `FakeLLMProvider` (existing), `Pattern` (existing)
- Produces: `codeGenerationPrompt(featureText: string, matchedPattern: { name: string; pageObjectTemplate: string } | null, feedback?: string): string`, `GeneratedFile { path: string; content: string }`, `generateCode(featureText: string, llm: LLMProvider, matchedPattern: Pattern | null, feedback?: string): Promise<GeneratedFile[]>`

- [ ] **Step 1: Write the failing test**

`core/src/agents/generador/codeGenerator.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateCode } from "./codeGenerator.js";
import type { Pattern } from "../../schemas/pattern.js";

const featureText = "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n";

const scriptedResponse = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, given, when, then

scenarios("../features/login.feature")


@given("a")
def a():
    pass
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page
# FILE: conftest.py
import pytest


@pytest.fixture
def page():
    pass
`;

describe("generateCode", () => {
  it("parses the three # FILE: blocks into separate files", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const files = await generateCode(featureText, llm, null);

    expect(files).toHaveLength(3);
    expect(files[0].path).toBe("tests/test_login.py");
    expect(files[0].content).toContain("from pytest_bdd import scenarios");
    expect(files[1].path).toBe("pages/login_page.py");
    expect(files[1].content).toContain("class LoginPage");
    expect(files[2].path).toBe("conftest.py");
    expect(files[2].content).toContain("import pytest");
  });

  it("sends the feature text and pattern skeleton to the model when a pattern matched", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const matchedPattern: Pattern = {
      name: "login",
      description: "Inicio de sesión",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "class LoginPage:\n    pass\n",
    };
    await generateCode(featureText, llm, matchedPattern);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain(featureText);
    expect(userMessage?.content).toContain("class LoginPage:\n    pass");
  });

  it("includes retry feedback in the prompt when provided", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, "SyntaxError: unexpected token");

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("SyntaxError: unexpected token");
  });

  it("throws a clear error when the response has no # FILE: blocks", async () => {
    const llm = new FakeLLMProvider(["esto no tiene el formato esperado"]);
    await expect(generateCode(featureText, llm, null)).rejects.toThrow(/# FILE:/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: FAIL (modules don't exist)

- [ ] **Step 3: Implement**

`core/src/prompts/generador.ts`:
```ts
export function codeGenerationPrompt(
  featureText: string,
  matchedPattern: { name: string; pageObjectTemplate: string } | null,
  feedback?: string
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este esqueleto de Page Object conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos del feature:

"""
${matchedPattern.pageObjectTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el Page Object desde cero.";

  const feedbackSection = feedback
    ? `\n\nEl intento anterior no pasó la verificación de calidad. Corrige exactamente este error antes de responder de nuevo:
"""
${feedback}
"""`
    : "";

  return `Eres un ingeniero de QA experto en Playwright + Python + pytest-bdd + Page Object Model.

Dado este archivo Gherkin ya aprobado:
"""
${featureText}
"""

${patternSection}

Genera EXACTAMENTE tres bloques de código, cada uno empezando por una línea con este formato exacto "# FILE: <ruta>", seguida del contenido completo de ese archivo. No incluyas explicaciones fuera de los bloques ni bloques de código markdown (\`\`\`).

Los tres archivos, en este orden:
1. "tests/test_<nombre>.py" — step definitions pytest-bdd que importan y ejecutan el/los scenario(s) del feature con "from pytest_bdd import scenarios, given, when, then" y "scenarios(...)".
2. "pages/<nombre>_page.py" — clase(s) Page Object en Python (Playwright sync API) para las pantallas involucradas.
3. "conftest.py" — fixtures pytest necesarias (browser, page) usando "playwright.sync_api".${feedbackSection}`;
}
```

`core/src/agents/generador/codeGenerator.ts`:
```ts
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import { codeGenerationPrompt } from "../../prompts/generador.js";

export interface GeneratedFile {
  path: string;
  content: string;
}

function parseGeneratedFiles(raw: string): GeneratedFile[] {
  const cleaned = raw.trim();
  const parts = cleaned.split(/^# FILE: (.+)$/m).slice(1);

  const files: GeneratedFile[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const filePath = parts[i].trim();
    const content = `${parts[i + 1].trim()}\n`;
    files.push({ path: filePath, content });
  }

  if (files.length === 0) {
    throw new Error(
      `La respuesta del modelo no contiene ningún bloque "# FILE: <ruta>": ${cleaned.slice(0, 80)}...`
    );
  }

  return files;
}

export async function generateCode(
  featureText: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null,
  feedback?: string
): Promise<GeneratedFile[]> {
  const raw = await llm.generate([
    {
      role: "system",
      content: "Eres un ingeniero de QA experto en Playwright, Python, pytest-bdd y Page Object Model.",
    },
    { role: "user", content: codeGenerationPrompt(featureText, matchedPattern, feedback) },
  ]);

  return parseGeneratedFiles(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/generador.ts core/src/agents/generador/codeGenerator.ts core/src/agents/generador/codeGenerator.test.ts
git commit -m "feat(core): add code generation prompt and response parser for Agente 2"
```

---

## Task 6: `writeTestFiles.ts`

**Files:**
- Create: `core/src/agents/generador/writeTestFiles.ts`
- Test: `core/src/agents/generador/writeTestFiles.test.ts`

**Interfaces:**
- Consumes: `GeneratedFile` (Task 5)
- Produces: `testFilePath(projectRoot: string, testsDir: string, relativePath: string): string`, `testFileExists(projectRoot: string, testsDir: string, relativePath: string): Promise<boolean>`, `writeTestFiles(projectRoot: string, testsDir: string, files: GeneratedFile[]): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

`core/src/agents/generador/writeTestFiles.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTestFiles, testFileExists, testFilePath } from "./writeTestFiles.js";

describe("writeTestFiles", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-writetests-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("writes each file under <testsDir>/<relative path> and returns the written paths", async () => {
    const written = await writeTestFiles(tmpProject, "tests", [
      { path: "tests/test_login.py", content: "x = 1\n" },
      { path: "pages/login_page.py", content: "y = 2\n" },
    ]);

    expect(written.sort()).toEqual(
      [
        path.join(tmpProject, "tests", "tests", "test_login.py"),
        path.join(tmpProject, "tests", "pages", "login_page.py"),
      ].sort()
    );
    expect(await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")).toBe("x = 1\n");
  });

  it("writes conftest.py when it doesn't exist yet", async () => {
    const written = await writeTestFiles(tmpProject, "tests", [
      { path: "conftest.py", content: "import pytest\n" },
    ]);

    expect(written).toEqual([path.join(tmpProject, "tests", "conftest.py")]);
  });

  it("does not overwrite an existing conftest.py, and doesn't report it as written", async () => {
    const conftestPath = testFilePath(tmpProject, "tests", "conftest.py");
    await fs.mkdir(path.dirname(conftestPath), { recursive: true });
    await fs.writeFile(conftestPath, "# fixtures personalizadas\n", "utf-8");

    const written = await writeTestFiles(tmpProject, "tests", [
      { path: "conftest.py", content: "import pytest\n" },
    ]);

    expect(written).toEqual([]);
    expect(await fs.readFile(conftestPath, "utf-8")).toBe("# fixtures personalizadas\n");
  });

  it("testFileExists reports existence correctly", async () => {
    expect(await testFileExists(tmpProject, "tests", "tests/test_login.py")).toBe(false);
    await writeTestFiles(tmpProject, "tests", [{ path: "tests/test_login.py", content: "x = 1\n" }]);
    expect(await testFileExists(tmpProject, "tests", "tests/test_login.py")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/writeTestFiles.test.ts`
Expected: FAIL (`Cannot find module './writeTestFiles.js'`)

- [ ] **Step 3: Implement**

`core/src/agents/generador/writeTestFiles.ts`:
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GeneratedFile } from "./codeGenerator.js";

export function testFilePath(projectRoot: string, testsDir: string, relativePath: string): string {
  return path.join(projectRoot, testsDir, relativePath);
}

export async function testFileExists(
  projectRoot: string,
  testsDir: string,
  relativePath: string
): Promise<boolean> {
  try {
    await fs.access(testFilePath(projectRoot, testsDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function writeTestFiles(
  projectRoot: string,
  testsDir: string,
  files: GeneratedFile[]
): Promise<string[]> {
  const written: string[] = [];

  for (const file of files) {
    const isSharedConftest = file.path === "conftest.py";
    if (isSharedConftest && (await testFileExists(projectRoot, testsDir, file.path))) {
      continue;
    }

    const targetPath = testFilePath(projectRoot, testsDir, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf-8");
    written.push(targetPath);
  }

  return written;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/writeTestFiles.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/generador/writeTestFiles.ts core/src/agents/generador/writeTestFiles.test.ts
git commit -m "feat(core): write generated test files, skipping an existing conftest.py"
```

---

## Task 7: `listFeatureFiles.ts`

**Files:**
- Create: `core/src/agents/generador/listFeatureFiles.ts`
- Test: `core/src/agents/generador/listFeatureFiles.test.ts`

**Interfaces:**
- Produces: `listFeatureFiles(projectRoot: string, testsDir: string): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

`core/src/agents/generador/listFeatureFiles.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFeatureFiles } from "./listFeatureFiles.js";

describe("listFeatureFiles", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-listfeatures-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("returns an empty array when the features directory doesn't exist", async () => {
    expect(await listFeatureFiles(tmpProject, "tests")).toEqual([]);
  });

  it("lists only .feature files, sorted, ignoring other files", async () => {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "signup.feature"), "Feature: Signup\n", "utf-8");
    await fs.writeFile(path.join(dir, "login.feature"), "Feature: Login\n", "utf-8");
    await fs.writeFile(path.join(dir, "notes.txt"), "not a feature file\n", "utf-8");

    expect(await listFeatureFiles(tmpProject, "tests")).toEqual(["login.feature", "signup.feature"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/listFeatureFiles.test.ts`
Expected: FAIL (`Cannot find module './listFeatureFiles.js'`)

- [ ] **Step 3: Implement**

`core/src/agents/generador/listFeatureFiles.ts`:
```ts
import { promises as fs } from "node:fs";
import path from "node:path";

export async function listFeatureFiles(projectRoot: string, testsDir: string): Promise<string[]> {
  const dir = path.join(projectRoot, testsDir, "features");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((f) => f.endsWith(".feature")).sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/listFeatureFiles.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/generador/listFeatureFiles.ts core/src/agents/generador/listFeatureFiles.test.ts
git commit -m "feat(core): list approved .feature files available to Agente 2"
```

---

## Task 8: `runGenerador.ts` orchestrator

**Files:**
- Create: `core/src/agents/generador/runGenerador.ts`
- Test: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `Pattern`, `CodeChecker`, `FakeCodeChecker` (Task 3), `parseFeatureHeader` (Task 1), `generateCode`, `GeneratedFile` (Task 5), `testFileExists`, `testFilePath`, `writeTestFiles` (Task 6), `saveProjectPattern` (existing)
- Produces: `GeneratorCallbacks { offerSavePattern(featureText: string): Promise<{save,name?,description?}>; confirmOverwrite(filePath: string): Promise<boolean> }`, `runGenerador(featureFilePath, llm, patterns, checker, projectRoot, testsDir, callbacks): Promise<{ writtenPaths: string[] }>`

- [ ] **Step 1: Write the failing test**

`core/src/agents/generador/runGenerador.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { FakeCodeChecker } from "../../codeCheck/testUtils.js";
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
# FILE: conftest.py
import pytest
`;

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
    const callbacks: GeneratorCallbacks = {
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const { writtenPaths } = await runGenerador(
      featureFilePath,
      llm,
      [loginPattern],
      checker,
      tmpProject,
      "tests",
      callbacks
    );

    expect(writtenPaths).toHaveLength(3);
    expect(callbacks.offerSavePattern).not.toHaveBeenCalled();
    expect(
      await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")
    ).toContain("scenarios(");
  });

  it("no matched pattern: offers to save the pattern with the generated Page Object as its template", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const callbacks: GeneratorCallbacks = {
      offerSavePattern: vi.fn().mockResolvedValue({ save: true, name: "checkout", description: "Flujo de compra" }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runGenerador(featureFilePath, llm, [], checker, tmpProject, "tests", callbacks);

    expect(callbacks.offerSavePattern).toHaveBeenCalledWith("Feature: Checkout\n");
    const savedRaw = await fs.readFile(
      path.join(tmpProject, ".agente-qa", "templates", "checkout.json"),
      "utf-8"
    );
    const saved = JSON.parse(savedRaw);
    expect(saved.name).toBe("checkout");
    expect(saved.pageObjectTemplate).toContain("class LoginPage");
  });

  it("retries on checker failure, feeding the error back as feedback, up to 3 corrections", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse, scriptedResponse, scriptedResponse]);
    const checker = new FakeCodeChecker([
      { ok: false, errors: "SyntaxError: line 1" },
      { ok: false, errors: "SyntaxError: line 2" },
      { ok: true },
    ]);
    const callbacks: GeneratorCallbacks = {
      offerSavePattern: vi.fn().mockResolvedValue({ save: false }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runGenerador(featureFilePath, llm, [], checker, tmpProject, "tests", callbacks);

    expect(checker.receivedCalls).toHaveLength(3);
    const secondAttemptPrompt = llm.receivedCalls[1].find((m) => m.role === "user")?.content;
    expect(secondAttemptPrompt).toContain("SyntaxError: line 1");
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
    const callbacks: GeneratorCallbacks = {
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };

    await expect(
      runGenerador(featureFilePath, llm, [], checker, tmpProject, "tests", callbacks)
    ).rejects.toThrow(/4 intentos/);

    expect(callbacks.offerSavePattern).not.toHaveBeenCalled();
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
    const callbacks: GeneratorCallbacks = {
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn().mockResolvedValue(false),
    };

    await expect(
      runGenerador(featureFilePath, llm, [loginPattern], checker, tmpProject, "tests", callbacks)
    ).rejects.toThrow(/Cancelado/);

    expect(await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")).toBe(
      "# ya existente\n"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL (`Cannot find module './runGenerador.js'`)

- [ ] **Step 3: Implement**

`core/src/agents/generador/runGenerador.ts`:
```ts
import { promises as fs } from "node:fs";
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { CodeChecker } from "../../codeCheck/codeChecker.js";
import { saveProjectPattern } from "../../patterns/registry.js";
import { parseFeatureHeader } from "./parseFeatureHeader.js";
import { generateCode, type GeneratedFile } from "./codeGenerator.js";
import { testFileExists, testFilePath, writeTestFiles } from "./writeTestFiles.js";

const MAX_ATTEMPTS = 4; // 1 initial generation + up to 3 corrections

export interface GeneratorCallbacks {
  offerSavePattern(featureText: string): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}

export async function runGenerador(
  featureFilePath: string,
  llm: LLMProvider,
  patterns: Pattern[],
  checker: CodeChecker,
  projectRoot: string,
  testsDir: string,
  callbacks: GeneratorCallbacks
): Promise<{ writtenPaths: string[] }> {
  const featureText = await fs.readFile(featureFilePath, "utf-8");
  const matchedPatternName = parseFeatureHeader(featureText);
  const matchedPattern = matchedPatternName
    ? (patterns.find((p) => p.name === matchedPatternName) ?? null)
    : null;

  let feedback: string | undefined;
  let files: GeneratedFile[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    files = await generateCode(featureText, llm, matchedPattern, feedback);
    const result = await checker.check(files);
    if (result.ok) {
      feedback = undefined;
      break;
    }

    const errors = result.errors ?? "Error desconocido de verificación de código.";
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`El código generado no pasó la verificación tras ${MAX_ATTEMPTS} intentos. Último error:\n${errors}`);
    }
    feedback = errors;
  }

  for (const file of files) {
    if (file.path === "conftest.py") continue;
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/generador/runGenerador.ts core/src/agents/generador/runGenerador.test.ts
git commit -m "feat(core): add Agente 2 orchestrator with self-correction loop"
```

---

## Task 9: Export the new public surface from `core`

**Files:**
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-8
- Produces: barrel exports

- [ ] **Step 1: Write the failing test**

Append this `it` block inside the existing `describe("@agente-qa/core public API", ...)` in `core/src/index.test.ts` (the file currently ends after the `"exports the intake orchestrator"` test — add this as the next block, right after it, before the closing `});`):

```ts
  it("exports the Agente 2 (generador) surface", () => {
    expect(typeof core.parseFeatureHeader).toBe("function");
    expect(typeof core.generateCode).toBe("function");
    expect(typeof core.writeTestFiles).toBe("function");
    expect(typeof core.testFileExists).toBe("function");
    expect(typeof core.testFilePath).toBe("function");
    expect(typeof core.listFeatureFiles).toBe("function");
    expect(typeof core.runGenerador).toBe("function");
    expect(typeof core.FakeCodeChecker).toBe("function");
    expect(typeof core.createRealCodeChecker).toBe("function");
    expect(typeof core.realCodeChecker.check).toBe("function");
    expect(typeof core.MissingCodeToolError).toBe("function");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/index.test.ts`
Expected: FAIL (new exports don't exist on `core` yet — `core.parseFeatureHeader` etc. are `undefined`)

- [ ] **Step 3: Implement**

Append to `core/src/index.ts`:
```ts
export { parseFeatureHeader } from "./agents/generador/parseFeatureHeader.js";
export { generateCode } from "./agents/generador/codeGenerator.js";
export type { GeneratedFile } from "./agents/generador/codeGenerator.js";
export { writeTestFiles, testFileExists, testFilePath } from "./agents/generador/writeTestFiles.js";
export { listFeatureFiles } from "./agents/generador/listFeatureFiles.js";
export { runGenerador } from "./agents/generador/runGenerador.js";
export type { GeneratorCallbacks } from "./agents/generador/runGenerador.js";

export type { CodeFile, CodeCheckResult, CodeChecker } from "./codeCheck/codeChecker.js";
export { FakeCodeChecker } from "./codeCheck/testUtils.js";
export { createRealCodeChecker, realCodeChecker, MissingCodeToolError } from "./codeCheck/realCodeChecker.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/index.ts core/src/index.test.ts
git commit -m "feat(core): export Agente 2 public surface from the barrel"
```

---

## Task 10: CLI prompts for Agente 2

**Files:**
- Modify: `cli/src/prompts/types.ts`
- Modify: `cli/src/prompts/inquirerPrompts.ts`

**Interfaces:**
- Consumes: `GeneratorCallbacks` shape (Task 8)
- Produces: `GeneratorPrompts { selectFeatureFile(files: string[]): Promise<string>; offerSavePattern(): Promise<{save,name?,description?}>; confirmOverwrite(filePath: string): Promise<boolean> }`, `buildRealGeneratorPrompts(): GeneratorPrompts`

- [ ] **Step 1: Write the failing test**

There's no existing test file for `inquirerPrompts.ts` (it's the real-terminal implementation, exercised indirectly through e2e/command tests, not unit-tested directly — consistent with how `buildRealChatPrompts` has no dedicated test today). Skip straight to implementing; Task 12's e2e test is what exercises this code for real.

- [ ] **Step 2: N/A**

- [ ] **Step 3: Implement**

Add to `cli/src/prompts/types.ts` (append, keep everything else in the file as-is):
```ts
export interface GeneratorPrompts {
  selectFeatureFile(files: string[]): Promise<string>;
  offerSavePattern(): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}
```

Add to `cli/src/prompts/inquirerPrompts.ts` (append at the end of the file, and add `GeneratorPrompts` to the existing `import type { ... } from "./types.js"` line):
```ts
export function buildRealGeneratorPrompts(): GeneratorPrompts {
  return {
    async selectFeatureFile(files) {
      if (files.length === 1) return files[0];
      return select({
        message: "¿Qué plan de pruebas (.feature) quieres convertir en tests?",
        choices: files.map((f) => ({ name: f, value: f })),
      });
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
    async confirmOverwrite(filePath) {
      return select({
        message: `Ya existe un archivo en ${filePath}. ¿Lo sobrescribo?`,
        choices: [
          { name: "Sí", value: true },
          { name: "No", value: false },
        ],
      });
    },
  };
}
```

- [ ] **Step 4: N/A (verified by Task 12's e2e test)**

- [ ] **Step 5: Commit**

```bash
git add cli/src/prompts/types.ts cli/src/prompts/inquirerPrompts.ts
git commit -m "feat(cli): add real terminal prompts for Agente 2"
```

---

## Task 11: `cli/src/commands/generate.ts`

**Files:**
- Create: `cli/src/commands/generate.ts`
- Test: `cli/src/commands/generate.test.ts`

**Interfaces:**
- Consumes: `loadCredentials`, `loadProjectConfig`, `loadAllPatterns`, `createProvider`, `realCodeChecker`, `listFeatureFiles`, `runGenerador`, `GeneratorCallbacks` (all from `@agente-qa/core`), `GeneratorPrompts` (Task 10)
- Produces: `runGenerateTests(prompts: GeneratorPrompts, homeDir: string, projectRoot: string): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

`cli/src/commands/generate.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, saveProjectConfig, FakeLLMProvider, FakeCodeChecker } from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";

const createProviderMock = vi.fn();
const realCodeCheckerCheckMock = vi.fn();

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
    realCodeChecker: { check: (...args: unknown[]) => realCodeCheckerCheckMock(...args) },
  };
});

import { runGenerateTests } from "./generate.js";

describe("runGenerateTests", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-generate-home-"));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-generate-project-"));
    createProviderMock.mockReset();
    realCodeCheckerCheckMock.mockReset();
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
# FILE: conftest.py
import pytest
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
    expect(writtenPaths).toHaveLength(3);
    expect(
      await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")
    ).toContain("scenarios(");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: FAIL (`Cannot find module './generate.js'`)

- [ ] **Step 3: Implement**

`cli/src/commands/generate.ts`:
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

  const llm = createProvider(credentials);
  const patterns = await loadAllPatterns(projectRoot);

  const callbacks: GeneratorCallbacks = {
    offerSavePattern: () => prompts.offerSavePattern(),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
  };

  const { writtenPaths } = await runGenerador(
    featureFilePath,
    llm,
    patterns,
    realCodeChecker,
    projectRoot,
    projectConfig.testsDir,
    callbacks
  );

  return writtenPaths;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/generate.ts cli/src/commands/generate.test.ts
git commit -m "feat(cli): add runGenerateTests command wiring"
```

---

## Task 12: Wire the menu + end-to-end test

**Files:**
- Modify: `cli/src/menu.ts`
- Modify: `cli/src/menu.test.ts`
- Modify: `cli/bin/agente-qa.ts`
- Create: `cli/src/commands/generate.e2e.test.ts`

**Interfaces:**
- Consumes: `runGenerateTests` (Task 11), `buildRealGeneratorPrompts` (Task 10)

- [ ] **Step 1: Write the failing tests**

Modify `cli/src/menu.ts`'s test file, `cli/src/menu.test.ts`: replace the `vi.mock` block and the last two tests. Full file:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runCreatePlanMock = vi.fn();
const runInitMock = vi.fn();
const runGenerateTestsMock = vi.fn();

vi.mock("./commands/chat.js", () => ({
  runCreatePlan: (...args: unknown[]) => runCreatePlanMock(...args),
}));
vi.mock("./commands/init.js", () => ({
  runInit: (...args: unknown[]) => runInitMock(...args),
}));
vi.mock("./commands/generate.js", () => ({
  runGenerateTests: (...args: unknown[]) => runGenerateTestsMock(...args),
}));

import { runMenuLoop } from "./menu.js";
import type { MenuChoice } from "./prompts/types.js";

describe("runMenuLoop", () => {
  beforeEach(() => {
    runCreatePlanMock.mockReset();
    runInitMock.mockReset();
    runGenerateTestsMock.mockReset();
  });

  it("routes 'create-plan' to runCreatePlan and exits on 'exit'", async () => {
    const choices: MenuChoice[] = ["create-plan", "exit"];
    let i = 0;
    runCreatePlanMock.mockResolvedValue("/tmp/tests/features/login.feature");

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runCreatePlanMock).toHaveBeenCalledTimes(1);
  });

  it("catches errors from runCreatePlan, prints them, and returns to the next menu prompt", async () => {
    const choices: MenuChoice[] = ["create-plan", "exit"];
    let i = 0;
    runCreatePlanMock.mockRejectedValue(
      new Error("No hay credenciales configuradas. Ejecuta 'agente-qa init' primero.")
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error: No hay credenciales configuradas")
    );
    expect(i).toBe(2);

    logSpy.mockRestore();
  });

  it("routes 'config' to runInit", async () => {
    const choices: MenuChoice[] = ["config", "exit"];
    let i = 0;

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runInitMock).toHaveBeenCalledTimes(1);
  });

  it("routes 'generate-tests' to runGenerateTests", async () => {
    const choices: MenuChoice[] = ["generate-tests", "exit"];
    let i = 0;
    runGenerateTestsMock.mockResolvedValue(["/tmp/tests/tests/test_login.py"]);

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runGenerateTestsMock).toHaveBeenCalledTimes(1);
  });

  it("loops through remaining unimplemented choices before exiting", async () => {
    const choices: MenuChoice[] = ["run-tests", "reports", "exit"];
    let i = 0;

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(i).toBe(3);
    expect(runCreatePlanMock).not.toHaveBeenCalled();
    expect(runInitMock).not.toHaveBeenCalled();
    expect(runGenerateTestsMock).not.toHaveBeenCalled();
  });
});
```

Create `cli/src/commands/generate.e2e.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { saveCredentials, saveProjectConfig } from "@agente-qa/core";

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

import { runGenerateTests } from "./generate.js";
import type { GeneratorPrompts } from "../prompts/types.js";

describe.skipIf(!hasPython || !hasRuff)(
  "end-to-end: generate tests via the real wiring, only the network call mocked",
  () => {
    let tmpHome: string;
    let tmpProject: string;

    beforeEach(async () => {
      tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-gen-e2e-home-"));
      tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-gen-e2e-project-"));
      await saveCredentials({ provider: "anthropic", apiKey: "sk-test" }, tmpHome);
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
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpProject, { recursive: true, force: true });
    });

    it("generates and writes tests/pages/conftest.py for the built-in login pattern", async () => {
      generateTextMock.mockResolvedValueOnce({
        text: `# FILE: tests/test_login.py
from pytest_bdd import scenarios

scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page
# FILE: conftest.py
import pytest


@pytest.fixture
def base_url():
    return "http://localhost:3000"
`,
      });

      const prompts: GeneratorPrompts = {
        selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
        offerSavePattern: vi.fn(),
        confirmOverwrite: vi.fn().mockResolvedValue(true),
      };

      const writtenPaths = await runGenerateTests(prompts, tmpHome, tmpProject);

      expect(writtenPaths).toHaveLength(3);
      expect(prompts.offerSavePattern).not.toHaveBeenCalled();
    });
  }
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run cli/src/menu.test.ts cli/src/commands/generate.e2e.test.ts`
Expected: FAIL — `menu.test.ts` fails because `menu.ts` doesn't accept `generatorPrompts` yet and doesn't route `generate-tests`; `generate.e2e.test.ts` fails or is skipped depending on whether Python/ruff are on PATH (if skipped, that's not a failure — check for `Cannot find module` type failures instead, there should be none once Task 11 is done).

- [ ] **Step 3: Implement**

`cli/src/menu.ts` (full file):
```ts
import type { MenuPrompts, ChatPrompts, InitPrompts, GeneratorPrompts } from "./prompts/types.js";
import { runCreatePlan } from "./commands/chat.js";
import { runInit } from "./commands/init.js";
import { runGenerateTests } from "./commands/generate.js";

export interface MenuDeps {
  menuPrompts: MenuPrompts;
  chatPrompts: ChatPrompts;
  initPrompts: InitPrompts;
  generatorPrompts: GeneratorPrompts;
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
        try {
          const filePath = await runCreatePlan(deps.chatPrompts, deps.homeDir, deps.projectRoot);
          console.log(`Plan guardado en ${filePath}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "generate-tests": {
        try {
          const writtenPaths = await runGenerateTests(deps.generatorPrompts, deps.homeDir, deps.projectRoot);
          console.log(`Tests generados:\n${writtenPaths.join("\n")}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "config": {
        try {
          await runInit(deps.initPrompts, deps.homeDir, deps.projectRoot);
          console.log("Configuración actualizada.");
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
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

In `cli/bin/agente-qa.ts`, add the `buildRealGeneratorPrompts` import and pass `generatorPrompts` into the `chat` command's `runMenuLoop` call:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import os from "node:os";
import { runInit } from "../src/commands/init.js";
import { runMenuLoop } from "../src/menu.js";
import {
  realInitPrompts,
  realMenuPrompts,
  buildRealChatPrompts,
  buildRealGeneratorPrompts,
} from "../src/prompts/inquirerPrompts.js";

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
      generatorPrompts: buildRealGeneratorPrompts(),
      homeDir: os.homedir(),
      projectRoot: process.cwd(),
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run cli/src/menu.test.ts cli/src/commands/generate.e2e.test.ts`
Expected: PASS (5 tests in `menu.test.ts`; `generate.e2e.test.ts`'s 1 test passes if Python+ruff are on PATH, otherwise shows as skipped)

Then run the full suite to catch any cross-file regressions:
Run: `npx vitest run`
Expected: PASS (all tests, some possibly skipped)

And typecheck both packages:
Run: `npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: no errors (note: `cli`'s `tsc` needs `core/dist/` built first — run `npm run build --workspace=core` beforehand if this fails on module resolution, per the project's existing note about this).

- [ ] **Step 5: Commit**

```bash
git add cli/src/menu.ts cli/src/menu.test.ts cli/bin/agente-qa.ts cli/src/commands/generate.e2e.test.ts
git commit -m "feat(cli): wire 'generate-tests' menu option to Agente 2 end to end"
```

---

## Final check

After Task 12, run the full verification sweep before considering the branch done (per this project's "hecho" definition in `CLAUDE.md`):

```bash
npx vitest run
npx tsc -p core/tsconfig.json --noEmit
npx tsc -p cli/tsconfig.json --noEmit
npm run build
```

All four must succeed. Then this plan is ready for the branch-level final review (`superpowers:finishing-a-development-branch`), same as Plan 1 closed out.
