# Anclaje del Gherkin y cierre del bucle de verificación — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los literales de interfaz que Agente 1 escribe en el `.feature` vengan de la aplicación real y no del LLM, y que un literal inventado bloquee la generación en vez de avisar.

**Architecture:** Cuatro fases. Fase 0 arregla `parsers.parse` con un lint puro y enseña al extractor de locators la forma `parsers.re`. Fase 1 mete el `SiteExplorer` existente en `runIntake`, añade una sonda de credenciales inválidas declarada por patrón y cachea la evidencia para que Agente 2 no vuelva a explorar. Fase 2 cruza los literales esperados con toda la evidencia (offline primero, navegador después, todas las pantallas) y convierte `count === 0` en fallo. Fase 3 elimina la sustitución de credenciales por comparación de literales.

**Tech Stack:** TypeScript ESM (NodeNext, imports con sufijo `.js`), vitest, Zod v4, Playwright (Node, para el explorador), Python + pytest-bdd + pytest-playwright (código generado).

**Spec:** `docs/superpowers/specs/2026-08-15-gherkin-grounding-verification-design.md`

## Global Constraints

- Node `>=22`.
- Imports relativos siempre con sufijo `.js`, aunque el fichero sea `.ts`.
- `core/src` nunca hace I/O de terminal: nada de `console.*` ni `readline`. Toda interacción cruza callbacks inyectados.
- DI explícita: las funciones de `core` reciben `projectRoot` como parámetro; nunca leen `process.cwd()` por dentro.
- Cadenas de cara al usuario en castellano; identificadores, comentarios de código y mensajes de commit en inglés.
- Commits en Conventional Commits (`feat(core):`, `fix(core):`, `test:`, `docs:`).
- Verificación de cada tarea: `npx vitest run <ruta del test>` en verde y, en tareas que cambien firmas públicas, `npx tsc -p core/tsconfig.json --noEmit` limpio.
- Zod instalado es v4: `z.record()` exige dos argumentos (`z.record(z.string(), z.string())`).
- Nunca escribir credenciales reales en ficheros de test, fixtures ni mensajes.

---

## Fase 0 — `parsers.re` para valores entrecomillados

### Task 1: Lint que prohíbe `parsers.parse` con parámetros entrecomillados

**Files:**
- Create: `core/src/codeCheck/stepParserLint.ts`
- Create: `core/src/codeCheck/stepParserLint.test.ts`
- Modify: `core/src/codeCheck/realCodeChecker.ts` (importar y fusionar junto a `checkLocatorPatterns`)

**Interfaces:**
- Consumes: `CodeFile`, `CodeCheckResult` de `./codeChecker.js` (`CodeFile = { path: string; content: string }`, `CodeCheckResult = { ok: true } | { ok: false; errors?: string }`).
- Produces: `checkStepParsers(files: CodeFile[]): CodeCheckResult`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/codeCheck/stepParserLint.test.ts
import { describe, it, expect } from "vitest";
import { checkStepParsers } from "./stepParserLint.js";

describe("checkStepParsers", () => {
  it("rejects parsers.parse with a quoted parameter", () => {
    const result = checkStepParsers([
      {
        path: "tests/test_login.py",
        content: `@when(parsers.parse('introduzco el correo electrónico "{email}"'))\ndef step(login_page, email):\n    pass\n`,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("tests/test_login.py:1");
    expect(result.errors).toContain("parsers.re");
  });

  it("accepts parsers.re with a named group", () => {
    const result = checkStepParsers([
      {
        path: "tests/test_login.py",
        content: `@when(parsers.re(r'introduzco el correo electrónico "(?P<email>[^"]*)"'))\ndef step(login_page, email):\n    pass\n`,
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts parsers.parse when no parameter is quoted", () => {
    const result = checkStepParsers([
      { path: "tests/test_login.py", content: `@when(parsers.parse('pulso el botón {name}'))\n` },
    ]);
    expect(result.ok).toBe(true);
  });

  // The prompt names parsers.parse to warn against it, so the model tends to
  // quote that exact string inside a comment. Same failure already seen with
  // .or_() on 2026-08-14.
  it("ignores commented-out lines", () => {
    const result = checkStepParsers([
      {
        path: "tests/test_login.py",
        content: `# no uses parsers.parse('el correo "{email}"') aquí\n@when(parsers.re(r'el correo "(?P<email>[^"]*)"'))\n`,
      },
    ]);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/codeCheck/stepParserLint.test.ts`
Expected: FAIL — no se resuelve el módulo `./stepParserLint.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// core/src/codeCheck/stepParserLint.ts
import type { CodeFile, CodeCheckResult } from "./codeChecker.js";

const PARSE_CALL = /parsers\.parse\(/;
const QUOTED_PARAM = /"\{([\p{L}\p{N}_]+)\}"/u;

const EXPLANATION =
  'parsers.parse compila "{param}" a ".+?", que exige al menos un carácter y NUNCA matchea la cadena ' +
  "vacía: un Scenario Outline con una celda vacía en Examples (el caso típico de validación de campos " +
  "obligatorios) falla con StepDefinitionNotFoundError. Usa parsers.re con un grupo con nombre que admita " +
  "el vacío, por ejemplo: " +
  `@when(parsers.re(r'introduzco el correo electrónico "(?P<email>[^"]*)"'))`;

export function checkStepParsers(files: CodeFile[]): CodeCheckResult {
  const matches: string[] = [];

  for (const file of files) {
    file.content.split("\n").forEach((line, index) => {
      if (line.trim().startsWith("#")) return;
      if (PARSE_CALL.test(line) && QUOTED_PARAM.test(line)) {
        matches.push(`${file.path}:${index + 1}: ${EXPLANATION}`);
      }
    });
  }

  return matches.length === 0 ? { ok: true } : { ok: false, errors: matches.join("\n\n") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/codeCheck/stepParserLint.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the real checker**

En `core/src/codeCheck/realCodeChecker.ts`, junto al import existente de `checkLocatorPatterns`:

```ts
import { checkStepParsers } from "./stepParserLint.js";
```

Y justo después del bloque `const locatorResult = ...`:

```ts
        const stepParserResult = checkStepParsers(files);
        if (!stepParserResult.ok && stepParserResult.errors) {
          errors.push(stepParserResult.errors);
        }
```

- [ ] **Step 6: Run the full code-check suite**

Run: `npx vitest run core/src/codeCheck/`
Expected: PASS, sin regresiones.

- [ ] **Step 7: Commit**

```bash
git add core/src/codeCheck/stepParserLint.ts core/src/codeCheck/stepParserLint.test.ts core/src/codeCheck/realCodeChecker.ts
git commit -m "feat(core): reject parsers.parse with quoted params, which never matches empty values"
```

---

### Task 2: El extractor de locators entiende `parsers.re`

**Files:**
- Modify: `core/src/locatorVerify/extractLocatorChecks.ts:79-102` (`STEP_DEF_PATTERN`, `parseStepDefs`, `templateToRegex`)
- Modify: `core/src/locatorVerify/extractLocatorChecks.test.ts` (añadir casos)

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `parseStepTemplate(template: string, kind: "plain" | "parse" | "re"): { regex: RegExp; paramNames: string[] }` — exportada para poder testearla directamente. `ParsedStepDef` pasa a ser `{ template: string; kind: "plain" | "parse" | "re"; body: string }`.

**Por qué esta tarea existe:** sin ella, la Task 1 deja la verificación de locators muda **en silencio** — `STEP_DEF_PATTERN` solo reconoce `parsers.parse(...)` y literales planos, así que en cuanto el generador emita `parsers.re` no se extraerá ni un solo check y todo pasará "verde" sin verificar nada.

- [ ] **Step 1: Write the failing test**

Añadir a `core/src/locatorVerify/extractLocatorChecks.test.ts`:

```ts
  it("extracts checks from a parsers.re step definition", () => {
    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.re(r'veo el mensaje de error "(?P<mensaje_error>[^"]*)"'))
def veo_el_mensaje(login_page, mensaje_error):
    expect(login_page.get_error_message(mensaje_error)).to_be_visible()
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, mensaje_error):
        return self.page.get_by_text(mensaje_error)
`;
    const feature = `Feature: Login
  Scenario: error
    Then veo el mensaje de error "Credenciales inválidas"
`;
    const result = extractLocatorChecks(feature, [
      { path: "tests/test_login.py", content: stepDefs },
      { path: "pages/login_page.py", content: pageObject },
    ]);
    expect(result.checks).toEqual([
      { method: "get_error_message", argument: "Credenciales inválidas" },
    ]);
  });

  it("resolves Scenario Outline rows with empty cells through a parsers.re step", () => {
    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.re(r'veo el mensaje de validación "(?P<mensaje>[^"]*)"'))
def veo_validacion(login_page, mensaje):
    expect(login_page.get_validation_message(mensaje)).to_be_visible()
`;
    const pageObject = `class LoginPage:
    def get_validation_message(self, mensaje):
        return self.page.get_by_text(mensaje)
`;
    const feature = `Feature: Login
  Scenario Outline: validación
    Then veo el mensaje de validación "<mensaje>"

    Examples:
      | mensaje            |
      | Email obligatorio  |
      |                    |
`;
    const result = extractLocatorChecks(feature, [
      { path: "tests/test_login.py", content: stepDefs },
      { path: "pages/login_page.py", content: pageObject },
    ]);
    expect(result.checks).toEqual([
      { method: "get_validation_message", argument: "Email obligatorio" },
      { method: "get_validation_message", argument: "" },
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/extractLocatorChecks.test.ts`
Expected: FAIL — `result.checks` es `[]` en ambos casos nuevos (el patrón no reconoce `parsers.re`).

- [ ] **Step 3: Write the implementation**

Sustituir `STEP_DEF_PATTERN`, `ParsedStepDef`, `parseStepDefs` y `templateToRegex` en `core/src/locatorVerify/extractLocatorChecks.ts` por:

```ts
interface ParsedStepDef {
  template: string;
  kind: "plain" | "parse" | "re";
  body: string;
}

const STEP_DEF_PATTERN =
  /@(?:given|when|then)\(\s*(?:parsers\.parse\(\s*(['"])([\s\S]*?)\1\s*\)|parsers\.re\(\s*r?(['"])([\s\S]*?)\3\s*\)|(['"])([\s\S]*?)\5)\s*\)\s*\r?\ndef\s+[\p{L}\p{N}_]+\([^)]*\):\s*\r?\n((?:[ \t]+.*\r?\n?)*)/gu;

function parseStepDefs(stepDefsSrc: string): ParsedStepDef[] {
  const defs: ParsedStepDef[] = [];
  for (const m of stepDefsSrc.matchAll(STEP_DEF_PATTERN)) {
    const [, , parseTemplate, , reTemplate, , plainTemplate, body] = m;
    if (parseTemplate !== undefined) defs.push({ template: parseTemplate, kind: "parse", body });
    else if (reTemplate !== undefined) defs.push({ template: reTemplate, kind: "re", body });
    else defs.push({ template: plainTemplate, kind: "plain", body });
  }
  return defs;
}

export function parseStepTemplate(
  template: string,
  kind: "plain" | "parse" | "re"
): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];

  if (kind === "re") {
    // The template already IS a regex (Python `re` flavour). Python's named
    // group syntax `(?P<name>...)` is not valid in JS, so rewrite it to a plain
    // capturing group and keep the name. Everything else Playwright-generated
    // step defs use ([^"]*, .*?, character classes) is identical in both flavours.
    const pattern = template.replace(/\(\?P<([\p{L}\p{N}_]+)>/gu, (_, name: string) => {
      paramNames.push(name);
      return "(";
    });
    return { regex: new RegExp(`^${pattern}$`, "u"), paramNames };
  }

  let pattern = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (kind === "parse") {
    // Parameter names can contain unicode letters (Spanish feature text:
    // "contraseña", "categoría") — a plain \w class silently fails to match them.
    pattern = pattern.replace(/\\\{([\p{L}\p{N}_]+)\\\}/gu, (_, name: string) => {
      paramNames.push(name);
      return "(.*?)";
    });
  }
  return { regex: new RegExp(`^${pattern}$`, "u"), paramNames };
}
```

En `extractLocatorChecks`, cambiar el filtro y la llamada:

```ts
  const dynamicStepDefs = parseStepDefs(stepDefsFile.content).filter((d) => d.kind !== "plain");
```

```ts
      const { regex, paramNames } = parseStepTemplate(def.template, def.kind);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/locatorVerify/extractLocatorChecks.test.ts`
Expected: PASS, incluidos todos los casos preexistentes (`parsers.parse` sigue funcionando igual).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: sin salida.

- [ ] **Step 6: Commit**

```bash
git add core/src/locatorVerify/extractLocatorChecks.ts core/src/locatorVerify/extractLocatorChecks.test.ts
git commit -m "feat(core): teach the locator extractor to read parsers.re step definitions"
```

---

### Task 3: Regla de `parsers.re` en el prompt del generador

**Files:**
- Modify: `core/src/prompts/generador.ts` (dentro del texto devuelto por `codeGenerationPrompt`)
- Modify: `core/src/agents/generador/codeGenerator.test.ts` (nuevo test de contenido del prompt)

**Interfaces:**
- Consumes: `codeGenerationPrompt(featureText, matchedPattern, naming, evidence, appLanguage, routes, retry?)` — firma sin cambios.
- Produces: nada nuevo.

- [ ] **Step 1: Write the failing test**

Añadir a `core/src/agents/generador/codeGenerator.test.ts`, siguiendo el estilo del test existente `"instructs the model to pass the step's parsers.parse value unmodified to the paired method"`:

```ts
  it("instructs the model to use parsers.re for quoted step parameters", async () => {
    const llm = new FakeLLMProvider([
      "# FILE: tests/test_x.py\nprint(1)\n# FILE: pages/x_page.py\nprint(2)\n",
    ]);
    await generateCode(
      "Feature: X\n",
      llm,
      null,
      { slug: "x", featureFileName: "x.feature" },
      [],
      "es",
      {}
    );
    const prompt = llm.lastPrompt();
    expect(prompt).toContain("parsers.re");
    expect(prompt).toContain("(?P<");
    expect(prompt).toContain("[^\"]*");
  });
```

Nota para el implementador: usa el mismo helper que ya usan los tests vecinos de ese fichero para leer el prompt enviado (`llm.lastPrompt()` o el equivalente existente en `FakeLLMProvider`); no inventes uno nuevo.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: FAIL — el prompt no contiene `parsers.re`.

- [ ] **Step 3: Write the implementation**

En `core/src/prompts/generador.ts`, insertar este párrafo justo ANTES del párrafo que empieza por `El valor que un step recibe de`:

```ts
  // (dentro del template literal devuelto)
```

Texto a insertar tal cual:

```
Para los parámetros de un step que van entre comillas en el Gherkin, usa SIEMPRE "parsers.re" con un grupo con nombre que admita el valor vacío, nunca la forma con llaves: esa forma exige al menos un carácter y un Scenario Outline con una celda vacía en Examples (validación de campos obligatorios) fallaría con StepDefinitionNotFoundError. Ejemplo:
"""
@when(parsers.re(r'introduzco el correo electrónico "(?P<email>[^"]*)" y la contraseña "(?P<password>[^"]*)"'))
def introduzco_credenciales(login_page, email, password):
    login_page.fill_credentials(email, password)
"""
El nombre del grupo debe coincidir exactamente con el nombre del parámetro de la función.
```

Importante: el párrafo describe la forma prohibida sin escribir la llamada literal `parsers.parse(...)` con un parámetro entrecomillado, para no inducir al modelo a copiarla en un comentario — el lint de la Task 1 ignora comentarios, pero es mejor no provocar el reintento.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/agents/generador/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/generador.ts core/src/agents/generador/codeGenerator.test.ts
git commit -m "feat(core): instruct the generator to use parsers.re for quoted step params"
```

---

## Fase 1 — Agente 1 anclado en la aplicación real

### Task 4: `negativeProbe` en el esquema de patrones

**Files:**
- Modify: `core/src/schemas/pattern.ts:3-6` (`NavigationHintsSchema`)
- Modify: `core/src/patterns/builtin/login.ts:44-47` (`navigationHints`)
- Create: `core/src/schemas/pattern.test.ts` si no existe; si existe, modificarlo

**Interfaces:**
- Consumes: nada.
- Produces: `NavigationHints` gana `negativeProbe?: { kind: "invalid-credentials" }`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/schemas/pattern.test.ts (crear o ampliar)
import { describe, it, expect } from "vitest";
import { PatternSchema } from "./pattern.js";
import { loginPattern } from "../patterns/builtin/login.js";

describe("PatternSchema navigationHints.negativeProbe", () => {
  it("accepts a pattern without negativeProbe (backwards compatible)", () => {
    const parsed = PatternSchema.parse({
      name: "x",
      description: "x",
      gherkinTemplate: "Feature: x\n",
      pageObjectTemplate: "",
      navigationHints: { routeCandidates: ["/"], requiresLogin: false },
    });
    expect(parsed.navigationHints?.negativeProbe).toBeUndefined();
  });

  it("accepts the invalid-credentials probe", () => {
    const parsed = PatternSchema.parse({
      name: "x",
      description: "x",
      gherkinTemplate: "Feature: x\n",
      pageObjectTemplate: "",
      navigationHints: {
        routeCandidates: ["/"],
        requiresLogin: true,
        negativeProbe: { kind: "invalid-credentials" },
      },
    });
    expect(parsed.navigationHints?.negativeProbe?.kind).toBe("invalid-credentials");
  });

  it("declares the probe on the builtin login pattern", () => {
    expect(loginPattern.navigationHints?.negativeProbe?.kind).toBe("invalid-credentials");
  });
});
```

Nota: si el patrón incorporado se exporta con otro nombre, usa el real — comprueba `core/src/patterns/builtin/login.ts` antes de escribir el import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/schemas/pattern.test.ts`
Expected: FAIL — `negativeProbe` se descarta al parsear y es `undefined` en el patrón incorporado.

- [ ] **Step 3: Write the implementation**

```ts
// core/src/schemas/pattern.ts
export const NegativeProbeSchema = z.object({
  kind: z.literal("invalid-credentials"),
});
export type NegativeProbe = z.infer<typeof NegativeProbeSchema>;

export const NavigationHintsSchema = z.object({
  routeCandidates: z.array(z.string()).min(1),
  requiresLogin: z.boolean(),
  negativeProbe: NegativeProbeSchema.optional(),
});
```

```ts
// core/src/patterns/builtin/login.ts — dentro de navigationHints
  navigationHints: {
    routeCandidates: ["/login", "/signin", "/sign-in", "/"],
    requiresLogin: true,
    negativeProbe: { kind: "invalid-credentials" },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/schemas/ core/src/patterns/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/schemas/pattern.ts core/src/patterns/builtin/login.ts core/src/schemas/pattern.test.ts
git commit -m "feat(core): declare an invalid-credentials probe on the builtin login pattern"
```

---

### Task 5: El explorador ejecuta la sonda de credenciales inválidas

**Files:**
- Modify: `core/src/siteExplorer/realSiteExplorer.ts:149-222` (nueva función + llamada dentro de `exploreByHints`)
- Modify: `core/src/siteExplorer/realSiteExplorer.test.ts` (test gated por chromium, siguiendo el estilo del fichero)

**Interfaces:**
- Consumes: `NavigationHints.negativeProbe` (Task 4); `captureEvidence(page, stepText, credentials)`, `LOGIN_FIELD_LABEL`, `PASSWORD_FIELD_LABEL`, `SUBMIT_BUTTON_NAME` (ya existen en el fichero).
- Produces: una `ScreenEvidence` extra con `stepText: "tras un intento de inicio de sesión con credenciales incorrectas"`, insertada entre la pantalla inicial y la post-login.

El fixture de test (`core/src/siteExplorer/testFixtureApp.ts`, modo `"conventional"`) ya pinta un `role="alert"` con el texto `Credenciales inválidas` cuando las credenciales no coinciden. No hay que tocarlo.

- [ ] **Step 1: Write the failing test**

Añadir a `core/src/siteExplorer/realSiteExplorer.test.ts`, dentro del `describe` que ya usa `startFixtureApp("conventional")` y está gated por `chromiumAvailable`:

```ts
  it.skipIf(!chromiumAvailable)(
    "captures a failed-login screen when the pattern declares a negative probe",
    async () => {
      const pattern: Pattern = {
        name: "login",
        description: "login",
        gherkinTemplate: "Feature: Login\n",
        pageObjectTemplate: "",
        navigationHints: {
          routeCandidates: ["/login"],
          requiresLogin: true,
          negativeProbe: { kind: "invalid-credentials" },
        },
      };
      const explorer = createRealSiteExplorer(new FakeLLMProvider([]));
      const result = await explorer.explore(
        baseInput({ baseUrl: app.url, matchedPattern: pattern, credentials: FIXTURE_CREDENTIALS })
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const probe = result.screens.find((s) => s.stepText.includes("credenciales incorrectas"));
      expect(probe).toBeDefined();
      expect(probe?.ariaSnapshot).toContain("Credenciales inválidas");
      // the real login still happened afterwards
      expect(result.screens.some((s) => s.stepText.includes("tras iniciar sesión"))).toBe(true);
      // the probe never leaks the real password
      expect(probe?.ariaSnapshot).not.toContain(FIXTURE_CREDENTIALS.password);
    }
  );
```

Nota: `app` y `baseInput` son el fixture y el helper que ya existen en ese fichero; reúsalos, no crees otros.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/siteExplorer/realSiteExplorer.test.ts`
Expected: FAIL — no hay ninguna pantalla con `"credenciales incorrectas"`. (Si `chromiumAvailable` es `false`, el test se salta: instala los navegadores con `npx playwright install chromium` antes de implementar esta tarea, o el paso 4 no prueba nada.)

- [ ] **Step 3: Write the implementation**

En `core/src/siteExplorer/realSiteExplorer.ts`, justo después de `performRealLogin`:

```ts
// A deliberately wrong password, fixed and never derived from the real one, so
// the probe can never accidentally submit a valid credential. Only ever used
// once per exploration: some apps lock accounts after N failed attempts, which
// is why the probe is opt-in per pattern instead of global.
const INVALID_PROBE_PASSWORD = "agente-qa-invalid-password";

async function performNegativeLoginProbe(
  page: Page,
  credentials: ExplorationCredentials
): Promise<ScreenEvidence | null> {
  const emailField = page.getByLabel(LOGIN_FIELD_LABEL).first();
  const passwordField = page.getByLabel(PASSWORD_FIELD_LABEL).first();
  const submitButton = page.getByRole("button", { name: SUBMIT_BUTTON_NAME }).first();

  if ((await emailField.count()) === 0 || (await passwordField.count()) === 0) {
    return null;
  }

  await emailField.fill(credentials.username);
  await passwordField.fill(INVALID_PROBE_PASSWORD);
  await submitButton.click();
  await page.waitForLoadState("networkidle").catch(() => {});

  return captureEvidence(
    page,
    "tras un intento de inicio de sesión con credenciales incorrectas",
    credentials
  );
}
```

Dentro de `exploreByHints`, en el bloque `if (hints.requiresLogin) { ... }`, justo antes de `const postLogin = await performRealLogin(...)`:

```ts
      if (hints.negativeProbe) {
        onStep("Provocando un error de credenciales para capturar el mensaje real...");
        const probe = await performNegativeLoginProbe(page, input.credentials);
        if (probe) screens.push(probe);
        // back to a clean login screen before the real attempt
        await page.goto(url).catch(() => {});
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/siteExplorer/realSiteExplorer.test.ts`
Expected: PASS, sin regresiones en los demás tests del fichero.

- [ ] **Step 5: Commit**

```bash
git add core/src/siteExplorer/realSiteExplorer.ts core/src/siteExplorer/realSiteExplorer.test.ts
git commit -m "feat(core): capture the real failed-login screen via an opt-in negative probe"
```

---

### Task 6: Caché de evidencia en disco

**Files:**
- Create: `core/src/siteExplorer/evidenceCache.ts`
- Create: `core/src/siteExplorer/evidenceCache.test.ts`

**Interfaces:**
- Consumes: `ScreenEvidence` de `./siteExplorer.js`.
- Produces:
  - `evidenceCacheKey(input: { appUrl: string; patternName: string | null; routes: Record<string, string> }): string`
  - `readCachedEvidence(projectRoot: string, key: string, now?: Date): Promise<ScreenEvidence[] | null>`
  - `writeCachedEvidence(projectRoot: string, key: string, screens: ScreenEvidence[], now?: Date): Promise<void>`
  - `EVIDENCE_CACHE_TTL_MS = 30 * 60 * 1000`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/siteExplorer/evidenceCache.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evidenceCacheKey,
  readCachedEvidence,
  writeCachedEvidence,
  EVIDENCE_CACHE_TTL_MS,
} from "./evidenceCache.js";
import type { ScreenEvidence } from "./siteExplorer.js";

const screens: ScreenEvidence[] = [
  { stepText: "pantalla en /login", url: "https://app.test/login", ariaSnapshot: '- button "Log in"' },
];

let tmpProject: string;

beforeEach(async () => {
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-cache-"));
});
afterEach(async () => {
  await fs.rm(tmpProject, { recursive: true, force: true });
});

describe("evidenceCacheKey", () => {
  it("is stable for the same inputs and different when the app url changes", () => {
    const a = evidenceCacheKey({ appUrl: "https://a.test/", patternName: "login", routes: { home: "/" } });
    const b = evidenceCacheKey({ appUrl: "https://a.test/", patternName: "login", routes: { home: "/" } });
    const c = evidenceCacheKey({ appUrl: "https://b.test/", patternName: "login", routes: { home: "/" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("evidence cache round-trip", () => {
  it("returns null when nothing was cached", async () => {
    expect(await readCachedEvidence(tmpProject, "abc")).toBeNull();
  });

  it("reads back what it wrote", async () => {
    const now = new Date("2026-08-15T10:00:00Z");
    await writeCachedEvidence(tmpProject, "abc", screens, now);
    expect(await readCachedEvidence(tmpProject, "abc", now)).toEqual(screens);
  });

  it("ignores entries older than the TTL", async () => {
    const written = new Date("2026-08-15T10:00:00Z");
    const later = new Date(written.getTime() + EVIDENCE_CACHE_TTL_MS + 1);
    await writeCachedEvidence(tmpProject, "abc", screens, written);
    expect(await readCachedEvidence(tmpProject, "abc", later)).toBeNull();
  });

  it("writes inside .agente-qa/cache and gitignores the whole folder", async () => {
    await writeCachedEvidence(tmpProject, "abc", screens);
    const dir = path.join(tmpProject, ".agente-qa", "cache");
    const entries = await fs.readdir(dir);
    expect(entries).toContain("exploration-abc.json");
    // self-contained: a project initialised before this feature existed never
    // re-runs `init`, so the ignore rule cannot live in .agente-qa/.gitignore
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf-8")).toBe("*\n");
  });

  it("returns null on a corrupted cache file instead of throwing", async () => {
    const dir = path.join(tmpProject, ".agente-qa", "cache");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "exploration-abc.json"), "{not json", "utf-8");
    expect(await readCachedEvidence(tmpProject, "abc")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/siteExplorer/evidenceCache.test.ts`
Expected: FAIL — no se resuelve `./evidenceCache.js`.

- [ ] **Step 3: Write the implementation**

```ts
// core/src/siteExplorer/evidenceCache.ts
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScreenEvidence } from "./siteExplorer.js";

export const EVIDENCE_CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheFile {
  capturedAt: string;
  screens: ScreenEvidence[];
}

export function evidenceCacheKey(input: {
  appUrl: string;
  patternName: string | null;
  routes: Record<string, string>;
}): string {
  const material = JSON.stringify({
    appUrl: input.appUrl,
    patternName: input.patternName,
    routes: Object.keys(input.routes)
      .sort()
      .map((k) => [k, input.routes[k]]),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function cacheDir(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "cache");
}

function cacheFilePath(projectRoot: string, key: string): string {
  return path.join(cacheDir(projectRoot), `exploration-${key}.json`);
}

export async function readCachedEvidence(
  projectRoot: string,
  key: string,
  now: Date = new Date()
): Promise<ScreenEvidence[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(cacheFilePath(projectRoot, key), "utf-8");
  } catch {
    return null;
  }

  let parsed: CacheFile;
  try {
    parsed = JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }

  const capturedAt = Date.parse(parsed.capturedAt ?? "");
  if (Number.isNaN(capturedAt)) return null;
  if (now.getTime() - capturedAt > EVIDENCE_CACHE_TTL_MS) return null;
  if (!Array.isArray(parsed.screens)) return null;

  return parsed.screens;
}

export async function writeCachedEvidence(
  projectRoot: string,
  key: string,
  screens: ScreenEvidence[],
  now: Date = new Date()
): Promise<void> {
  const dirPath = cacheDir(projectRoot);
  // An aria snapshot is real content of the user's app. mode at creation time
  // plus an unconditional chmod: the directory may already exist from an older
  // run created without a mode.
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
  await fs.writeFile(path.join(dirPath, ".gitignore"), "*\n", "utf-8");

  const payload: CacheFile = { capturedAt: now.toISOString(), screens };
  const filePath = cacheFilePath(projectRoot, key);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/siteExplorer/evidenceCache.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/siteExplorer/evidenceCache.ts core/src/siteExplorer/evidenceCache.test.ts
git commit -m "feat(core): cache exploration evidence per project with a 30-minute TTL"
```

---

### Task 7: El prompt de Gherkin recibe la evidencia real

**Files:**
- Modify: `core/src/prompts/intake.ts:37-64` (`gherkinGenerationPrompt`)
- Modify: `core/src/agents/intake/gherkinGenerator.ts:20-42` (`generateGherkin`)
- Modify: `core/src/agents/intake/gherkinGenerator.test.ts`

**Interfaces:**
- Consumes: `ScreenEvidence` de `../siteExplorer/siteExplorer.js`.
- Produces:
  - `gherkinGenerationPrompt(text: string, matchedPattern: { name: string; gherkinTemplate: string } | null, appLanguage: "es" | "en", evidence: ScreenEvidence[]): string`
  - `generateGherkin(text: string, llm: LLMProvider, matchedPattern: Pattern | null, appLanguage: "es" | "en", evidence: ScreenEvidence[]): Promise<GherkinPlan>`

- [ ] **Step 1: Write the failing test**

Añadir a `core/src/agents/intake/gherkinGenerator.test.ts`:

```ts
  it("passes the captured screens into the prompt and forbids inventing literals", async () => {
    const llm = new FakeLLMProvider(["Feature: Login\n  Scenario: x\n    Given y\n"]);
    await generateGherkin("quiero probar el login", llm, null, "es", [
      {
        stepText: "pantalla en /login",
        url: "https://app.test/login",
        ariaSnapshot: '- heading "Welcome back" [level=1]\n- text: Authentication failed. Please try again.',
      },
    ]);
    const prompt = llm.lastPrompt();
    expect(prompt).toContain("Authentication failed. Please try again.");
    expect(prompt).toContain("https://app.test/login");
    expect(prompt).toContain("no lo inventes");
  });

  it("says so explicitly when there is no evidence", async () => {
    const llm = new FakeLLMProvider(["Feature: Login\n  Scenario: x\n    Given y\n"]);
    await generateGherkin("quiero probar el login", llm, null, "es", []);
    expect(llm.lastPrompt()).toContain("No se pudo capturar evidencia");
  });
```

Usa el helper de lectura del prompt que ya exista en `FakeLLMProvider`; no añadas uno nuevo.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/intake/gherkinGenerator.test.ts`
Expected: FAIL — `generateGherkin` acepta 4 argumentos y el prompt no contiene la evidencia.

- [ ] **Step 3: Write the implementation**

En `core/src/prompts/intake.ts`:

```ts
import type { ScreenEvidence } from "../siteExplorer/siteExplorer.js";

export function gherkinGenerationPrompt(
  text: string,
  matchedPattern: { name: string; gherkinTemplate: string } | null,
  appLanguage: "es" | "en",
  evidence: ScreenEvidence[]
): string {
```

Y dentro, antes del `return`:

```ts
  const evidenceSection =
    evidence.length > 0
      ? `Esto es lo que se ha comprobado de verdad en la aplicación real:

${evidence
  .map((screen) => `### ${screen.stepText}\nURL real: ${screen.url}\n"""\n${screen.ariaSnapshot}\n"""`)
  .join("\n\n")}

REGLA OBLIGATORIA sobre los textos esperados: cualquier texto que escribas entre comillas en un paso (títulos, mensajes de error, mensajes de validación, nombres de botones) debe aparecer LITERALMENTE en alguna de esas capturas. Si el texto que necesitas no aparece en ninguna, no lo inventes: escribe el paso sin literal (por ejemplo "veo un mensaje de error" en vez de "veo el mensaje de error \\"...\\""). Un literal inventado hace fallar el test generado y bloquea la generación de código más adelante.`
      : "No se pudo capturar evidencia real de la aplicación: evita escribir textos literales entre comillas que no puedas garantizar, y prefiere pasos sin literal.";
```

Añadir `${evidenceSection}` al cuerpo del prompt devuelto, justo después de `${patternSection}`.

En `core/src/agents/intake/gherkinGenerator.ts`, añadir el parámetro y reenviarlo:

```ts
export async function generateGherkin(
  text: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null,
  appLanguage: "es" | "en",
  evidence: ScreenEvidence[]
): Promise<GherkinPlan> {
  const raw = await llm.generate([
    { role: "system", content: "Eres un analista de QA experto en especificaciones Gherkin." },
    { role: "user", content: gherkinGenerationPrompt(text, matchedPattern, appLanguage, evidence) },
  ]);
```

con `import type { ScreenEvidence } from "../../siteExplorer/siteExplorer.js";` arriba.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/agents/intake/gherkinGenerator.test.ts`
Expected: PASS. `runIntake.test.ts` seguirá roto (llama a `generateGherkin` con la firma vieja) — se arregla en la Task 8; no lo toques aquí.

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/intake.ts core/src/agents/intake/gherkinGenerator.ts core/src/agents/intake/gherkinGenerator.test.ts
git commit -m "feat(core): ground Gherkin literals in captured screen evidence"
```

---

### Task 8: `runIntake` explora antes de generar

**Files:**
- Create: `core/src/patterns/applyProjectRoute.ts`
- Create: `core/src/patterns/applyProjectRoute.test.ts`
- Modify: `core/src/agents/intake/runIntake.ts` (firma completa + exploración)
- Modify: `core/src/agents/intake/runIntake.test.ts`
- Modify: `core/src/index.ts` (exportar el tipo nuevo)

**Interfaces:**
- Consumes: `FakeSiteExplorer` de `../../siteExplorer/testUtils.js`; `evidenceCacheKey`/`readCachedEvidence`/`writeCachedEvidence` (Task 6); `generateGherkin(..., evidence)` (Task 7).
- Produces:
  - `applyProjectRoute(pattern: Pattern | null, routes: Record<string, string>): Pattern | null` — antepone `routes[pattern.name]` a `navigationHints.routeCandidates`, y devuelve el patrón intacto si no tiene `navigationHints` (nunca sintetiza hints desde cero).
  - `RunIntakeOptions` y `runIntake(options: RunIntakeOptions)`:

```ts
export interface RunIntakeOptions {
  initialText: string;
  llm: LLMProvider;
  patterns: Pattern[];
  explorer: SiteExplorer;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  appLanguage: "es" | "en";
  routes: Record<string, string>;
  credentials?: ExplorationCredentials;
  callbacks: IntakeCallbacks;
}
```
  - `IntakeCallbacks` gana `onExplorationStep(message: string): void`.

- [ ] **Step 1: Write the failing test for the route helper**

```ts
// core/src/patterns/applyProjectRoute.test.ts
import { describe, it, expect } from "vitest";
import { applyProjectRoute } from "./applyProjectRoute.js";
import type { Pattern } from "../schemas/pattern.js";

const base: Pattern = {
  name: "login",
  description: "login",
  gherkinTemplate: "Feature: x\n",
  pageObjectTemplate: "",
  navigationHints: { routeCandidates: ["/login"], requiresLogin: true },
};

describe("applyProjectRoute", () => {
  it("prepends the configured route to the candidates", () => {
    const result = applyProjectRoute(base, { login: "/entrar" });
    expect(result?.navigationHints?.routeCandidates).toEqual(["/entrar", "/login"]);
  });

  it("returns the pattern untouched when it has no navigationHints", () => {
    const noHints: Pattern = { ...base, navigationHints: undefined };
    expect(applyProjectRoute(noHints, { login: "/entrar" })).toBe(noHints);
  });

  it("returns the pattern untouched when no route is configured", () => {
    expect(applyProjectRoute(base, {})).toBe(base);
  });

  it("returns null for a null pattern", () => {
    expect(applyProjectRoute(null, { login: "/entrar" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run core/src/patterns/applyProjectRoute.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implement the helper**

```ts
// core/src/patterns/applyProjectRoute.ts
import type { Pattern } from "../schemas/pattern.js";

// Never synthesises navigationHints from scratch: a user-saved pattern without
// hints plus a configured route would produce requiresLogin:false and silently
// skip the real login for a flow that needs it.
export function applyProjectRoute(
  pattern: Pattern | null,
  routes: Record<string, string>
): Pattern | null {
  if (!pattern) return null;
  const route = routes[pattern.name];
  if (!route || !pattern.navigationHints) return pattern;

  return {
    ...pattern,
    navigationHints: {
      ...pattern.navigationHints,
      routeCandidates: [route, ...pattern.navigationHints.routeCandidates],
    },
  };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run core/src/patterns/applyProjectRoute.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for runIntake**

Añadir a `core/src/agents/intake/runIntake.test.ts` (adaptando los tests existentes a la firma por objeto — todos deben pasar a `runIntake({ ... })`):

```ts
  it("explores the app and feeds the evidence into the Gherkin prompt", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({ ambiguous: false, questions: [] }),
      JSON.stringify({ matchedPatternName: null }),
      "Feature: Login\n  Scenario: x\n    Given y\n",
    ]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [
          { stepText: "pantalla en /", url: "https://app.test/", ariaSnapshot: '- heading "Welcome back"' },
        ],
      },
    ]);
    const steps: string[] = [];

    await runIntake({
      initialText: "probar el login",
      llm,
      patterns: [],
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "en",
      routes: {},
      callbacks: { ...callbacks, onExplorationStep: (m) => steps.push(m) },
    });

    expect(llm.lastPrompt()).toContain("Welcome back");
  });

  it("continues without evidence when the exploration fails, and says so", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({ ambiguous: false, questions: [] }),
      JSON.stringify({ matchedPatternName: null }),
      "Feature: Login\n  Scenario: x\n    Given y\n",
    ]);
    const explorer = new FakeSiteExplorer([{ ok: false, error: "la app no responde" }]);
    const steps: string[] = [];

    await runIntake({
      initialText: "probar el login",
      llm,
      patterns: [],
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "en",
      routes: {},
      callbacks: { ...callbacks, onExplorationStep: (m) => steps.push(m) },
    });

    expect(steps.join("\n")).toContain("la app no responde");
    expect(llm.lastPrompt()).toContain("No se pudo capturar evidencia");
  });

  it("reuses cached evidence instead of exploring again", async () => {
    await writeCachedEvidence(
      tmpProject,
      evidenceCacheKey({ appUrl: "https://app.test/", patternName: null, routes: {} }),
      [{ stepText: "cacheada", url: "https://app.test/", ariaSnapshot: '- heading "Desde caché"' }]
    );
    const llm = new FakeLLMProvider([
      JSON.stringify({ ambiguous: false, questions: [] }),
      JSON.stringify({ matchedPatternName: null }),
      "Feature: Login\n  Scenario: x\n    Given y\n",
    ]);
    const explorer = new FakeSiteExplorer([]); // would throw if explored

    await runIntake({
      initialText: "probar el login",
      llm,
      patterns: [],
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "en",
      routes: {},
      callbacks: { ...callbacks, onExplorationStep: () => {} },
    });

    expect(llm.lastPrompt()).toContain("Desde caché");
  });
```

- [ ] **Step 6: Run it and see it fail**

Run: `npx vitest run core/src/agents/intake/runIntake.test.ts`
Expected: FAIL — `runIntake` sigue tomando parámetros posicionales.

- [ ] **Step 7: Implement runIntake**

```ts
// core/src/agents/intake/runIntake.ts — cabecera y arranque
import type { SiteExplorer, ExplorationCredentials, ScreenEvidence } from "../../siteExplorer/siteExplorer.js";
import { evidenceCacheKey, readCachedEvidence, writeCachedEvidence } from "../../siteExplorer/evidenceCache.js";
import { applyProjectRoute } from "../../patterns/applyProjectRoute.js";

export interface IntakeCallbacks {
  askUser(question: string): Promise<string>;
  presentForApproval(plan: GherkinPlan): Promise<{ approved: boolean; feedback?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
  onExplorationStep(message: string): void;
}

export interface RunIntakeOptions {
  initialText: string;
  llm: LLMProvider;
  patterns: Pattern[];
  explorer: SiteExplorer;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  appLanguage: "es" | "en";
  routes: Record<string, string>;
  credentials?: ExplorationCredentials;
  callbacks: IntakeCallbacks;
}

export async function runIntake(
  options: RunIntakeOptions
): Promise<{ plan: GherkinPlan; filePath: string }> {
  const { llm, patterns, explorer, projectRoot, testsDir, baseUrl, appLanguage, routes, credentials, callbacks } =
    options;
  let text = options.initialText;
```

El bloque de ambigüedad queda igual. Tras `const matched = await matchPattern(text, patterns, llm);`, insertar:

```ts
  const patternWithRoute = applyProjectRoute(matched, routes);
  const cacheKey = evidenceCacheKey({ appUrl: baseUrl, patternName: matched?.name ?? null, routes });

  let evidence: ScreenEvidence[] = (await readCachedEvidence(projectRoot, cacheKey)) ?? [];
  if (evidence.length === 0) {
    callbacks.onExplorationStep("Explorando la aplicación real para anclar los textos esperados...");
    const exploration = await explorer.explore(
      {
        featureText: text,
        matchedPattern: patternWithRoute,
        baseUrl,
        credentials,
        headed: false,
      },
      callbacks.onExplorationStep
    );
    if (exploration.ok) {
      evidence = exploration.screens;
      await writeCachedEvidence(projectRoot, cacheKey, evidence);
    } else {
      // Not fatal: the user still reviews and approves the .feature, and the
      // generator's verification blocks later if the literals don't hold up.
      callbacks.onExplorationStep(
        `No se pudo explorar la aplicación (${exploration.error}). Se generará el plan sin evidencia real.`
      );
    }
  }
```

Y las dos llamadas a `generateGherkin(text, llm, matched, appLanguage)` pasan a
`generateGherkin(text, llm, matched, appLanguage, evidence)`.

En `core/src/index.ts`, junto al export existente de `IntakeCallbacks`:

```ts
export type { RunIntakeOptions } from "./agents/intake/runIntake.js";
```

- [ ] **Step 8: Run the intake suite**

Run: `npx vitest run core/src/agents/intake/`
Expected: PASS, incluidos los tests preexistentes ya migrados a la firma por objeto.

- [ ] **Step 9: Typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: sin salida.

- [ ] **Step 10: Commit**

```bash
git add core/src/patterns/applyProjectRoute.ts core/src/patterns/applyProjectRoute.test.ts core/src/agents/intake/runIntake.ts core/src/agents/intake/runIntake.test.ts core/src/index.ts
git commit -m "feat(core): explore the real app during intake and cache the evidence"
```

---

### Task 9: `runGenerador` reutiliza la caché y el helper de rutas

**Files:**
- Modify: `core/src/agents/generador/runGenerador.ts:62-90`
- Modify: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Consumes: `applyProjectRoute`, `evidenceCacheKey`, `readCachedEvidence`, `writeCachedEvidence`.
- Produces: sin cambios de firma pública.

- [ ] **Step 1: Write the failing test**

```ts
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
```

Imports nuevos en ese fichero de test: `evidenceCacheKey` y `writeCachedEvidence` de
`../../siteExplorer/evidenceCache.js`. El resto del andamiaje (`writeFeature`, `callbacks`,
`scriptedResponse`, `loginPattern`, `tmpProject`) ya existe en el fichero: reúsalo.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL — el `FakeSiteExplorer` vacío revienta porque `runGenerador` explora igualmente.

- [ ] **Step 3: Implement**

Sustituir el bloque `const projectRoute = ...` / `const matchedPattern: Pattern | null = ...` (líneas 67-77) por:

```ts
  const matchedPattern = applyProjectRoute(basePattern, routes);
```

Y el bloque de exploración (líneas 82-90) por:

```ts
  const cacheKey = evidenceCacheKey({ appUrl: baseUrl, patternName: basePattern?.name ?? null, routes });
  let evidence = await readCachedEvidence(projectRoot, cacheKey);
  if (!evidence) {
    const exploration = await explorer.explore(
      { featureText, matchedPattern, baseUrl, credentials, headed: true },
      callbacks.onExplorationStep
    );
    if (!exploration.ok) {
      throw new Error(`No se pudo verificar la aplicación real antes de generar el código: ${exploration.error}`);
    }
    evidence = exploration.screens;
    await writeCachedEvidence(projectRoot, cacheKey, evidence);
  }
```

`verificationUrl` se queda como está en esta tarea; la Task 14 lo sustituye.

- [ ] **Step 4: Run the generator suite**

Run: `npx vitest run core/src/agents/generador/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/generador/runGenerador.ts core/src/agents/generador/runGenerador.test.ts
git commit -m "refactor(core): share the route helper and the evidence cache between both agents"
```

---

### Task 10: Cableado del explorador en el comando de intake

**Files:**
- Modify: `cli/src/commands/chat.ts:14-47`
- Modify: `cli/src/commands/chat.e2e.test.ts` si existe y llama a `runIntake`

**Interfaces:**
- Consumes: `RunIntakeOptions` (Task 8).
- Produces: nada nuevo.

El `.gitignore` de la caché ya lo escribe `writeCachedEvidence` (Task 6): no toques
`core/src/config/projectEnv.ts` ni sus tests en esta tarea.

- [ ] **Step 1: Implement**

En `cli/src/commands/chat.ts`, tras `const patterns = await loadAllPatterns(projectRoot);` añadir el explorador y las credenciales igual que hace `generate.ts`:

```ts
  const explorer = createRealSiteExplorer(llm);
  const credentials =
    env.testUsername && env.testPassword ? { username: env.testUsername, password: env.testPassword } : undefined;
  const baseUrl = requireAppUrl(projectConfig);
```

Añadir `onExplorationStep` al objeto `callbacks` existente:

```ts
    onExplorationStep: (message: string) => {
      console.log(message);
    },
```

Y sustituir la llamada:

```ts
  const { filePath } = await runIntake({
    initialText,
    llm,
    patterns,
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

Ampliar los imports de `@agente-qa/core` en ese fichero con `createRealSiteExplorer` y `requireAppUrl`.

- [ ] **Step 2: Build core and typecheck the CLI**

Run: `npm run build --workspace=core && npx tsc -p cli/tsconfig.json --noEmit`
Expected: sin errores. (El `tsc` del CLI necesita `core/dist/` construido — nunca tocar `cli/tsconfig.json` para resolver `@agente-qa/core`.)

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. Si `chat.e2e.test.ts` construye un `IntakeCallbacks` a mano, añádele el `onExplorationStep` nuevo.

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/chat.ts cli/src/commands/chat.e2e.test.ts
git commit -m "feat(cli): wire the site explorer into the intake command"
```

---

## Fase 2 — cierre del bucle de verificación

### Task 11: Pre-chequeo offline de literales contra la evidencia

**Files:**
- Create: `core/src/locatorVerify/checkExpectedLiterals.ts`
- Create: `core/src/locatorVerify/checkExpectedLiterals.test.ts`

**Interfaces:**
- Consumes: `LocatorCheck` de `./locatorVerifier.js`; `ScreenEvidence` de `../siteExplorer/siteExplorer.js`.
- Produces:
  - `checkExpectedLiterals(checks: LocatorCheck[], screens: ScreenEvidence[]): MissingLiteral[]` con `MissingLiteral = { method: string; argument: string; closest: string | null }`
  - `formatMissingLiterals(missing: MissingLiteral[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/locatorVerify/checkExpectedLiterals.test.ts
import { describe, it, expect } from "vitest";
import { checkExpectedLiterals, formatMissingLiterals } from "./checkExpectedLiterals.js";
import type { ScreenEvidence } from "../siteExplorer/siteExplorer.js";

const screens: ScreenEvidence[] = [
  {
    stepText: "pantalla en /",
    url: "https://app.test/",
    ariaSnapshot: `- heading "Welcome back" [level=1]
- button "Log in"
- text: Authentication failed. Please try again.`,
  },
  {
    stepText: "tras iniciar sesión",
    url: "https://app.test/",
    ariaSnapshot: `- heading "Sueño y crecimiento" [level=1]`,
  },
];

describe("checkExpectedLiterals", () => {
  it("accepts a literal present in any screen", () => {
    expect(
      checkExpectedLiterals([{ method: "get_heading", argument: "Sueño y crecimiento" }], screens)
    ).toEqual([]);
  });

  it("ignores case and collapsed whitespace, like Playwright does", () => {
    expect(checkExpectedLiterals([{ method: "get_button", argument: "Log In" }], screens)).toEqual([]);
  });

  it("reports a literal missing from every screen, with the closest real text", () => {
    const missing = checkExpectedLiterals(
      [{ method: "get_heading", argument: "Dream and Growth" }],
      screens
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].argument).toBe("Dream and Growth");
    expect(missing[0].closest).not.toBeNull();
  });

  it("returns nothing when there is no evidence to compare against", () => {
    expect(checkExpectedLiterals([{ method: "get_heading", argument: "lo que sea" }], [])).toEqual([]);
  });

  it("skips empty arguments (Scenario Outline empty cells assert nothing textual)", () => {
    expect(checkExpectedLiterals([{ method: "get_validation_message", argument: "" }], screens)).toEqual(
      []
    );
  });

  it("formats a message naming both the expected and the real text", () => {
    const message = formatMissingLiterals([
      { method: "get_heading", argument: "Dream and Growth", closest: "Sueño y crecimiento" },
    ]);
    expect(message).toContain("Dream and Growth");
    expect(message).toContain("Sueño y crecimiento");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run core/src/locatorVerify/checkExpectedLiterals.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Write the implementation**

```ts
// core/src/locatorVerify/checkExpectedLiterals.ts
import type { LocatorCheck } from "./locatorVerifier.js";
import type { ScreenEvidence } from "../siteExplorer/siteExplorer.js";

export interface MissingLiteral {
  method: string;
  argument: string;
  closest: string | null;
}

// Playwright matches accessible names and text case-insensitively and with
// whitespace collapsed (get_by_role(exact=False), get_by_text). Comparing the
// same way is what makes the feature's "Log In" match the real button "Log in".
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function candidateTexts(screens: ScreenEvidence[]): string[] {
  const found: string[] = [];
  for (const screen of screens) {
    for (const line of screen.ariaSnapshot.split("\n")) {
      for (const quoted of line.matchAll(/"([^"]+)"/g)) found.push(quoted[1]);
      const text = line.match(/text:\s*(.+)$/);
      if (text) found.push(text[1].trim());
    }
  }
  return found;
}

function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i++) grams.push(value.slice(i, i + 2));
  return grams;
}

// Dice coefficient over character bigrams: enough to point at the real text in
// an error message, and needs no new dependency.
function similarity(a: string, b: string): number {
  const left = bigrams(normalize(a));
  const right = bigrams(normalize(b));
  if (left.length === 0 || right.length === 0) return 0;
  const pool = [...right];
  let hits = 0;
  for (const gram of left) {
    const index = pool.indexOf(gram);
    if (index >= 0) {
      hits++;
      pool.splice(index, 1);
    }
  }
  return (2 * hits) / (left.length + right.length);
}

export function checkExpectedLiterals(
  checks: LocatorCheck[],
  screens: ScreenEvidence[]
): MissingLiteral[] {
  if (screens.length === 0) return [];

  const haystack = screens.map((screen) => normalize(screen.ariaSnapshot));
  const candidates = candidateTexts(screens);
  const missing: MissingLiteral[] = [];

  for (const check of checks) {
    const needle = normalize(check.argument);
    if (needle.length === 0) continue;
    if (haystack.some((snapshot) => snapshot.includes(needle))) continue;

    let closest: string | null = null;
    let best = 0;
    for (const candidate of candidates) {
      const score = similarity(check.argument, candidate);
      if (score > best) {
        best = score;
        closest = candidate;
      }
    }
    missing.push({ method: check.method, argument: check.argument, closest: best >= 0.2 ? closest : null });
  }

  return missing;
}

export function formatMissingLiterals(missing: MissingLiteral[]): string {
  return missing
    .map((item) => {
      const suggestion = item.closest
        ? ` El texto real más parecido en la aplicación es "${item.closest}": usa ese, o reescribe el paso sin literal.`
        : " No hay ningún texto parecido en la aplicación: reescribe el paso sin literal.";
      return `El archivo .feature espera el texto "${item.argument}" (locator ${item.method}), que no aparece en ninguna de las pantallas verificadas de la aplicación real.${suggestion}`;
    })
    .join("\n\n");
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run core/src/locatorVerify/checkExpectedLiterals.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/checkExpectedLiterals.ts core/src/locatorVerify/checkExpectedLiterals.test.ts
git commit -m "feat(core): check expected literals against captured evidence offline"
```

---

### Task 12: Verificación de locators contra todas las pantallas

**Files:**
- Modify: `core/src/locatorVerify/locatorVerifier.ts:15-22` (interfaz)
- Modify: `core/src/locatorVerify/buildVerificationScript.ts`
- Modify: `core/src/locatorVerify/buildVerificationScript.test.ts`
- Modify: `core/src/locatorVerify/realLocatorVerifier.ts:68-118`
- Modify: `core/src/locatorVerify/testUtils.ts` (el verificador falso, si su firma menciona `baseUrl`)

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `LocatorVerifier.verify(files, checks, urls: string[], credentials)` — `baseUrl: string` pasa a `urls: string[]`. `buildVerificationScript(files, checks, urls: string[])`.

- [ ] **Step 1: Write the failing test**

Añadir a `core/src/locatorVerify/buildVerificationScript.test.ts`:

```ts
  it("embeds every url to check against", () => {
    const script = buildVerificationScript(
      [{ path: "pages/x_page.py", content: "class X:\n    pass\n" }],
      [{ method: "get_heading", argument: "Panel" }],
      ["https://app.test/login", "https://app.test/dashboard"]
    );
    expect(script).toContain('"https://app.test/login"');
    expect(script).toContain('"https://app.test/dashboard"');
    expect(script).toContain("URLS =");
  });

  it("waits for networkidle with a short timeout instead of blocking on goto", () => {
    const script = buildVerificationScript([], [{ method: "get_x", argument: "y" }], ["https://app.test/"]);
    expect(script).toContain('wait_until="load"');
    expect(script).toContain("wait_for_load_state");
    expect(script).toContain("timeout=3000");
  });
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run core/src/locatorVerify/buildVerificationScript.test.ts`
Expected: FAIL — la función toma un `baseUrl` string y usa `wait_until="networkidle"`.

- [ ] **Step 3: Implement the script builder**

```ts
// core/src/locatorVerify/buildVerificationScript.ts
export function buildVerificationScript(
  files: GeneratedFile[],
  checks: LocatorCheck[],
  urls: string[]
): string {
  const pageObjectFile = files.find((f) => f.path.startsWith("pages/"));
  const pageObjectPath = pageObjectFile ? pageObjectFile.path : "";

  return `import importlib.util
import inspect
import json

from playwright.sync_api import sync_playwright

URLS = ${JSON.stringify(urls, null, 2)}
CHECKS = ${JSON.stringify(checks, null, 2)}
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
    results = [
        {"method": check["method"], "argument": check["argument"], "count": 0, "matches": []}
        for check in CHECKS
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        classes = load_page_object_classes(PAGE_OBJECT_PATH)
        instances = []
        for cls in classes:
            try:
                instances.append(cls(page))
            except Exception:
                pass

        for url in URLS:
            # networkidle as a goto condition hangs for the full 30s default on
            # apps with a persistent connection (websockets, chat widgets,
            # analytics). Load first, then give the hydration a short window.
            page.goto(url, wait_until="load")
            try:
                page.wait_for_load_state("networkidle", timeout=3000)
            except Exception:
                pass

            for index, check in enumerate(CHECKS):
                method_name = check["method"]
                argument = check["argument"]
                target = None
                for instance in instances:
                    if hasattr(instance, method_name):
                        target = getattr(instance, method_name)
                        break
                if target is None:
                    results[index]["error"] = (
                        f"no se encontro el metodo {method_name} en ningun Page Object generado"
                    )
                    continue

                try:
                    locator = target(argument)
                    count = locator.count()
                    if count > results[index]["count"]:
                        results[index]["count"] = count
                        matches = []
                        if count != 1:
                            for element in locator.all()[:5]:
                                try:
                                    matches.append(element.evaluate("el => el.outerHTML")[:200])
                                except Exception:
                                    matches.append("<no se pudo leer outerHTML>")
                        results[index]["matches"] = matches
                except Exception as e:
                    results[index]["error"] = f"error al verificar el locator: {e}"

        browser.close()

    for entry in results:
        print(json.dumps(entry))


if __name__ == "__main__":
    main()
`;
}
```

- [ ] **Step 4: Update the interface and the real verifier**

```ts
// core/src/locatorVerify/locatorVerifier.ts
export interface LocatorVerifier {
  verify(
    files: GeneratedFile[],
    checks: LocatorCheck[],
    urls: string[],
    credentials: ExplorationCredentials | undefined
  ): Promise<LocatorVerificationResult>;
}
```

En `core/src/locatorVerify/realLocatorVerifier.ts`: la firma pasa a `urls: string[]`, la variable de entorno usa la primera URL (`AGENTE_QA_APP_URL: urls[0] ?? ""`) y la llamada al builder pasa `urls`.

- [ ] **Step 5: Run the locatorVerify suite**

Run: `npx vitest run core/src/locatorVerify/`
Expected: PASS. Si `runGenerador.ts` deja de compilar por la firma, arréglalo pasando `[verificationUrl]` de momento; la Task 14 lo sustituye por todas las URLs.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: sin salida.

- [ ] **Step 7: Commit**

```bash
git add core/src/locatorVerify/
git commit -m "feat(core): verify locators against every captured screen, not just the first"
```

---

### Task 13: `count === 0` vuelve a ser fallo

**Files:**
- Modify: `core/src/locatorVerify/realLocatorVerifier.ts:60-62,119-138` (`formatUnverified` y la clasificación)
- Modify: `core/src/locatorVerify/realLocatorVerifier.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `LocatorVerificationResult.warnings` deja de usarse para `count === 0`; el campo se mantiene en el tipo (lo usan otros avisos).

- [ ] **Step 1: Write the failing test**

Sustituir en `core/src/locatorVerify/realLocatorVerifier.test.ts` el test de la línea 123
(`"reports ok:true with a warning (not a failure) when a locator resolves to 0 elements on
the initial screen"`) por su inverso, conservando el mismo andamiaje de fichero HTML local:

```ts
    it("reports ok:false when a locator resolves to 0 elements on every verified screen", async () => {
      // With the intake now grounded in real evidence and the offline literal
      // pre-check running first, a locator matching nothing everywhere is a real
      // defect, not the "appears only after an action" case it used to be.
      const htmlPath = path.join(tmpDir, "index.html");
      await fs.writeFile(
        htmlPath,
        "<!doctype html><html><body>" + '<button type="button">Menu</button>' + "</body></html>",
        "utf-8"
      );
      const baseUrl = pathToFileURL(htmlPath).toString();

      const result = await realLocatorVerifier.verify(
        generatedFiles(),
        [{ method: "get_button", argument: "Log in" }],
        [baseUrl],
        undefined
      );

      expect(result.ok).toBe(false);
      expect(result.errors).toContain("get_button");
      expect(result.errors).toContain("0 elementos");
    }, 20000);
```

Los demás tests de ese fichero pasan su `baseUrl` a `[baseUrl]` (cambio de firma de la Task 12).

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run core/src/locatorVerify/realLocatorVerifier.test.ts`
Expected: FAIL — hoy devuelve `{ ok: true, warnings }`.

- [ ] **Step 3: Implement**

Sustituir `formatUnverified` por:

```ts
function formatNotFound(entry: VerificationEntry): string {
  return `El locator ${entry.method}(${JSON.stringify(entry.argument)}) no encontró ningún elemento (0 elementos) en ninguna de las pantallas verificadas de la aplicación real. O el texto esperado no existe en la aplicación, o el locator es incorrecto: corrige el que corresponda.`;
}
```

Y en el bucle de clasificación:

```ts
          if (entry.error) {
            failures.push(formatFailure(entry));
          } else if (entry.count === 0) {
            failures.push(formatNotFound(entry));
          } else if (entry.count !== 1) {
            failures.push(formatFailure(entry));
          }
```

Eliminar el array `warnings` si queda sin uso y ajustar el `return` final a `failures.length > 0 ? { ok: false, errors: failures.join("\n\n") } : { ok: true }`.

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run core/src/locatorVerify/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/realLocatorVerifier.ts core/src/locatorVerify/realLocatorVerifier.test.ts
git commit -m "fix(core): treat a locator matching nothing as a real failure again"
```

---

### Task 14: `runGenerador` integra el pre-chequeo y todas las URLs

**Files:**
- Modify: `core/src/agents/generador/runGenerador.ts:90,108-128`
- Modify: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Consumes: `checkExpectedLiterals`, `formatMissingLiterals` (Task 11); `verify(..., urls, ...)` (Task 12).
- Produces: sin cambios de firma pública.

**Decisión de diseño que el implementador NO debe cambiar:** un literal ausente aborta al
instante, sin gastar reintentos. El bucle de reintento regenera código Python, pero el
literal vive en el `.feature` — el argumento del check sería idéntico en los cuatro
intentos, y la única salida que le quedaría al modelo es dejar de pasar el literal a un
`get_*`, es decir, debilitar la aserción para aprobar la verificación.

- [ ] **Step 1: Write the failing test**

```ts
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
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [
          { stepText: "login", url: "https://example.com/login", ariaSnapshot: "- button \"Log in\"" },
          { stepText: "panel", url: "https://example.com/panel", ariaSnapshot: "- heading \"Panel\"" },
        ],
      },
    ]);
    const verifier = new FakeLocatorVerifier([]);

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

    // FakeLocatorVerifier records the urls it was called with; if it exposes no
    // such accessor yet, add one alongside its existing recording fields.
    expect(verifier.lastUrls).toEqual(["https://example.com/login", "https://example.com/panel"]);
  });
```

Si `FakeLLMProvider` no expone `callCount()` ni `FakeLocatorVerifier` un `lastUrls`, añádelos
a `core/src/llm/testUtils.ts` y `core/src/locatorVerify/testUtils.ts` junto a los accesores
que ya tengan; no crees dobles nuevos.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL — no existe el pre-chequeo, la generación acepta el literal inventado y el verificador recibe una sola URL.

- [ ] **Step 3: Implement**

Sustituir `const verificationUrl = evidence[0]?.url ?? baseUrl;` por:

```ts
  const verificationUrls = evidence.length > 0 ? evidence.map((screen) => screen.url) : [baseUrl];
```

Y dentro del bucle, entre `const { checks, skipped } = extractLocatorChecks(...)` y la llamada al verificador:

```ts
    // A missing literal is never retryable: the value comes from the .feature,
    // so all four attempts would produce the identical check. The only way the
    // model could "pass" is by no longer passing the literal to a get_* method
    // — weakening the assertion to satisfy the verifier. Fail fast instead.
    const missingLiterals = checkExpectedLiterals(checks, evidence);
    if (missingLiterals.length > 0) {
      throw new Error(
        `El archivo .feature espera textos que no existen en la aplicación real:\n\n${formatMissingLiterals(
          missingLiterals
        )}\n\nCorrige el archivo .feature (o vuelve a crear el plan de pruebas, que ahora se genera a partir de la aplicación real) y repite la generación.`
      );
    }
```

Y la llamada al verificador pasa `verificationUrls`.

- [ ] **Step 4: Run the generator suite**

Run: `npx vitest run core/src/agents/generador/`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run && npx tsc -p core/tsconfig.json --noEmit`
Expected: PASS y sin salida de `tsc`.

- [ ] **Step 6: Commit**

```bash
git add core/src/agents/generador/runGenerador.ts core/src/agents/generador/runGenerador.test.ts
git commit -m "feat(core): block generation when a feature literal is absent from the real app"
```

---

## Fase 3 — credenciales sin literales que mienten

### Task 15: Convención de credenciales de prueba

**Files:**
- Create: `core/src/codeCheck/credentialLint.ts`
- Create: `core/src/codeCheck/credentialLint.test.ts`
- Modify: `core/src/codeCheck/realCodeChecker.ts`
- Modify: `core/src/prompts/intake.ts` (regla en `gherkinGenerationPrompt`)
- Modify: `core/src/prompts/generador.ts` (regla en el párrafo de `os.environ`)

**Interfaces:**
- Consumes: `CodeFile`, `CodeCheckResult`.
- Produces: `checkCredentialSubstitution(files: CodeFile[]): CodeCheckResult`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/codeCheck/credentialLint.test.ts
import { describe, it, expect } from "vitest";
import { checkCredentialSubstitution } from "./credentialLint.js";

describe("checkCredentialSubstitution", () => {
  it("rejects picking a credential by comparing against a literal", () => {
    const result = checkCredentialSubstitution([
      {
        path: "pages/login_page.py",
        content:
          'actual_email = os.environ.get("AGENTE_QA_TEST_USERNAME", email) if email == "user@example.com" else email\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:1");
  });

  it("accepts reading the credential unconditionally", () => {
    const result = checkCredentialSubstitution([
      { path: "pages/login_page.py", content: 'email = os.environ["AGENTE_QA_TEST_USERNAME"]\n' },
    ]);
    expect(result.ok).toBe(true);
  });

  it("ignores comments", () => {
    const result = checkCredentialSubstitution([
      { path: "pages/login_page.py", content: '# no hagas os.environ[...] if x == "y"\n' },
    ]);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run core/src/codeCheck/credentialLint.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implement**

```ts
// core/src/codeCheck/credentialLint.ts
import type { CodeFile, CodeCheckResult } from "./codeChecker.js";

const ENV_READ = /os\.environ/;
const LITERAL_COMPARISON = /==\s*['"]/;

const EXPLANATION =
  "Elegir una credencial comparando un valor del Gherkin con un literal hace que el .feature diga una cosa " +
  "y el test haga otra en silencio. Lee la credencial siempre de forma incondicional " +
  '(os.environ["AGENTE_QA_TEST_USERNAME"] / os.environ["AGENTE_QA_TEST_PASSWORD"]) en el método que ejecuta ' +
  "el login con la cuenta de prueba, y deja los valores literales del Gherkin para los casos con credenciales " +
  "inválidas, que sí son datos del escenario.";

export function checkCredentialSubstitution(files: CodeFile[]): CodeCheckResult {
  const matches: string[] = [];

  for (const file of files) {
    file.content.split("\n").forEach((line, index) => {
      if (line.trim().startsWith("#")) return;
      if (ENV_READ.test(line) && LITERAL_COMPARISON.test(line)) {
        matches.push(`${file.path}:${index + 1}: ${EXPLANATION}`);
      }
    });
  }

  return matches.length === 0 ? { ok: true } : { ok: false, errors: matches.join("\n\n") };
}
```

Fusionarlo en `createRealCodeChecker` igual que los otros dos lints.

- [ ] **Step 4: Add the prompt rules**

En `gherkinGenerationPrompt` (`core/src/prompts/intake.ts`), añadir al final del cuerpo:

```
Para los escenarios que inician sesión con una cuenta válida, NO escribas el correo ni la contraseña como texto literal: escribe un paso sin datos, por ejemplo "Cuando introduzco las credenciales de la cuenta de prueba". El código generado leerá esas credenciales de la configuración del proyecto. Las credenciales inválidas (para probar el error de login) sí se escriben literales: no son secretos y forman parte del escenario.
```

En `codeGenerationPrompt` (`core/src/prompts/generador.ts`), ampliar el párrafo que ya habla de `os.environ` con:

```
Lee esas variables de forma incondicional en el método que ejecuta el login con la cuenta de prueba. Nunca decidas qué credencial usar comparando un valor recibido del Gherkin con un literal (nada de "if email == ..."): el paso de credenciales válidas no lleva datos, y los valores literales del Gherkin son siempre datos reales del escenario.
```

- [ ] **Step 5: Run the suite**

Run: `npx vitest run core/src/codeCheck/ core/src/agents/intake/ core/src/agents/generador/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/src/codeCheck/credentialLint.ts core/src/codeCheck/credentialLint.test.ts core/src/codeCheck/realCodeChecker.ts core/src/prompts/intake.ts core/src/prompts/generador.ts
git commit -m "feat(core): stop swapping credentials by comparing Gherkin literals"
```

---

## Verificación final (la ejecuta el controlador, no un subagente)

- [ ] **Step 1: Suite completa y typecheck de ambos paquetes**

```bash
npx vitest run
npx tsc -p core/tsconfig.json --noEmit
npm run build --workspace=core && npx tsc -p cli/tsconfig.json --noEmit
```

- [ ] **Step 2: Regenerar los tests del proyecto consumidor**

En `C:\GitHub\QA_Testing`, borrar el `.feature`, el `tests/` y el `pages/` generados, y volver a ejecutar el flujo completo del CLI (crear plan → generar tests) contra `https://babia-nav.vercel.app/`.

- [ ] **Step 3: Ejecutar pytest y comprobar la condición de "hecho"**

```bash
python -m pytest
```

Esperado: 5/5 en verde, o un bloqueo explícito durante la generación que nombre el escenario que la aplicación no puede satisfacer. Cualquier otro resultado es un fallo del plan, no del entorno: volver a Fase 1 de `systematic-debugging` con la salida en la mano.

- [ ] **Step 4: Review final de rama**

Despachar la review final de rama con el modelo más capaz sobre el conjunto de las 15 tareas. En este repo es la única red que ha atrapado los fallos "en agregado" — cinco veces ya. No saltarla aunque cada tarea individual haya salido limpia.

- [ ] **Step 5: Actualizar `memory.md` y borrar el ledger**

Añadir la entrada de resultado, borrar `.superpowers/sdd/2026-08-15-gherkin-grounding-verification/progress.md`.
