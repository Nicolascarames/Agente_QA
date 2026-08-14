# Verificación en tiempo real de locators generados Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before Agente 2 (Generador) writes any code to disk, verify that every locator built from a runtime-variable argument (`get_by_role(..., name=button_name)`, `get_by_text(message)`, etc.) resolves to exactly one real element on the live application — catching ambiguous-locator bugs that no static analysis (not even today's `.or_()` lint) can see.

**Architecture:** New `core/src/locatorVerify/` module, same DI pattern as `CodeChecker`/`TestRunner`/`SiteExplorer` (interface + `FakeLocatorVerifier` + `realLocatorVerifier`). A pure function (`extractLocatorChecks`) cross-references the approved `.feature` against the LLM-generated step-definitions file to find which literal values flow, unmodified, into which `get_*` Page Object method — including values that only exist inside a `Scenario Outline`'s `Examples` table, and including action methods (`click_*`) that internally delegate to a paired `get_*` method. A second pure function (`buildVerificationScript`) turns that list into a disposable, headless, read-only Python script (`.count()`/`.all()` only — never `.click()`/`.fill()`). `runGenerador`'s existing `MAX_ATTEMPTS = 4` retry loop runs this verification right after `checker.check()` passes, before writing anything, feeding any ambiguity back to the LLM as retry feedback exactly like a lint error today.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Vitest, Python `playwright.sync_api` (headless Chromium, spawned as a one-off script — reuses the same `pytest`/`pytest-bdd`/`pytest-playwright`/`pytest-html` prerequisite Agente 3 already requires, now also required at generate-time).

**Spec:** `docs/superpowers/specs/2026-08-14-locator-runtime-verification-design.md` — read this first for the full problem statement and the real bug (`babia-nav.vercel.app`) that motivated it.

**This plan amends the spec in 3 places**, based on a same-day spike that ran the spec's literal design against real generated code in `Pruebas/tests/` (gitignored local fixture, run against `babia-nav.vercel.app`) and against a synthetic case matching the spec's own example. Findings are recorded in `memory.md`. The amendments:

1. **Unicode-aware identifier matching.** The spec's literal→method regex must use `[\p{L}\p{N}_]+`/`u` flag for parameter names, not `\w+` — Spanish parameter names like `contraseña` don't match `\w` (no `ñ`) and the cross-reference silently fails otherwise. Verified: this broke on the very first real fixture tried.
2. **`Scenario Outline` resolution.** The spec's §2 never mentions `Scenario Outline` — but the quoted literal in an Outline step's text is usually a placeholder (`"<mensaje_error>"`), not the runtime value; the real value lives in the `Examples` table. This is the *majority* case in real generated features (3 of 4 scenarios in the tested fixture), so extraction must resolve placeholders via `Examples`, not treat every quoted string as a literal value.
3. **Visible gap reporting, not silent skipping.** If the LLM introduces any transformation between a step's parameter and the method call that consumes it (renaming, `.strip()`, anything not a bare identifier pass-through) — realistic, unremarkable LLM output — the cross-reference finds nothing and must say so out loud (via a callback), never just omit the check. This is the same "failure only visible in aggregate" pattern already recorded 4 times in `memory.md`; a 5th silent instance is the one risk worth actively guarding against here.

## Global Constraints

- TypeScript strict mode across `core` and `cli`; no `any` in production code.
- Node.js >= 22.
- `core` has no direct terminal I/O — all progress/warning output goes through `GeneratorCallbacks.onVerificationStep`, same principle already applied to `onExplorationStep` (Site Explorer).
- `LocatorVerifier.verify()` is read-only against the real app: only `.count()`/`.all()`, **never** `.click()`/`.fill()`/any action method — this is what makes it safe to call on every one of the 4 retry attempts without accumulating real side effects.
- Verification always launches Chromium **headless**, independent of the project's `headedMode` preference (this is an internal check, not the session the user wants to watch).
- Verification runs strictly AFTER `checker.check()` passes within a given attempt — never spend a real browser launch on code that doesn't even compile/lint.
- Same `MAX_ATTEMPTS = 4` budget shared between code-check retries and locator-verification retries in `runGenerador` — no separate retry loop.
- The full pytest stack (`pytest`, `pytest-bdd`, `pytest-playwright`, `pytest-html`) becomes a prerequisite for "Generar tests Playwright" (Agente 2), not just "Ejecutar tests" (Agente 3) — same preflight check `realTestRunner` already does.
- `extractLocatorChecks` and `buildVerificationScript` are pure functions (no I/O, no browser, no subprocess) — testable with plain string fixtures.
- Executing the full Gherkin scenario as a dry-run stays out of scope (would trigger real logins/emails/lockouts on every retry) — this is why verification only reaches locators visible from the initial `goto(baseUrl)`, not screens reachable only after an action (spec, "Riesgos técnicos" / "Fuera de alcance").
- Credential redaction (the pattern behind the Site Explorer's `redactLiteralCredentials`) was considered and **deliberately not applied here**: this harness never fills a form or performs a login, so no credential value can flow into its output the way it does for the Site Explorer's evidence capture. Revisit only if a future version drives the harness through an action (see spec's "Riesgos técnicos" on post-login screens).

---

## File Structure

```
core/
  src/
    locatorVerify/
      locatorVerifier.ts                 # NEW: LocatorCheck, LocatorVerificationResult, LocatorVerifier
      testUtils.ts                       # NEW: FakeLocatorVerifier
      testUtils.test.ts                  # NEW
      extractLocatorChecks.ts            # NEW: pure literal->method cross-reference
      extractLocatorChecks.test.ts       # NEW
      buildVerificationScript.ts         # NEW: builds the one-off Python verification script
      buildVerificationScript.test.ts    # NEW
      realLocatorVerifier.ts             # NEW: createRealLocatorVerifier, MissingLocatorVerifierToolError
      realLocatorVerifier.test.ts        # NEW (gated real-browser test + missing-tool handling)
    prompts/
      generador.ts                       # MODIFY: get_*/act_* split + bare-identifier passthrough instructions
    agents/generador/
      codeGenerator.test.ts              # MODIFY: 2 new prompt-content assertions
      runGenerador.ts                    # MODIFY: wires extractLocatorChecks + verifier into the retry loop
      runGenerador.test.ts               # MODIFY: + verifier field on 15 existing calls, + 4 new tests
    index.ts                             # MODIFY: barrel exports
    index.test.ts                        # MODIFY
cli/
  src/
    util/
      spinner.ts                         # MODIFY: + withLocatorVerifierSpinner
    commands/
      generate.ts                        # MODIFY: wires createRealLocatorVerifier + onVerificationStep
      generate.test.ts                   # MODIFY: + verifier wiring assertions
README.md                                # MODIFY: pytest stack now required at generate-time too
```

---

## Task 1: `LocatorVerifier` contract — interfaces + `FakeLocatorVerifier`

**Files:**
- Create: `core/src/locatorVerify/locatorVerifier.ts`
- Create: `core/src/locatorVerify/testUtils.ts`
- Test: `core/src/locatorVerify/testUtils.test.ts`

**Interfaces:**
- Produces: `LocatorCheck { method: string; argument: string }`, `LocatorVerificationResult { ok: boolean; errors?: string }`, `LocatorVerifier { verify(files, checks, baseUrl, credentials): Promise<LocatorVerificationResult> }`, `FakeLocatorVerifier` (scripted results, `receivedCalls`).

- [ ] **Step 1: Write the failing test**

`core/src/locatorVerify/testUtils.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FakeLocatorVerifier } from "./testUtils.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

const files: GeneratedFile[] = [
  { path: "tests/test_login.py", content: "" },
  { path: "pages/login_page.py", content: "" },
];

describe("FakeLocatorVerifier", () => {
  it("returns scripted results in order and records every call it received", async () => {
    const fake = new FakeLocatorVerifier([
      { ok: true },
      { ok: false, errors: "resolvió a 2 elementos" },
    ]);

    const first = await fake.verify(files, [{ method: "get_button", argument: "Log In" }], "https://a.com", undefined);
    expect(first).toEqual({ ok: true });

    const second = await fake.verify(files, [], "https://b.com", { username: "u", password: "p" });
    expect(second).toEqual({ ok: false, errors: "resolvió a 2 elementos" });

    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0].baseUrl).toBe("https://a.com");
    expect(fake.receivedCalls[0].checks).toEqual([{ method: "get_button", argument: "Log In" }]);
    expect(fake.receivedCalls[1].credentials).toEqual({ username: "u", password: "p" });
  });

  it("throws when out of scripted results", async () => {
    const fake = new FakeLocatorVerifier([]);
    await expect(fake.verify(files, [], "https://a.com", undefined)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/testUtils.test.ts`
Expected: FAIL (`Cannot find module './testUtils.js'`)

- [ ] **Step 3: Implement**

`core/src/locatorVerify/locatorVerifier.ts`:
```ts
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { ExplorationCredentials } from "../siteExplorer/siteExplorer.js";

export interface LocatorCheck {
  method: string;
  argument: string;
}

export interface LocatorVerificationResult {
  ok: boolean;
  errors?: string;
}

export interface LocatorVerifier {
  verify(
    files: GeneratedFile[],
    checks: LocatorCheck[],
    baseUrl: string,
    credentials: ExplorationCredentials | undefined
  ): Promise<LocatorVerificationResult>;
}
```

`core/src/locatorVerify/testUtils.ts`:
```ts
import type { LocatorVerifier, LocatorCheck, LocatorVerificationResult } from "./locatorVerifier.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { ExplorationCredentials } from "../siteExplorer/siteExplorer.js";

export interface FakeLocatorVerifierCall {
  files: GeneratedFile[];
  checks: LocatorCheck[];
  baseUrl: string;
  credentials: ExplorationCredentials | undefined;
}

export class FakeLocatorVerifier implements LocatorVerifier {
  private results: LocatorVerificationResult[];
  public receivedCalls: FakeLocatorVerifierCall[] = [];

  constructor(results: LocatorVerificationResult[]) {
    this.results = [...results];
  }

  async verify(
    files: GeneratedFile[],
    checks: LocatorCheck[],
    baseUrl: string,
    credentials: ExplorationCredentials | undefined
  ): Promise<LocatorVerificationResult> {
    this.receivedCalls.push({ files, checks, baseUrl, credentials });
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("FakeLocatorVerifier: no hay más resultados programados");
    }
    return next;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/locatorVerify/testUtils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/locatorVerifier.ts core/src/locatorVerify/testUtils.ts core/src/locatorVerify/testUtils.test.ts
git commit -m "feat(core): add LocatorVerifier contract and FakeLocatorVerifier test double"
```

---

## Task 2: `extractLocatorChecks` — direct `get_*` literal mapping (unicode-aware)

**Files:**
- Create: `core/src/locatorVerify/extractLocatorChecks.ts`
- Test: `core/src/locatorVerify/extractLocatorChecks.test.ts`

**Interfaces:**
- Consumes: `LocatorCheck` from `./locatorVerifier.js`; `GeneratedFile` from `../agents/generador/codeGenerator.js`.
- Produces: `LocatorExtractionResult { checks: LocatorCheck[]; skipped: string[] }`, `extractLocatorChecks(featureText: string, files: GeneratedFile[]): LocatorExtractionResult`.

This task handles the direct case only: a `Then`/`When` step whose quoted literal flows, unmodified, straight into a `get_*` Page Object method (the real pattern found in `Pruebas/tests/pages/inicio_de_sesion_page.py`'s `get_error_message`/`get_validation_message`). No `Scenario Outline` yet (Task 3), no action-method delegation yet (Task 4).

- [ ] **Step 1: Write the failing test**

`core/src/locatorVerify/extractLocatorChecks.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractLocatorChecks } from "./extractLocatorChecks.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

function files(stepDefsContent: string, pageObjectContent: string): GeneratedFile[] {
  return [
    { path: "tests/test_login.py", content: stepDefsContent },
    { path: "pages/login_page.py", content: pageObjectContent },
  ];
}

describe("extractLocatorChecks — direct get_* mapping", () => {
  it("maps a literal that flows unmodified into a get_* method to a LocatorCheck", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: fail",
      "    When introduzco el correo electrónico \"x\"",
      '    Then debo ver un mensaje de error "Correo o contraseña incorrectos"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([
      { method: "get_error_message", argument: "Correo o contraseña incorrectos" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("handles unicode parameter names (ñ, tildes) that a plain \\w regex would miss", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: fail",
      '    Then debo ver el mensaje de validación "La contraseña es obligatoria"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver el mensaje de validación "{mensaje_validacion}"'))
def verificar_mensaje_validacion(page, mensaje_validacion):
    login_page = LoginPage(page)
    login_page.get_validation_message(mensaje_validacion)
`;
    const pageObject = `class LoginPage:
    def get_validation_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([
      { method: "get_validation_message", argument: "La contraseña es obligatoria" },
    ]);
  });

  it("produces no checks for a step whose literal flows into a plain action method (fill_*), not a get_* method", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When introduzco el correo electrónico "usuario@ejemplo.com"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('introduzco el correo electrónico "{correo}"'))
def introducir_correo(page, correo):
    login_page = LoginPage(page)
    login_page.fill_email(correo)
`;
    const pageObject = `class LoginPage:
    def fill_email(self, email):
        self.email_input.fill(email)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("returns no checks when the two expected files aren't present", () => {
    const result = extractLocatorChecks("Feature: X\n", [{ path: "weird.py", content: "" }]);
    expect(result).toEqual({ checks: [], skipped: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/extractLocatorChecks.test.ts`
Expected: FAIL (`Cannot find module './extractLocatorChecks.js'`)

- [ ] **Step 3: Implement**

`core/src/locatorVerify/extractLocatorChecks.ts`:
```ts
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { LocatorCheck } from "./locatorVerifier.js";

export interface LocatorExtractionResult {
  checks: LocatorCheck[];
  skipped: string[];
}

interface FeatureStep {
  text: string;
  outlineExamples: Record<string, string>[] | null;
}

function parseFeatureSteps(featureText: string): FeatureStep[] {
  const steps: FeatureStep[] = [];
  for (const rawLine of featureText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(?:Given|When|Then|And|But)\s+(.*)$/);
    if (match) {
      steps.push({ text: match[1], outlineExamples: null });
    }
  }
  return steps;
}

interface ParsedStepDef {
  template: string;
  isDynamic: boolean;
  body: string;
}

const STEP_DEF_PATTERN =
  /@(?:given|when|then)\(\s*(?:parsers\.parse\(\s*(['"])([\s\S]*?)\1\s*\)|(['"])([\s\S]*?)\3)\s*\)\s*\r?\ndef\s+[\p{L}\p{N}_]+\([^)]*\):\s*\r?\n((?:[ \t]+.*\r?\n?)*)/gu;

function parseStepDefs(stepDefsSrc: string): ParsedStepDef[] {
  const defs: ParsedStepDef[] = [];
  for (const m of stepDefsSrc.matchAll(STEP_DEF_PATTERN)) {
    const [, , parseTemplate, , plainTemplate, body] = m;
    const template = parseTemplate ?? plainTemplate;
    defs.push({ template, isDynamic: parseTemplate !== undefined, body });
  }
  return defs;
}

function templateToRegex(template: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let pattern = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Parameter names can contain unicode letters (Spanish feature text: "contraseña",
  // "categoría") — a plain \w class silently fails to match them.
  pattern = pattern.replace(/\\\{([\p{L}\p{N}_]+)\\\}/gu, (_, name: string) => {
    paramNames.push(name);
    return "(.*?)";
  });
  return { regex: new RegExp(`^${pattern}$`, "u"), paramNames };
}

function findMethodCallForParam(body: string, paramName: string): string | null {
  for (const call of body.matchAll(/[\p{L}\p{N}_]+\.([\p{L}\p{N}_]+)\(([^)]*)\)/gu)) {
    const [, method, argsStr] = call;
    const args = argsStr.split(",").map((a) => a.trim());
    if (args.includes(paramName)) return method;
  }
  return null;
}

export function extractLocatorChecks(featureText: string, files: GeneratedFile[]): LocatorExtractionResult {
  const stepDefsFile = files.find((f) => f.path.startsWith("tests/"));
  const pageObjectFile = files.find((f) => f.path.startsWith("pages/"));
  const checks: LocatorCheck[] = [];
  const skipped: string[] = [];

  if (!stepDefsFile || !pageObjectFile) {
    return { checks, skipped };
  }

  const steps = parseFeatureSteps(featureText);
  const dynamicStepDefs = parseStepDefs(stepDefsFile.content).filter((d) => d.isDynamic);

  for (const step of steps) {
    let matchedDef: ParsedStepDef | null = null;
    let params: Record<string, string> = {};

    for (const def of dynamicStepDefs) {
      const { regex, paramNames } = templateToRegex(def.template);
      const match = step.text.match(regex);
      if (match) {
        matchedDef = def;
        paramNames.forEach((name, i) => (params[name] = match[i + 1]));
        break;
      }
    }
    if (!matchedDef) continue;

    for (const [paramName, rawValue] of Object.entries(params)) {
      const calledMethod = findMethodCallForParam(matchedDef.body, paramName);
      if (!calledMethod || !calledMethod.startsWith("get_")) continue;

      checks.push({ method: calledMethod, argument: rawValue });
    }
  }

  return { checks, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/locatorVerify/extractLocatorChecks.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/extractLocatorChecks.ts core/src/locatorVerify/extractLocatorChecks.test.ts
git commit -m "feat(core): extract locator checks from feature literals mapped to get_* methods"
```

---

## Task 3: `extractLocatorChecks` — `Scenario Outline` / `Examples` resolution

**Files:**
- Modify: `core/src/locatorVerify/extractLocatorChecks.ts`
- Test: `core/src/locatorVerify/extractLocatorChecks.test.ts`

**Interfaces:**
- No signature change — `extractLocatorChecks` keeps consuming/producing exactly what Task 2 defined.

This is the amendment the spec was missing entirely: in a `Scenario Outline`, the literal in the step text is a placeholder (`"<mensaje_error>"`); the real runtime values live in the `Examples` table, one `LocatorCheck` per row.

- [ ] **Step 1: Write the failing test**

Add to `core/src/locatorVerify/extractLocatorChecks.test.ts` (new `describe` block):
```ts
describe("extractLocatorChecks — Scenario Outline resolution", () => {
  it("resolves an Outline placeholder to one LocatorCheck per Examples row", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario Outline: fallos",
      '    When introduzco el correo electrónico "<correo>"',
      '    Then debo ver un mensaje de error "<mensaje_error>"',
      "",
      "    Examples:",
      "      | correo                     | mensaje_error                    |",
      "      | usuario.valido@ejemplo.com | Correo o contraseña incorrectos  |",
      "      | no.registrado@ejemplo.com  | Correo o contraseña incorrectos  |",
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([
      { method: "get_error_message", argument: "Correo o contraseña incorrectos" },
      { method: "get_error_message", argument: "Correo o contraseña incorrectos" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("resolves distinct values per row, not just a repeated one", () => {
    const featureText = [
      "Feature: Validación",
      "  Scenario Outline: validaciones",
      '    Then debo ver el mensaje de validación "<mensaje_validacion>"',
      "",
      "    Examples:",
      "      | mensaje_validacion                       |",
      "      | El correo electrónico es obligatorio     |",
      "      | La contraseña es obligatoria              |",
      "      | Formato de correo electrónico no válido   |",
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver el mensaje de validación "{mensaje_validacion}"'))
def verificar_mensaje_validacion(page, mensaje_validacion):
    login_page = LoginPage(page)
    login_page.get_validation_message(mensaje_validacion)
`;
    const pageObject = `class LoginPage:
    def get_validation_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks.map((c) => c.argument)).toEqual([
      "El correo electrónico es obligatorio",
      "La contraseña es obligatoria",
      "Formato de correo electrónico no válido",
    ]);
  });

  it("skips (with a visible reason) a placeholder-shaped literal whose column isn't in the Examples header", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario Outline: fallos",
      '    Then debo ver un mensaje de error "<mensaje_error>"',
      "",
      "    Examples:",
      "      | otra_columna |",
      "      | x            |",
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("mensaje_error");
  });

  it("does not treat a literal that merely looks like <this> as a placeholder outside a Scenario Outline", () => {
    const featureText = [
      "Feature: X",
      "  Scenario: normal",
      '    Then debo ver un mensaje de error "<sin-outline>"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([{ method: "get_error_message", argument: "<sin-outline>" }]);
    expect(result.skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/extractLocatorChecks.test.ts`
Expected: FAIL on the 4 new tests (checks come back as the literal `"<mensaje_error>"` / `"<mensaje_validacion>"` text instead of resolved values, and no `skipped` entry for the bad-column case)

- [ ] **Step 3: Implement**

Replace `parseFeatureSteps` in `core/src/locatorVerify/extractLocatorChecks.ts`:
```ts
function parseFeatureSteps(featureText: string): FeatureStep[] {
  const steps: FeatureStep[] = [];
  let isOutline = false;
  let inExamples = false;
  let examplesHeader: string[] | null = null;
  let examplesRows: string[][] = [];
  let pendingOutlineSteps: FeatureStep[] = [];

  function flushOutline(): void {
    if (isOutline && examplesHeader && examplesRows.length > 0) {
      const header = examplesHeader;
      const rows = examplesRows.map((row) => {
        const record: Record<string, string> = {};
        header.forEach((col, i) => (record[col] = row[i] ?? ""));
        return record;
      });
      for (const step of pendingOutlineSteps) step.outlineExamples = rows;
    }
    isOutline = false;
    inExamples = false;
    examplesHeader = null;
    examplesRows = [];
    pendingOutlineSteps = [];
  }

  for (const rawLine of featureText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^Scenario Outline:/i.test(line)) {
      flushOutline();
      isOutline = true;
      continue;
    }
    if (/^Scenario:/i.test(line)) {
      flushOutline();
      continue;
    }
    if (/^Examples:/i.test(line)) {
      inExamples = true;
      continue;
    }
    if (inExamples && line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (!examplesHeader) examplesHeader = cells;
      else examplesRows.push(cells);
      continue;
    }
    const match = line.match(/^(?:Given|When|Then|And|But)\s+(.*)$/);
    if (match) {
      const step: FeatureStep = { text: match[1], outlineExamples: null };
      steps.push(step);
      if (isOutline) pendingOutlineSteps.push(step);
    }
  }
  flushOutline();
  return steps;
}
```

Replace the checks-building loop inside `extractLocatorChecks`:
```ts
    for (const [paramName, rawValue] of Object.entries(params)) {
      const calledMethod = findMethodCallForParam(matchedDef.body, paramName);
      if (!calledMethod || !calledMethod.startsWith("get_")) continue;

      const placeholderMatch = rawValue.match(/^<([\p{L}\p{N}_]+)>$/u);
      if (placeholderMatch && step.outlineExamples) {
        const column = placeholderMatch[1];
        if (!(column in step.outlineExamples[0])) {
          skipped.push(
            `Paso "${step.text}": la columna '${column}' no aparece en la tabla Examples de este Scenario Outline.`
          );
          continue;
        }
        for (const row of step.outlineExamples) {
          checks.push({ method: calledMethod, argument: row[column] });
        }
      } else {
        checks.push({ method: calledMethod, argument: rawValue });
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/locatorVerify/extractLocatorChecks.test.ts`
Expected: PASS (all tests, Task 2's and Task 3's)

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/extractLocatorChecks.ts core/src/locatorVerify/extractLocatorChecks.test.ts
git commit -m "feat(core): resolve Scenario Outline placeholders via Examples table in locator extraction"
```

---

## Task 4: `extractLocatorChecks` — action-method delegation + visible skip on untraceable params

**Files:**
- Modify: `core/src/locatorVerify/extractLocatorChecks.ts`
- Test: `core/src/locatorVerify/extractLocatorChecks.test.ts`

**Interfaces:** unchanged.

Two additions: (1) when the step-def calls an action method (not `get_*`) that itself delegates to a paired `get_*` method with the same bare parameter (the `click_button`/`get_button` split from the spec's own example), resolve through to that `get_*` method; (2) when a parameter can't be traced at all (renamed, transformed — e.g. `.strip()`), push a human-readable reason to `skipped` instead of silently dropping it. This is the spike's headline finding.

- [ ] **Step 1: Write the failing test**

Add to `core/src/locatorVerify/extractLocatorChecks.test.ts`:
```ts
describe("extractLocatorChecks — action-method delegation and untraceable params", () => {
  it("resolves an action method that delegates to a paired get_* method with the same bare parameter", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When pulso el botón "Log In"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('pulso el botón "{button_name}"'))
def pulsar_boton(page, button_name):
    login_page = LoginPage(page)
    login_page.click_button(button_name)
`;
    const pageObject = `class LoginPage:
    def get_button(self, button_name):
        return self.page.get_by_role("button", name=button_name, exact=False)

    def click_button(self, button_name):
        self.get_button(button_name).click()
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([{ method: "get_button", argument: "Log In" }]);
    expect(result.skipped).toEqual([]);
  });

  it("does not flag a plain action method that never delegates to any get_* as a gap", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When introduzco el correo electrónico "usuario@ejemplo.com"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('introduzco el correo electrónico "{correo}"'))
def introducir_correo(page, correo):
    login_page = LoginPage(page)
    login_page.fill_email(correo)
`;
    const pageObject = `class LoginPage:
    def fill_email(self, email):
        self.email_input.fill(email)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("surfaces a visible skip reason (not a silent drop) when the step parameter is transformed before being passed on", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When pulso el botón "Log In"',
      "",
    ].join("\n");

    // Realistic, unremarkable LLM output: normalizes whitespace before use —
    // nothing exotic, but it breaks the bare-identifier convention the
    // cross-reference relies on.
    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('pulso el botón "{button_name}"'))
def pulsar_boton(page, button_name):
    login_page = LoginPage(page)
    nombre_normalizado = button_name.strip()
    login_page.click_button(nombre_normalizado)
`;
    const pageObject = `class LoginPage:
    def get_button(self, button_name):
        return self.page.get_by_role("button", name=button_name, exact=False)

    def click_button(self, button_name):
        self.get_button(button_name).click()
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("button_name");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/extractLocatorChecks.test.ts`
Expected: FAIL on the 3 new tests (`click_button` case produces no check at all yet; the `.strip()` case produces neither a check nor a skip entry — today it's silently dropped, which is exactly the gap this task closes)

- [ ] **Step 3: Implement**

Add a new helper to `core/src/locatorVerify/extractLocatorChecks.ts`, right after `findMethodCallForParam`:
```ts
function findDelegatedGetMethod(pageObjectSrc: string, actionMethod: string, paramName: string): string | null {
  const defRe = new RegExp(
    `def\\s+${actionMethod}\\(self,\\s*[^)]*\\):[\\s\\S]*?(?=\\n    def\\s|\\nclass\\s|$)`
  );
  const match = pageObjectSrc.match(defRe);
  if (!match) return null;
  for (const call of match[0].matchAll(/self\.(get_[\p{L}\p{N}_]*)\(([^)]*)\)/gu)) {
    const [, getMethod, argsStr] = call;
    const args = argsStr.split(",").map((a) => a.trim());
    if (args.includes(paramName)) return getMethod;
  }
  return null;
}
```

Replace the per-param body of the main loop in `extractLocatorChecks` (the part that starts with `const calledMethod = findMethodCallForParam(...)`):
```ts
    for (const [paramName, rawValue] of Object.entries(params)) {
      const calledMethod = findMethodCallForParam(matchedDef.body, paramName);
      if (!calledMethod) {
        skipped.push(
          `Paso "${step.text}": el parámetro '${paramName}' no se pasa sin transformar (mismo nombre, sin recortar ni procesar) a ningún método del Page Object — no se puede verificar automáticamente.`
        );
        continue;
      }

      const targetMethod = calledMethod.startsWith("get_")
        ? calledMethod
        : findDelegatedGetMethod(pageObjectFile.content, calledMethod, paramName);

      if (!targetMethod) continue; // acción normal sin locator ambiguo (p.ej. fill_email) — nada que verificar

      const placeholderMatch = rawValue.match(/^<([\p{L}\p{N}_]+)>$/u);
      if (placeholderMatch && step.outlineExamples) {
        const column = placeholderMatch[1];
        if (!(column in step.outlineExamples[0])) {
          skipped.push(
            `Paso "${step.text}": la columna '${column}' no aparece en la tabla Examples de este Scenario Outline.`
          );
          continue;
        }
        for (const row of step.outlineExamples) {
          checks.push({ method: targetMethod, argument: row[column] });
        }
      } else {
        checks.push({ method: targetMethod, argument: rawValue });
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/locatorVerify/extractLocatorChecks.test.ts`
Expected: PASS (all tests across Tasks 2, 3, and 4)

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/extractLocatorChecks.ts core/src/locatorVerify/extractLocatorChecks.test.ts
git commit -m "feat(core): resolve action-method delegation to get_* and surface untraceable params instead of dropping them"
```

---

## Task 5: `buildVerificationScript` — pure Python script builder

**Files:**
- Create: `core/src/locatorVerify/buildVerificationScript.ts`
- Test: `core/src/locatorVerify/buildVerificationScript.test.ts`

**Interfaces:**
- Consumes: `GeneratedFile` from `../agents/generador/codeGenerator.js`, `LocatorCheck` from `./locatorVerifier.js`.
- Produces: `buildVerificationScript(files: GeneratedFile[], checks: LocatorCheck[], baseUrl: string): string`.

The script never relies on the generated Page Object having any particular `goto()` convention — it navigates with the raw Playwright `page` directly, then discovers whichever class(es) the Page Object module defines via `importlib`/`inspect` (the prompt allows "clase(s)", plural, for multi-screen flows) and tries each `LocatorCheck.method` against every instance.

- [ ] **Step 1: Write the failing test**

`core/src/locatorVerify/buildVerificationScript.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildVerificationScript } from "./buildVerificationScript.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

const files: GeneratedFile[] = [
  { path: "tests/test_login.py", content: "" },
  { path: "pages/login_page.py", content: "class LoginPage:\n    pass\n" },
];

describe("buildVerificationScript", () => {
  it("embeds the base URL, checks, and page object path as JSON literals", () => {
    const script = buildVerificationScript(
      files,
      [{ method: "get_button", argument: "Log In" }],
      "https://example.com"
    );

    expect(script).toContain('BASE_URL = "https://example.com"');
    expect(script).toContain('"method": "get_button"');
    expect(script).toContain('"argument": "Log In"');
    expect(script).toContain('PAGE_OBJECT_PATH = "pages/login_page.py"');
  });

  it("never calls an action method — only .count()/.all(), never .click()/.fill()/.check()", () => {
    const script = buildVerificationScript(files, [], "https://example.com");

    expect(script).toContain(".count()");
    expect(script).toContain(".all()");
    expect(script).not.toContain(".click(");
    expect(script).not.toContain(".fill(");
    expect(script).not.toContain(".check(");
    expect(script).not.toContain(".submit(");
  });

  it("always launches headless, regardless of any project headedMode preference", () => {
    const script = buildVerificationScript(files, [], "https://example.com");
    expect(script).toContain("headless=True");
  });

  it("navigates with the raw page directly, never through a Page Object goto() method", () => {
    const script = buildVerificationScript(files, [], "https://example.com");
    expect(script).toContain("page.goto(BASE_URL)");
  });

  it("uses an empty string for PAGE_OBJECT_PATH when no pages/ file is present", () => {
    const script = buildVerificationScript([{ path: "tests/test_x.py", content: "" }], [], "https://example.com");
    expect(script).toContain('PAGE_OBJECT_PATH = ""');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/buildVerificationScript.test.ts`
Expected: FAIL (`Cannot find module './buildVerificationScript.js'`)

- [ ] **Step 3: Implement**

`core/src/locatorVerify/buildVerificationScript.ts`:
```ts
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { LocatorCheck } from "./locatorVerifier.js";

export function buildVerificationScript(files: GeneratedFile[], checks: LocatorCheck[], baseUrl: string): string {
  const pageObjectFile = files.find((f) => f.path.startsWith("pages/"));
  const pageObjectPath = pageObjectFile ? pageObjectFile.path : "";

  return `import importlib.util
import inspect
import json

from playwright.sync_api import sync_playwright

BASE_URL = ${JSON.stringify(baseUrl)}
CHECKS = ${JSON.stringify(checks)}
PAGE_OBJECT_PATH = ${JSON.stringify(pageObjectPath)}


def load_page_object_classes(module_path):
    if not module_path:
        return []
    spec = importlib.util.spec_from_file_location("generated_page_object", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return [
        obj
        for _, obj in inspect.getmembers(module, inspect.isclass)
        if obj.__module__ == "generated_page_object"
    ]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(BASE_URL)

        classes = load_page_object_classes(PAGE_OBJECT_PATH)
        instances = [cls(page) for cls in classes]

        for check in CHECKS:
            method_name = check["method"]
            argument = check["argument"]
            target = None
            for instance in instances:
                if hasattr(instance, method_name):
                    target = getattr(instance, method_name)
                    break
            if target is None:
                print(json.dumps({
                    "method": method_name,
                    "argument": argument,
                    "error": f"no se encontro el metodo {method_name} en ningun Page Object generado",
                }))
                continue

            locator = target(argument)
            count = locator.count()
            entry = {"method": method_name, "argument": argument, "count": count}
            if count != 1:
                matches = []
                for element in locator.all()[:5]:
                    try:
                        matches.append(element.evaluate("el => el.outerHTML")[:200])
                    except Exception:
                        matches.append("<no se pudo leer outerHTML>")
                entry["matches"] = matches
            print(json.dumps(entry))

        browser.close()


if __name__ == "__main__":
    main()
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/locatorVerify/buildVerificationScript.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/buildVerificationScript.ts core/src/locatorVerify/buildVerificationScript.test.ts
git commit -m "feat(core): build a disposable, read-only Python script for real locator verification"
```

---

## Task 6: `realLocatorVerifier` — preflight, subprocess execution, result parsing

**Files:**
- Create: `core/src/locatorVerify/realLocatorVerifier.ts`
- Test: `core/src/locatorVerify/realLocatorVerifier.test.ts`

**Interfaces:**
- Consumes: `buildVerificationScript` from `./buildVerificationScript.js`; `assertSafeRelativePath` from `../util/assertSafeRelativePath.js`.
- Produces: `createRealLocatorVerifier(options?: { pythonCommand?: string }): LocatorVerifier`, `realLocatorVerifier: LocatorVerifier`, `MissingLocatorVerifierToolError`.

This task covers preflight + missing-tool handling only (mirrors `realTestRunner`'s equivalent tests exactly). The real-browser happy-path test is Task 7.

- [ ] **Step 1: Write the failing test**

`core/src/locatorVerify/realLocatorVerifier.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRealLocatorVerifier, MissingLocatorVerifierToolError } from "./realLocatorVerifier.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/realLocatorVerifier.test.ts`
Expected: FAIL (`Cannot find module './realLocatorVerifier.js'`)

- [ ] **Step 3: Implement**

`core/src/locatorVerify/realLocatorVerifier.ts`:
```ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertSafeRelativePath } from "../util/assertSafeRelativePath.js";
import { buildVerificationScript } from "./buildVerificationScript.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { LocatorCheck, LocatorVerifier, LocatorVerificationResult } from "./locatorVerifier.js";
import type { ExplorationCredentials } from "../siteExplorer/siteExplorer.js";

export class MissingLocatorVerifierToolError extends Error {
  constructor(detail: string) {
    super(
      `No se pudo verificar los locators generados: ${detail}. Instala las dependencias con "pip install pytest pytest-bdd pytest-playwright pytest-html" y luego "playwright install".`
    );
    this.name = "MissingLocatorVerifierToolError";
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCapture(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
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

interface VerificationEntry {
  method: string;
  argument: string;
  count?: number;
  matches?: string[];
  error?: string;
}

function formatFailure(entry: VerificationEntry): string {
  if (entry.error) {
    return `El locator ${entry.method}(${JSON.stringify(entry.argument)}) no se pudo verificar: ${entry.error}`;
  }
  const matchesText = (entry.matches ?? []).map((html, i) => `${i + 1}) ${html}`).join("\n");
  return `El locator ${entry.method}(${JSON.stringify(entry.argument)}) resolvió a ${entry.count} elementos reales:\n${matchesText}\nHazlo más específico para que resuelva exactamente a 1 elemento.`;
}

export function createRealLocatorVerifier(options?: { pythonCommand?: string }): LocatorVerifier {
  const pythonCommand = options?.pythonCommand ?? "python";

  return {
    async verify(
      files: GeneratedFile[],
      checks: LocatorCheck[],
      baseUrl: string,
      credentials: ExplorationCredentials | undefined
    ): Promise<LocatorVerificationResult> {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENTE_QA_APP_URL: baseUrl,
        ...(credentials
          ? { AGENTE_QA_TEST_USERNAME: credentials.username, AGENTE_QA_TEST_PASSWORD: credentials.password }
          : {}),
      };

      let preflight: RunResult;
      try {
        preflight = await runCapture(
          pythonCommand,
          ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"],
          process.cwd(),
          env
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new MissingLocatorVerifierToolError(`no se encontró "${pythonCommand}" en el sistema`);
        }
        throw err;
      }
      if (preflight.code !== 0) {
        throw new MissingLocatorVerifierToolError(
          `faltan dependencias Python (pytest, pytest-bdd, pytest-playwright o pytest-html)\n${preflight.stderr || preflight.stdout}`
        );
      }

      if (checks.length === 0) return { ok: true };

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-locatorverify-"));
      try {
        for (const file of files) {
          assertSafeRelativePath(tmpDir, file.path);
          const target = path.join(tmpDir, file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.content, "utf-8");
        }

        const script = buildVerificationScript(files, checks, baseUrl);
        const scriptPath = path.join(tmpDir, "_verify_locators.py");
        await fs.writeFile(scriptPath, script, "utf-8");

        const result = await runCapture(pythonCommand, [scriptPath], tmpDir, env);

        const failures: string[] = [];
        const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
        for (const line of lines) {
          let entry: VerificationEntry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (entry.error || entry.count !== 1) {
            failures.push(formatFailure(entry));
          }
        }

        if (result.code !== 0 && lines.length === 0) {
          failures.push(result.stderr || result.stdout || "El script de verificación de locators terminó con error.");
        }

        return failures.length === 0 ? { ok: true } : { ok: false, errors: failures.join("\n\n") };
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

export const realLocatorVerifier: LocatorVerifier = createRealLocatorVerifier();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/locatorVerify/realLocatorVerifier.test.ts`
Expected: PASS (the ENOENT test always runs and passes; the "modules missing" test self-skips via its early `return` unless you have a Python without the pytest stack on PATH)

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/realLocatorVerifier.ts core/src/locatorVerify/realLocatorVerifier.test.ts
git commit -m "feat(core): implement createRealLocatorVerifier with preflight and subprocess execution"
```

---

## Task 7: `realLocatorVerifier` — real headless-browser end-to-end test (gated)

**Files:**
- Modify: `core/src/locatorVerify/realLocatorVerifier.test.ts`

**Interfaces:** none new — exercises `realLocatorVerifier` for real.

Drives an actual headless Chromium against a static local HTML fixture via a `file://` URL (no HTTP server needed — simpler and faster than spinning one up, and Playwright supports `file://` navigation natively). Uses the exact `click_button`/`get_button` pattern from the spec's own example: one page has two buttons sharing the accessible name "Log in" (ambiguous), the other has only one (unambiguous).

- [ ] **Step 1: Write the failing test**

Add to `core/src/locatorVerify/realLocatorVerifier.test.ts`:
```ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { realLocatorVerifier } from "./realLocatorVerifier.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

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
```

Also add `import { describe, it, expect, beforeEach, afterEach } from "vitest";` to the top of the file (replacing the existing `import { describe, it, expect } from "vitest";`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/realLocatorVerifier.test.ts`
Expected (if `pytest`/`pytest-bdd`/`pytest-playwright`/`pytest-html` are installed and on `PATH`): the 2 new tests FAIL because `LOGIN_PAGE_OBJECT`/fixture wiring is new — run once to confirm they actually execute (not silently skipped) and see real failure output, e.g. a Python traceback if `buildVerificationScript`'s class discovery has a bug. If the pytest stack isn't installed, `describe.skipIf` skips this block entirely — expected, not a failure.

- [ ] **Step 3: No implementation changes needed**

Tasks 5 and 6 already implement everything this test exercises. If Step 2 failed for a reason other than "stack not installed" (e.g. a real bug in `buildVerificationScript`'s `importlib` usage or `realLocatorVerifier`'s JSON-line parsing), fix it now in the files from Task 5/6 — this test is what proves those tasks actually work end-to-end with a real browser, not just against string assertions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/locatorVerify/realLocatorVerifier.test.ts`
Expected: PASS (all 3 new tests, plus Task 6's tests still green)

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/realLocatorVerifier.test.ts
git commit -m "test(core): add real headless-browser end-to-end coverage for realLocatorVerifier"
```

---

## Task 8: `codeGenerationPrompt` — get_*/action split + bare-identifier passthrough instructions

**Files:**
- Modify: `core/src/prompts/generador.ts`
- Modify: `core/src/agents/generador/codeGenerator.test.ts`

**Interfaces:** no signature change to `codeGenerationPrompt`.

- [ ] **Step 1: Write the failing test**

Add to `core/src/agents/generador/codeGenerator.test.ts`, inside the existing `describe("generateCode", ...)` block:
```ts
  it("instructs the model to split a parametrized locator's construction (get_*) from acting on it", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("get_<algo>");
    expect(userMessage?.content).toContain("click_button");
  });

  it("instructs the model to pass the step's parsers.parse value unmodified to the paired method", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("SIN transformar");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: FAIL on the 2 new tests (`toContain("get_<algo>")` and `toContain("SIN transformar")` — neither string is in the prompt yet)

- [ ] **Step 3: Implement**

In `core/src/prompts/generador.ts`, insert two new paragraphs right after the existing `.or_()` locator-strategy paragraph (the one ending `"...colisiona con el locator del campo).\``) and before the credentials/`os.environ` paragraph:
```ts
Si un método del Page Object actúa sobre un elemento identificado por un parámetro variable (un texto o nombre accesible que cambia según el escenario, no un valor fijo), sepáralo siempre en dos métodos: uno "get_<algo>" que solo construye y devuelve el "Locator" (nunca actúa: nada de ".click()"/".fill()"/envíos de formulario), y otro (p. ej. "click_<algo>"/"fill_<algo>") que llama al primero y actúa sobre el resultado. Ejemplo:
"""
def get_button(self, button_name: str):
    return self.page.get_by_role("button", name=button_name, exact=False)

def click_button(self, button_name: str):
    self.get_button(button_name).click()
"""
Los locators FIJOS (sin parámetro, definidos una vez como atributos en el constructor, p. ej. "self.submit_button") no necesitan este patrón.

El valor que un step recibe de "parsers.parse" debe pasarse SIN transformar (mismo nombre de variable, sin recortar espacios, cambiar mayúsculas/minúsculas ni ningún otro procesamiento) como argumento posicional del método "get_*" o de acción correspondiente: una herramienta automática cruza el archivo Gherkin con este código para verificar los locators contra la aplicación real antes de aceptarlo, y solo puede seguir el rastro de un valor si llega intacto y con el mismo nombre de variable en ambos lados.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/generador.ts core/src/agents/generador/codeGenerator.test.ts
git commit -m "feat(core): instruct the code-generation prompt to split parametrized locators and pass values unmodified"
```

---

## Task 9: `runGenerador` — wire extraction + verification into the retry loop

**Files:**
- Modify: `core/src/agents/generador/runGenerador.ts`
- Modify: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Consumes: `LocatorVerifier` from `../../locatorVerify/locatorVerifier.js`, `extractLocatorChecks` from `../../locatorVerify/extractLocatorChecks.js`.
- Produces: `GeneratorCallbacks` gains `onVerificationStep(message: string): void`; `RunGeneradorOptions` gains `verifier: LocatorVerifier` (inserted right after `explorer`).

- [ ] **Step 1: Write the failing test**

First, update the `callbacks()` test helper near the top of `core/src/agents/generador/runGenerador.test.ts`:
```ts
function callbacks(overrides: Partial<GeneratorCallbacks> = {}): GeneratorCallbacks {
  return {
    offerSavePattern: vi.fn(),
    confirmOverwrite: vi.fn().mockResolvedValue(true),
    onExplorationStep: vi.fn(),
    onVerificationStep: vi.fn(),
    ...overrides,
  };
}
```

Add the import (next to the other `testUtils` imports):
```ts
import { FakeLocatorVerifier } from "../../locatorVerify/testUtils.js";
```

Then, in **every** existing `runGenerador({...})` call in the file, add `verifier: new FakeLocatorVerifier([]),` immediately after the `credentials: ...,` line. There are 15 such call sites — do this edit *before* the `callbacks()`/import edits above, so the line numbers below (from the file's current, unmodified state) still line up: 75, 106, 142, 177, 215, 243, 275, 304, 335, 380, 406, 438, 468, 495, 574. (Every one of these lines reads either `credentials: undefined,` or `credentials: { username: ..., password: ... },` — that text is what to match on if line numbers drift after other edits, not the numbers themselves.) None of these tests' `scriptedResponse` fixture contains a `get_*` method, so `extractLocatorChecks` will always find zero checks for them and `verifier.verify` is never called — an empty `FakeLocatorVerifier([])` is correct and will never throw "out of scripted results".

Finally, add 4 new tests at the end of the `describe("runGenerador", ...)` block, right before its closing `});`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL — TypeScript error first (`RunGeneradorOptions` has no `verifier` yet is required by the type only after Step 3; until then the new tests fail with "verifier is not defined behavior" / the 4 new tests fail because nothing calls `extractLocatorChecks` or `verifier.verify` yet)

- [ ] **Step 3: Implement**

In `core/src/agents/generador/runGenerador.ts`, add imports:
```ts
import type { LocatorVerifier } from "../../locatorVerify/locatorVerifier.js";
import { extractLocatorChecks } from "../../locatorVerify/extractLocatorChecks.js";
```

Update `GeneratorCallbacks` and `RunGeneradorOptions`:
```ts
export interface GeneratorCallbacks {
  offerSavePattern(featureText: string): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
  onExplorationStep(message: string): void;
  onVerificationStep(message: string): void;
}

export interface RunGeneradorOptions {
  featureFilePath: string;
  llm: LLMProvider;
  patterns: Pattern[];
  checker: CodeChecker;
  explorer: SiteExplorer;
  verifier: LocatorVerifier;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  appLanguage: "es" | "en";
  routes: Record<string, string>;
  credentials: ExplorationCredentials | undefined;
  callbacks: GeneratorCallbacks;
}
```

Add `verifier` to the destructured options at the top of `runGenerador`:
```ts
  const {
    featureFilePath,
    llm,
    patterns,
    checker,
    explorer,
    verifier,
    projectRoot,
    testsDir,
    baseUrl,
    appLanguage,
    routes,
    credentials,
    callbacks,
  } = options;
```

Replace the retry loop body:
```ts
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    files = await generateCode(featureText, llm, matchedPattern, naming, evidence, appLanguage, routes, retry);

    const checkResult = await checker.check(files);
    if (!checkResult.ok) {
      const errors = checkResult.errors ?? "Error desconocido de verificación de código.";
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`El código generado no pasó la verificación tras ${MAX_ATTEMPTS} intentos. Último error:\n${errors}`);
      }
      retry = { previousFiles: files, feedback: errors };
      continue;
    }

    const { checks, skipped } = extractLocatorChecks(featureText, files);
    if (skipped.length > 0) {
      callbacks.onVerificationStep(
        `${skipped.length} literal(es) no se pudieron verificar automáticamente:\n${skipped.join("\n")}`
      );
    }
    if (checks.length === 0) break;

    callbacks.onVerificationStep(`Verificando ${checks.length} locator(s) contra la aplicación real...`);
    const verification = await verifier.verify(files, checks, baseUrl, credentials);
    if (verification.ok) break;

    const verifyErrors = verification.errors ?? "Error desconocido de verificación de locators.";
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `El código generado no pasó la verificación de locators tras ${MAX_ATTEMPTS} intentos. Último error:\n${verifyErrors}`
      );
    }
    retry = { previousFiles: files, feedback: verifyErrors };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: PASS (all existing tests, plus the 4 new ones)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/generador/runGenerador.ts core/src/agents/generador/runGenerador.test.ts
git commit -m "feat(core): wire real locator verification into the generator's retry loop"
```

---

## Task 10: `core/src/index.ts` barrel exports

**Files:**
- Modify: `core/src/index.ts`
- Modify: `core/src/index.test.ts`

**Interfaces:** none new — this task only makes Tasks 1–9's public surface importable from `@agente-qa/core`.

- [ ] **Step 1: Write the failing test**

Add to `core/src/index.test.ts`, inside the `describe("@agente-qa/core public API", ...)` block:
```ts
  it("exports the locator verification surface", () => {
    expect(typeof core.FakeLocatorVerifier).toBe("function");
    expect(typeof core.extractLocatorChecks).toBe("function");
    expect(typeof core.buildVerificationScript).toBe("function");
    expect(typeof core.createRealLocatorVerifier).toBe("function");
    expect(typeof core.realLocatorVerifier.verify).toBe("function");
    expect(typeof core.MissingLocatorVerifierToolError).toBe("function");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/index.test.ts`
Expected: FAIL (`core.FakeLocatorVerifier` etc. are `undefined`)

- [ ] **Step 3: Implement**

In `core/src/index.ts`, insert this block right after the existing `CodeChecker` export block (after `export { createRealCodeChecker, realCodeChecker, MissingCodeToolError } from "./codeCheck/realCodeChecker.js";`):
```ts
export type { LocatorCheck, LocatorVerificationResult, LocatorVerifier } from "./locatorVerify/locatorVerifier.js";
export { FakeLocatorVerifier } from "./locatorVerify/testUtils.js";
export { extractLocatorChecks } from "./locatorVerify/extractLocatorChecks.js";
export type { LocatorExtractionResult } from "./locatorVerify/extractLocatorChecks.js";
export { buildVerificationScript } from "./locatorVerify/buildVerificationScript.js";
export {
  createRealLocatorVerifier,
  realLocatorVerifier,
  MissingLocatorVerifierToolError,
} from "./locatorVerify/realLocatorVerifier.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/index.ts core/src/index.test.ts
git commit -m "feat(core): export the locator verification surface from the public barrel"
```

---

## Task 11: CLI wiring — spinner + `generate.ts`

**Files:**
- Modify: `cli/src/util/spinner.ts`
- Modify: `cli/src/commands/generate.ts`
- Modify: `cli/src/commands/generate.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `withLocatorVerifierSpinner(verifier: LocatorVerifier): LocatorVerifier`.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/commands/generate.test.ts`. First extend the existing `@agente-qa/core` mock and spinner mock at the top of the file:
```ts
const createRealLocatorVerifierMock = vi.fn();
const withLocatorVerifierSpinnerMock = vi.fn((verifier: unknown) => verifier);
```
(add these two `const` declarations next to the existing `createRealSiteExplorerMock`/`withCodeCheckerSpinnerMock` ones)

Extend the `vi.mock("@agente-qa/core", ...)` factory's returned object:
```ts
    createRealLocatorVerifier: (...args: unknown[]) => createRealLocatorVerifierMock(...args),
```

Extend the `vi.mock("../util/spinner.js", ...)` factory's returned object:
```ts
    withLocatorVerifierSpinner: (verifier: unknown) => withLocatorVerifierSpinnerMock(verifier),
```

In the `beforeEach`, add:
```ts
    createRealLocatorVerifierMock.mockReset();
    createRealLocatorVerifierMock.mockReturnValue(new FakeLocatorVerifier([]));
    withLocatorVerifierSpinnerMock.mockClear();
    withLocatorVerifierSpinnerMock.mockImplementation((verifier: unknown) => verifier);
```

Add `FakeLocatorVerifier` to the existing `@agente-qa/core` named import at the top of the file.

Then add a new test, next to the existing "wraps the LLM provider and the code checker with their spinner decorators" test:
```ts
  it("builds the locator verifier and wraps it with its spinner decorator before using it", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
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
    const verifier = new FakeLocatorVerifier([]);
    createRealLocatorVerifierMock.mockReturnValue(verifier);

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
      offerSavePattern: vi.fn().mockResolvedValue({ save: false }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runGenerateTests(prompts, tmpProject);

    expect(createRealLocatorVerifierMock).toHaveBeenCalled();
    expect(withLocatorVerifierSpinnerMock.mock.calls[0][0]).toBe(verifier);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: FAIL (`createRealLocatorVerifierMock` never called — `generate.ts` doesn't wire a verifier yet)

- [ ] **Step 3: Implement**

`cli/src/util/spinner.ts` — add to the `@agente-qa/core` import:
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
  LocatorVerifier,
  LocatorCheck,
  LocatorVerificationResult,
  GeneratedFile,
  ExplorationCredentials,
} from "@agente-qa/core";
```

Add a new exported function at the end of the file:
```ts
export function withLocatorVerifierSpinner(verifier: LocatorVerifier): LocatorVerifier {
  return {
    async verify(
      files: GeneratedFile[],
      checks: LocatorCheck[],
      baseUrl: string,
      credentials: ExplorationCredentials | undefined
    ): Promise<LocatorVerificationResult> {
      const spinner = ora(`Verificando ${checks.length} locator(s) contra la aplicación real...`).start();
      try {
        const result = await verifier.verify(files, checks, baseUrl, credentials);
        if (result.ok) {
          spinner.succeed("Locators verificados sin ambigüedad.");
        } else {
          spinner.fail("Algún locator generado es ambiguo en la aplicación real.");
        }
        return result;
      } catch (err) {
        spinner.fail("Fallo al verificar los locators.");
        throw err;
      }
    },
  };
}
```

`cli/src/commands/generate.ts` — update imports:
```ts
import path from "node:path";
import {
  createProvider,
  loadProjectEnv,
  requireLlmConfig,
  requireAppUrl,
  loadProjectConfig,
  loadAllPatterns,
  listFeatureFiles,
  realCodeChecker,
  createRealSiteExplorer,
  createRealLocatorVerifier,
  runGenerador,
  projectEnvPath,
  type GeneratorCallbacks,
} from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";
import { withLLMSpinner, withCodeCheckerSpinner, withLocatorVerifierSpinner } from "../util/spinner.js";
```

Update the `callbacks` object and the `runGenerador` call:
```ts
  const callbacks: GeneratorCallbacks = {
    offerSavePattern: () => prompts.offerSavePattern(),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
    onExplorationStep: (message) => {
      console.log(message);
    },
    onVerificationStep: (message) => {
      console.log(message);
    },
  };

  const { writtenPaths } = await runGenerador({
    featureFilePath,
    llm,
    patterns,
    checker: withCodeCheckerSpinner(realCodeChecker),
    explorer,
    verifier: withLocatorVerifierSpinner(createRealLocatorVerifier()),
    projectRoot,
    testsDir: projectConfig.testsDir,
    baseUrl,
    appLanguage: projectConfig.appLanguage,
    routes: projectConfig.routes,
    credentials,
    callbacks,
  });
```

`README.md` — replace line 20's table cell:
```
| Requiere | Claude Code + suscripción Pro/Max/Team/Enterprise (o API key) | Node.js, sin dependencia de Claude Code (+ Python, `ruff`, los navegadores de Playwright para Node, y `pytest`/`pytest-bdd`/`pytest-playwright`/`pytest-html` para "Generar tests Playwright"; estos últimos también para "Ejecutar tests") |
```

Replace the two blockquote paragraphs (lines 25–27):
```
> A partir de "Generar tests Playwright" (Agente 2), la CLI standalone necesita además **Python 3, `ruff`, y `pytest`/`pytest-bdd`/`pytest-playwright`/`pytest-html`** en el `PATH` — `ruff`+`py_compile` verifican que el código generado compila y pasa lint, y el stack de pytest se usa para lanzar un navegador real (headless) que comprueba que cada locator generado con un parámetro variable resuelve a exactamente un elemento en la aplicación real antes de aceptar el código — y los **navegadores de Playwright para Node** (`npx playwright install chromium`, una sola vez tras instalar `agente-qa`) para el propio "Site Explorer" de Agente 2. No hace falta para "Crear plan de pruebas" (Agente 1).
>
> A partir de "Ejecutar tests" (Agente 3), la CLI standalone reutiliza el mismo stack de pytest para ejecutar los tests generados de verdad, capturar screenshots/vídeo solo en fallo, y generar el reporte extendido que "Ver/generar reportes" (Agente 4) confirma después. No hace falta nada adicional para "Ver/generar reportes" en sí — solo lee ficheros que Agente 3 ya dejó escritos.
```

Replace line 31:
```
Solo hace falta si vas a usar "Generar tests Playwright" o "Ejecutar tests" (Agente 1, crear plan de pruebas, no lo necesita).
```
with:
```
Hace falta desde "Generar tests Playwright" en adelante (Agente 1, crear plan de pruebas, no lo necesita) — Agente 2 ya lanza un navegador real headless para verificar locators antes de aceptar el código, no solo Agente 3 al ejecutar los tests.
```

Replace line 46–47:
```
- `ruff` — lo usa Agente 2 (Generar tests) para verificar lint/compilación antes de escribir nada al proyecto.
- `pytest`, `pytest-bdd`, `pytest-playwright`, `pytest-html` — Agente 2 (Generar tests) los usa para lanzar un navegador headless que verifica cada locator generado contra la aplicación real; Agente 3 (Ejecutar tests) reutiliza el mismo stack para correr los tests generados y producir el reporte extendido.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add cli/src/util/spinner.ts cli/src/commands/generate.ts cli/src/commands/generate.test.ts README.md
git commit -m "feat(cli): wire real locator verification into the generate-tests command"
```

---

## Final verification (run once, after all 11 tasks)

- [ ] `npx tsc -p core/tsconfig.json --noEmit` — clean
- [ ] `npx tsc -p cli/tsconfig.json --noEmit` — clean (rebuild `core/dist/` first if this fails to resolve `@agente-qa/core`: `npm run build --workspace=core`)
- [ ] `npx vitest run` — full suite green
- [ ] Branch-level review per `superpowers:subagent-driven-development` — this feature has 4 confirmed prior instances in this project of bugs that only show up when all tasks' diffs are read together (see `memory.md`); do not skip it even though every task above passed individually.
