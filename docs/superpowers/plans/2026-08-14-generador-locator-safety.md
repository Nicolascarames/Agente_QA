# Guardrail contra locators frágiles en Agente 2 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evitar que el código Playwright generado por Agente 2 combine estrategias de locator con `.or_()` (patrón que causó un `strict mode violation` real contra una app en producción), tanto guiando al LLM en el prompt como bloqueándolo con una comprobación estática que reusa el bucle de reintento ya existente.

**Architecture:** Nueva función pura `checkLocatorPatterns(files)` en `core/src/codeCheck/locatorLint.ts` que escanea texto por línea buscando `.or_(`; se fusiona dentro de `createRealCodeChecker.check()` junto a `py_compile`/`ruff` (mismo array `errors`, mismo contrato `CodeCheckResult`). El prompt de generación (`codeGenerationPrompt`) gana un párrafo de guardrail. Cero interfaces nuevas, cero cambios de firma en `runGenerador`/`generateCode`/`CodeChecker`.

**Tech Stack:** TypeScript (core, sin I/O de terminal), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-generador-locator-safety-design.md`

## Global Constraints

- Imports relativos con sufijo `.js` aunque el fichero sea `.ts` (ESM NodeNext) — en todo import nuevo.
- `checkLocatorPatterns` debe ser puro: sin `fs`, sin `spawn`, sin proceso externo — no puede lanzar.
- No cambiar la firma pública de `CodeChecker.check()`, `runGenerador`, ni `generateCode` — la integración es interna a `realCodeChecker.ts` y `generador.ts` (prompt).
- Test runner: `npx vitest run` (o `npm test`) desde la raíz del repo.
- `tsc` limpio en `core`: `npx tsc -p core/tsconfig.json --noEmit`.
- Mensajes de error/feedback dirigidos al LLM (no al usuario final del CLI) pueden ir en castellano, igual que el resto de `codeChecker`/`generador.ts` ya existente — mantener el idioma consistente con el fichero que se edita.

---

### Task 1: `checkLocatorPatterns` — lint puro de `.or_()`

**Files:**
- Create: `core/src/codeCheck/locatorLint.ts`
- Test: `core/src/codeCheck/locatorLint.test.ts`

**Interfaces:**
- Consumes: `CodeFile`, `CodeCheckResult` (tipos ya existentes en `core/src/codeCheck/codeChecker.ts`).
- Produces: `checkLocatorPatterns(files: CodeFile[]): CodeCheckResult` — usado por Task 2.

- [ ] **Step 1: Write the failing test**

Crea `core/src/codeCheck/locatorLint.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { checkLocatorPatterns } from "./locatorLint.js";

describe("checkLocatorPatterns", () => {
  it("reports ok:true when no file contains .or_(", () => {
    const result = checkLocatorPatterns([
      { path: "pages/login_page.py", content: 'self.password_input = page.get_by_label("Contraseña")\n' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("reports ok:false with file and line number when .or_( appears", () => {
    const result = checkLocatorPatterns([
      {
        path: "pages/login_page.py",
        content:
          "class LoginPage:\n" +
          "    def __init__(self, page):\n" +
          '        self.password_input = page.get_by_placeholder("Your password").or_(page.get_by_label("Password"))\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:3:");
    expect(result.errors).toContain(".or_()");
  });

  it("only flags the offending file when multiple files are checked", () => {
    const result = checkLocatorPatterns([
      { path: "tests/test_login.py", content: "def test_login():\n    pass\n" },
      {
        path: "pages/login_page.py",
        content: 'self.x = page.get_by_role("button").or_(page.get_by_text("x"))\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:1:");
    expect(result.errors).not.toContain("tests/test_login.py");
  });

  it("reports every occurrence when the pattern appears more than once", () => {
    const result = checkLocatorPatterns([
      {
        path: "pages/login_page.py",
        content:
          'self.a = page.get_by_role("a").or_(page.get_by_text("a"))\n' +
          'self.b = page.get_by_role("b").or_(page.get_by_text("b"))\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:1:");
    expect(result.errors).toContain("pages/login_page.py:2:");
  });

  it("reproduces the real bug found testing against a live app (password toggle button collision)", () => {
    const buggyPageObject =
      "class LoginPage:\n" +
      "    def __init__(self, page):\n" +
      "        self.page = page\n" +
      '        self.password_input = page.get_by_placeholder("Your password").or_(page.get_by_label("Password"))\n' +
      "\n" +
      "    def login(self, email, password):\n" +
      "        self.password_input.fill(password)\n";

    const result = checkLocatorPatterns([{ path: "pages/login_page.py", content: buggyPageObject }]);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/codeCheck/locatorLint.test.ts`
Expected: FAIL — `Cannot find module './locatorLint.js'` (o similar, el fichero de implementación no existe todavía).

- [ ] **Step 3: Write minimal implementation**

Crea `core/src/codeCheck/locatorLint.ts`:

```typescript
import type { CodeFile, CodeCheckResult } from "./codeChecker.js";

const LOCATOR_OR_PATTERN = /\.or_\(/;

const EXPLANATION =
  '".or_()" combina varias estrategias de locator y puede resolver a más de un elemento real ' +
  '(ejemplo real: un botón "mostrar/ocultar contraseña" con aria-label que también contiene la palabra ' +
  '"password" colisiona con el locator del campo). Usa una única estrategia de locator precisa para este ' +
  'elemento (rol + nombre accesible exacto, get_by_test_id si la evidencia lo muestra, o un selector de ' +
  "atributo/CSS específico) en vez de combinar varias con .or_().";

export function checkLocatorPatterns(files: CodeFile[]): CodeCheckResult {
  const matches: string[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, index) => {
      if (LOCATOR_OR_PATTERN.test(line)) {
        matches.push(`${file.path}:${index + 1}: ${EXPLANATION}`);
      }
    });
  }

  return matches.length === 0 ? { ok: true } : { ok: false, errors: matches.join("\n\n") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/codeCheck/locatorLint.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/codeCheck/locatorLint.ts core/src/codeCheck/locatorLint.test.ts
git commit -m "feat(core): add pure lint for ambiguous .or_() locator combinators"
```

---

### Task 2: Fusionar `checkLocatorPatterns` en `createRealCodeChecker`

**Files:**
- Modify: `core/src/codeCheck/realCodeChecker.ts`
- Test: `core/src/codeCheck/realCodeChecker.test.ts`

**Interfaces:**
- Consumes: `checkLocatorPatterns(files: CodeFile[]): CodeCheckResult` (Task 1).
- Produces: sin cambios de firma pública — `createRealCodeChecker`/`realCodeChecker` siguen implementando `CodeChecker` exactamente igual.

- [ ] **Step 1: Write the failing test**

En `core/src/codeCheck/realCodeChecker.test.ts`, añade este `it` dentro del bloque `describe.skipIf(!hasPython || !hasRuff)("realCodeChecker (requires Python + ruff on PATH)", ...)` ya existente (después del test `"reports ok:false with a syntax error"`):

```typescript
  it("reports ok:false when the generated code combines locators with .or_(", async () => {
    const result = await realCodeChecker.check([
      {
        path: "pages/login_page.py",
        content:
          "class LoginPage:\n" +
          "    def __init__(self, page):\n" +
          '        self.password_input = page.get_by_placeholder("Your password").or_(page.get_by_label("Password"))\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(".or_()");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/codeCheck/realCodeChecker.test.ts`
Expected: FAIL — `result.ok` es `true` (el checker actual solo mira `py_compile`/`ruff`, y este código es válido para ambos).

- [ ] **Step 3: Write minimal implementation**

En `core/src/codeCheck/realCodeChecker.ts`:

Añade el import junto a los demás, arriba del fichero:

```typescript
import { checkLocatorPatterns } from "./locatorLint.js";
```

Dentro de `check()`, justo después del bloque de `ruff` y antes del `return errors.length === 0 ...` (línea 87-92 actual):

```typescript
        const lint = await runOrThrowMissing(ruffCommand, ["check", tmpDir], tmpDir, "ruff");
        if (lint.code !== 0) {
          errors.push(lint.stdout || lint.stderr);
        }

        const locatorResult = checkLocatorPatterns(files);
        if (!locatorResult.ok && locatorResult.errors) {
          errors.push(locatorResult.errors);
        }

        return errors.length === 0 ? { ok: true } : { ok: false, errors: errors.join("\n\n") };
```

(Reemplaza el bloque `return errors.length === 0 ...` existente por este, que añade las tres líneas de `locatorResult` antes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/codeCheck/realCodeChecker.test.ts`
Expected: PASS (todos los tests del fichero, incluido el nuevo).

- [ ] **Step 5: Commit**

```bash
git add core/src/codeCheck/realCodeChecker.ts core/src/codeCheck/realCodeChecker.test.ts
git commit -m "fix(core): reject generated code that combines locators with .or_("
```

---

### Task 3: Guardrail en `codeGenerationPrompt`

**Files:**
- Modify: `core/src/prompts/generador.ts`
- Test: `core/src/agents/generador/codeGenerator.test.ts`

**Interfaces:**
- Consumes: ninguna nueva — modifica el string devuelto por `codeGenerationPrompt(...)`, ya consumido por `generateCode` (`core/src/agents/generador/codeGenerator.ts`).
- Produces: sin cambios de firma.

- [ ] **Step 1: Write the failing test**

En `core/src/agents/generador/codeGenerator.test.ts`, añade este `it` dentro del `describe("generateCode", ...)` existente (junto a los demás tests de contenido del prompt):

```typescript
  it("instructs the model to avoid ambiguous .or_() locator combinators", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, []);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain(".or_()");
    expect(userMessage?.content).toContain("get_by_test_id");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: FAIL — el prompt actual no contiene `.or_()` ni `get_by_test_id`.

- [ ] **Step 3: Write minimal implementation**

En `core/src/prompts/generador.ts`, dentro del template string devuelto por `codeGenerationPrompt`, añade un párrafo nuevo justo después del párrafo de `pytest-playwright`/fixture `page` (la línea que empieza `El proyecto ya tiene instalado el plugin "pytest-playwright"...`, línea 64) y antes del párrafo de variables de entorno (línea 66):

```typescript
El proyecto ya tiene instalado el plugin "pytest-playwright": el fixture "page" (una página de navegador ya lista) está disponible automáticamente en cualquier test, no lo definas tú ni escribas ningún conftest.py.

Para los locators de Playwright, usa siempre una única estrategia precisa por elemento (rol + nombre accesible exacto, o "get_by_test_id" si la evidencia lo muestra) — nunca combines varias estrategias con ".or_()": puede resolver a más de un elemento real y romper en modo estricto (ejemplo real: un botón "mostrar/ocultar contraseña" cuyo "aria-label" también contiene la palabra "contraseña"/"password" colisiona con el locator del campo).

La URL de la aplicación bajo test y las credenciales de una cuenta de prueba NUNCA se escriben como texto literal en este código...
```

(Inserta el párrafo nuevo entre los dos ya existentes, sin tocar su texto.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: PASS (todos los tests del fichero, incluido el nuevo).

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/generador.ts core/src/agents/generador/codeGenerator.test.ts
git commit -m "feat(core): tell the code-generation prompt to avoid ambiguous .or_() locators"
```

---

## Final Verification (tras las 3 tareas)

- [ ] `npx vitest run` completo en verde (repo entero, no solo los ficheros tocados).
- [ ] `npx tsc -p core/tsconfig.json --noEmit` limpio.
- [ ] Review final de rama (`superpowers:finishing-a-development-branch` o revisión manual de los 3 diffs juntos) — el patrón del proyecto (ver `memory.md`) es que los fallos "en agregado" solo los pilla esta pasada final, nunca las reviews de tarea individual.
