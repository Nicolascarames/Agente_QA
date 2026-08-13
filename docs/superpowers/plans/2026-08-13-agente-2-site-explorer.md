# Agente 2 — Site Explorer (descubrimiento real de rutas y localizadores) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before Agente 2 (Generador) writes any code, verify routes and locators against the real running application (headed browser, real login when needed) so generated selectors are grounded in truth instead of guessed from a static template.

**Architecture:** New `core/src/siteExplorer/` module providing an injectable `SiteExplorer` (same DI pattern as `CodeChecker`/`TestRunner`: interface + `FakeSiteExplorer` + `realSiteExplorer`). The real implementation is hybrid: a cheap "known route" fast path using each built-in pattern's new `navigationHints`, escalating to an LLM-guided step-by-step browser session only when the fast path fails or no pattern matched. `runGenerador` calls the explorer once per generation (not per lint retry) and aborts immediately — before ever calling the LLM for code — if exploration fails.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Vitest, Playwright (Node package, new dependency of `core` — distinct from the Python `pytest-playwright` used by generated tests), existing `LLMProvider`/`zod` (`parseJsonResponse`) infrastructure.

## Global Constraints

- TypeScript strict mode across `core` and `cli`; no `any` in production code.
- Node.js >= 22.
- `core` has no direct terminal I/O (no `console.log`/`readline` inside `core/src`) — controlling a Playwright browser is NOT terminal I/O with the user, same principle already applied to `LLMProvider`/`CodeChecker`/`TestRunner`. All progress output (`onStep`) stays a callback; the actual `console.log` wiring lives only in `cli/src/commands/generate.ts`.
- Exploration runs exactly once per `generate-tests` invocation, before the existing `MAX_ATTEMPTS = 4` lint-retry loop in `runGenerador` — never re-run per lint retry.
- No caching of discovered evidence between generations (explicit user decision) — every invocation re-explores the real app from scratch.
- The LLM never receives a real credential value. The agentic path's `fill_credential` action only ever carries `field: "username" | "password"`; the driver substitutes the real value locally.
- If exploration fails (`ok: false`), `runGenerador` throws immediately with that error and never calls the LLM for code generation — no automatic retry of the exploration itself (repeating a real login against the app under test has side effects, e.g. account lockout).
- Playwright (Node) is a new dependency of `core`, requiring its own browsers (`npx playwright install chromium`) — distinct from the Python `pytest-playwright` prerequisite documented for "Ejecutar tests".
- This feature automates real logins against the app under test — a `seguridad-seo` audit pass is required before considering it done (see Task 10).

Spec reference: `docs/superpowers/specs/2026-08-13-agente-2-site-explorer-design.md` (read this first — it has the full reasoning for every decision below; this plan only re-states what's needed to implement).

---

## File Structure

```
core/
  package.json                              # MODIFY: + playwright dependency
  src/
    schemas/
      pattern.ts                              # MODIFY: + NavigationHintsSchema, Pattern.navigationHints
      pattern.test.ts                          # NEW
    patterns/
      builtin/
        login.ts                                # MODIFY: + navigationHints
        logout.ts                                # MODIFY: + navigationHints
        signup.ts                                 # MODIFY: + navigationHints
        passwordReset.ts                           # MODIFY: + navigationHints
        builtin.test.ts                             # MODIFY: asserts navigationHints shape
    siteExplorer/
      siteExplorer.ts                               # NEW: SiteExplorer interface + types
      testUtils.ts                                   # NEW: FakeSiteExplorer
      testUtils.test.ts                               # NEW
      explorerAction.ts                                # NEW: ExplorerActionSchema (agentic path)
      explorerAction.test.ts                            # NEW
      testFixtureApp.ts                                  # NEW: local HTTP fixture for real-explorer tests
      realSiteExplorer.ts                                 # NEW: real Playwright-backed SiteExplorer
      realSiteExplorer.test.ts                             # NEW (gated on Playwright Chromium being installed)
    prompts/
      explorer.ts                                          # NEW: explorerActionPrompt
      explorer.test.ts                                      # NEW
      generador.ts                                           # MODIFY: + evidence parameter
    agents/generador/
      codeGenerator.ts                                       # MODIFY: + evidence parameter
      codeGenerator.test.ts                                   # MODIFY
      runGenerador.ts                                          # MODIFY: wires the explorer in
      runGenerador.test.ts                                      # MODIFY
    index.ts                                                    # MODIFY: barrel exports
    index.test.ts                                                # MODIFY
cli/src/commands/
  generate.ts                                                    # MODIFY: builds explorer, passes baseUrl/credentials
  generate.test.ts                                                # MODIFY
  generate.e2e.test.ts                                             # MODIFY
README.md                                                          # MODIFY: Node Playwright browser prerequisite
```

---

## Task 1: `NavigationHintsSchema` + `Pattern.navigationHints`

**Files:**
- Modify: `core/src/schemas/pattern.ts`
- Test: `core/src/schemas/pattern.test.ts`

**Interfaces:**
- Produces: `NavigationHintsSchema` (zod), `NavigationHints` type (`{ routeCandidates: string[]; requiresLogin: boolean }`), `PatternSchema` gains an optional `navigationHints` field.

- [ ] **Step 1: Write the failing test**

`core/src/schemas/pattern.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PatternSchema, NavigationHintsSchema } from "./pattern.js";

describe("PatternSchema", () => {
  it("accepts a pattern without navigationHints (backward compatible with patterns saved before this field existed)", () => {
    const result = PatternSchema.safeParse({
      name: "checkout",
      description: "Flujo de compra",
      gherkinTemplate: "Feature: Checkout\n",
      pageObjectTemplate: "class CheckoutPage:\n    pass\n",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a pattern with navigationHints", () => {
    const result = PatternSchema.safeParse({
      name: "login",
      description: "Login",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "class LoginPage:\n    pass\n",
      navigationHints: { routeCandidates: ["/login", "/"], requiresLogin: true },
    });
    expect(result.success).toBe(true);
  });

  it("rejects navigationHints with an empty routeCandidates array", () => {
    const result = NavigationHintsSchema.safeParse({ routeCandidates: [], requiresLogin: false });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/schemas/pattern.test.ts`
Expected: FAIL (`Cannot find module`/`NavigationHintsSchema` not exported yet)

- [ ] **Step 3: Implement**

`core/src/schemas/pattern.ts` (full file):
```ts
import { z } from "zod";

export const NavigationHintsSchema = z.object({
  routeCandidates: z.array(z.string()).min(1),
  requiresLogin: z.boolean(),
});
export type NavigationHints = z.infer<typeof NavigationHintsSchema>;

export const PatternSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  gherkinTemplate: z.string().min(1),
  pageObjectTemplate: z.string(),
  navigationHints: NavigationHintsSchema.optional(),
});
export type Pattern = z.infer<typeof PatternSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/schemas/pattern.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/schemas/pattern.ts core/src/schemas/pattern.test.ts
git commit -m "feat(core): add optional navigationHints to Pattern schema"
```

---

## Task 2: Built-in patterns gain `navigationHints`

**Files:**
- Modify: `core/src/patterns/builtin/login.ts`
- Modify: `core/src/patterns/builtin/logout.ts`
- Modify: `core/src/patterns/builtin/signup.ts`
- Modify: `core/src/patterns/builtin/passwordReset.ts`
- Modify: `core/src/patterns/builtin/builtin.test.ts`

**Interfaces:**
- Consumes: `Pattern`, `NavigationHintsSchema` (Task 1)
- Produces: each built-in `Pattern` constant now carries a `navigationHints` value

- [ ] **Step 1: Write the failing test**

Append this `it` block inside the existing `describe("built-in patterns", ...)` in `core/src/patterns/builtin/builtin.test.ts` (as the next block, before the closing `});`):

```ts
  it("all navigationHints have at least one route candidate", () => {
    for (const pattern of patterns) {
      expect(pattern.navigationHints).toBeDefined();
      expect(pattern.navigationHints?.routeCandidates.length).toBeGreaterThan(0);
    }
  });

  it("login and logout require a real login during exploration; signup and password-reset don't", () => {
    const byName = Object.fromEntries(patterns.map((p) => [p.name, p]));
    expect(byName.login.navigationHints?.requiresLogin).toBe(true);
    expect(byName.logout.navigationHints?.requiresLogin).toBe(true);
    expect(byName.signup.navigationHints?.requiresLogin).toBe(false);
    expect(byName["password-reset"].navigationHints?.requiresLogin).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/patterns/builtin/builtin.test.ts`
Expected: FAIL — `navigationHints` is `undefined` on all four patterns today.

- [ ] **Step 3: Implement**

`core/src/patterns/builtin/login.ts` (full file):
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
  // requiresLogin: true means "the explorer must perform a real login to capture all
  // screens this pattern needs" — for login itself, that includes the post-login screen
  // (e.g. to ground "accedo a mi área privada" assertions in a real snapshot).
  navigationHints: {
    routeCandidates: ["/login", "/signin", "/sign-in", "/"],
    requiresLogin: true,
  },
};
```

`core/src/patterns/builtin/logout.ts` (full file):
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
  // The scenario starts already authenticated, so exploration must log in first (real
  // credentials) before it can find the logout controls to capture.
  navigationHints: {
    routeCandidates: ["/"],
    requiresLogin: true,
  },
};
```

`core/src/patterns/builtin/signup.ts` (full file):
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
  navigationHints: {
    routeCandidates: ["/signup", "/register", "/sign-up"],
    requiresLogin: false,
  },
};
```

`core/src/patterns/builtin/passwordReset.ts` (full file):
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
  navigationHints: {
    routeCandidates: ["/password-reset", "/forgot-password", "/reset-password"],
    requiresLogin: false,
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/patterns/builtin/builtin.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/patterns/builtin/login.ts core/src/patterns/builtin/logout.ts core/src/patterns/builtin/signup.ts core/src/patterns/builtin/passwordReset.ts core/src/patterns/builtin/builtin.test.ts
git commit -m "feat(core): add navigationHints to built-in patterns"
```

---

## Task 3: `SiteExplorer` interface + `FakeSiteExplorer`

**Files:**
- Create: `core/src/siteExplorer/siteExplorer.ts`
- Create: `core/src/siteExplorer/testUtils.ts`
- Test: `core/src/siteExplorer/testUtils.test.ts`

**Interfaces:**
- Consumes: `Pattern` (Task 1)
- Produces: `ScreenEvidence { stepText: string; url: string; ariaSnapshot: string }`, `ExplorationCredentials { username: string; password: string }`, `ExplorationInput { featureText: string; matchedPattern: Pattern | null; baseUrl: string; credentials?: ExplorationCredentials; headed: boolean }`, `ExplorationResult = { ok: true; screens: ScreenEvidence[] } | { ok: false; error: string }`, `ExplorationStepCallback = (message: string) => void`, `SiteExplorer { explore(input: ExplorationInput, onStep?: ExplorationStepCallback): Promise<ExplorationResult> }`, `FakeSiteExplorer` (constructed with `ExplorationResult[]`, exposes `receivedCalls: ExplorationInput[]`)

- [ ] **Step 1: Write the failing test**

`core/src/siteExplorer/testUtils.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { FakeSiteExplorer } from "./testUtils.js";
import type { ExplorationInput } from "./siteExplorer.js";

function input(overrides: Partial<ExplorationInput> = {}): ExplorationInput {
  return {
    featureText: "Feature: Login\n",
    matchedPattern: null,
    baseUrl: "https://example.com",
    headed: false,
    ...overrides,
  };
}

describe("FakeSiteExplorer", () => {
  it("returns scripted results in order and records the input it was called with", async () => {
    const fake = new FakeSiteExplorer([
      { ok: true, screens: [] },
      { ok: false, error: "no se encontró la ruta" },
    ]);

    const first = await fake.explore(input({ baseUrl: "https://a.com" }));
    expect(first).toEqual({ ok: true, screens: [] });

    const second = await fake.explore(input());
    expect(second).toEqual({ ok: false, error: "no se encontró la ruta" });

    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0].baseUrl).toBe("https://a.com");
  });

  it("calls onStep when provided", async () => {
    const fake = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const steps: string[] = [];

    await fake.explore(input(), (message) => steps.push(message));

    expect(steps.length).toBeGreaterThan(0);
  });

  it("throws when out of scripted results", async () => {
    const fake = new FakeSiteExplorer([]);
    await expect(fake.explore(input())).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/siteExplorer/testUtils.test.ts`
Expected: FAIL (`Cannot find module './testUtils.js'`)

- [ ] **Step 3: Implement**

`core/src/siteExplorer/siteExplorer.ts`:
```ts
import type { Pattern } from "../schemas/pattern.js";

export interface ScreenEvidence {
  stepText: string;
  url: string;
  ariaSnapshot: string;
}

export interface ExplorationCredentials {
  username: string;
  password: string;
}

export interface ExplorationInput {
  featureText: string;
  matchedPattern: Pattern | null;
  baseUrl: string;
  credentials?: ExplorationCredentials;
  headed: boolean;
}

export type ExplorationResult = { ok: true; screens: ScreenEvidence[] } | { ok: false; error: string };

export type ExplorationStepCallback = (message: string) => void;

export interface SiteExplorer {
  explore(input: ExplorationInput, onStep?: ExplorationStepCallback): Promise<ExplorationResult>;
}
```

`core/src/siteExplorer/testUtils.ts`:
```ts
import type { SiteExplorer, ExplorationInput, ExplorationResult, ExplorationStepCallback } from "./siteExplorer.js";

export class FakeSiteExplorer implements SiteExplorer {
  private results: ExplorationResult[];
  public receivedCalls: ExplorationInput[] = [];

  constructor(results: ExplorationResult[]) {
    this.results = [...results];
  }

  async explore(input: ExplorationInput, onStep?: ExplorationStepCallback): Promise<ExplorationResult> {
    this.receivedCalls.push(input);
    onStep?.("explorando (fake)");
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("FakeSiteExplorer: no hay más resultados programados");
    }
    return next;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/siteExplorer/testUtils.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/siteExplorer/siteExplorer.ts core/src/siteExplorer/testUtils.ts core/src/siteExplorer/testUtils.test.ts
git commit -m "feat(core): add SiteExplorer contract and fake test double"
```

---

## Task 4: Agentic action schema + prompt

**Files:**
- Create: `core/src/siteExplorer/explorerAction.ts`
- Test: `core/src/siteExplorer/explorerAction.test.ts`
- Create: `core/src/prompts/explorer.ts`
- Test: `core/src/prompts/explorer.test.ts`

**Interfaces:**
- Produces: `ExplorerActionSchema` (zod discriminated union), `ExplorerAction` type (`goto`/`click`/`fill_credential`/`done`/`fail`), `explorerActionPrompt(featureText, currentUrl, ariaSnapshot, hasCredentials): string`

- [ ] **Step 1: Write the failing tests**

`core/src/siteExplorer/explorerAction.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ExplorerActionSchema } from "./explorerAction.js";

describe("ExplorerActionSchema", () => {
  it("accepts each valid action shape", () => {
    const valid = [
      { action: "goto", target: "/login" },
      { action: "click", role: "button", name: "Iniciar sesión" },
      { action: "fill_credential", labelText: "Email", field: "username" },
      { action: "done" },
      { action: "fail", reason: "no se encuentra el formulario" },
    ];
    for (const candidate of valid) {
      expect(ExplorerActionSchema.safeParse(candidate).success).toBe(true);
    }
  });

  it("rejects a click action with a role outside the known clickable set", () => {
    const result = ExplorerActionSchema.safeParse({ action: "click", role: "heading", name: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown action name", () => {
    const result = ExplorerActionSchema.safeParse({ action: "scroll" });
    expect(result.success).toBe(false);
  });
});
```

`core/src/prompts/explorer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { explorerActionPrompt } from "./explorer.js";

describe("explorerActionPrompt", () => {
  it("includes the feature text, current URL, and snapshot", () => {
    const prompt = explorerActionPrompt("Feature: Login\n", "https://example.com/login", 'textbox "Email"', true);
    expect(prompt).toContain("Feature: Login");
    expect(prompt).toContain("https://example.com/login");
    expect(prompt).toContain('textbox "Email"');
  });

  it("mentions fill_credential is available when credentials are present", () => {
    const prompt = explorerActionPrompt("Feature: x\n", "https://x.com", "", true);
    expect(prompt).toContain("fill_credential");
    expect(prompt).toContain('"username" o "password"');
  });

  it("tells the model not to request credentials when none are configured", () => {
    const prompt = explorerActionPrompt("Feature: x\n", "https://x.com", "", false);
    expect(prompt).toContain("No hay credenciales de prueba configuradas");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run core/src/siteExplorer/explorerAction.test.ts core/src/prompts/explorer.test.ts`
Expected: FAIL (`Cannot find module`)

- [ ] **Step 3: Implement**

`core/src/siteExplorer/explorerAction.ts`:
```ts
import { z } from "zod";

export const ClickableRoleSchema = z.enum(["button", "link", "menuitem", "tab", "checkbox"]);

export const ExplorerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), target: z.string().min(1) }),
  z.object({ action: z.literal("click"), role: ClickableRoleSchema, name: z.string().min(1) }),
  z.object({
    action: z.literal("fill_credential"),
    labelText: z.string().min(1),
    field: z.enum(["username", "password"]),
  }),
  z.object({ action: z.literal("done") }),
  z.object({ action: z.literal("fail"), reason: z.string().min(1) }),
]);
export type ExplorerAction = z.infer<typeof ExplorerActionSchema>;
```

`core/src/prompts/explorer.ts`:
```ts
export function explorerActionPrompt(
  featureText: string,
  currentUrl: string,
  ariaSnapshot: string,
  hasCredentials: boolean
): string {
  const credentialsNote = hasCredentials
    ? 'Hay credenciales de una cuenta de prueba disponibles: puedes pedir rellenarlas con la acción "fill_credential" (nunca escribas el valor real, solo indica qué campo: "username" o "password").'
    : "No hay credenciales de prueba configuradas: no pidas rellenar ningún campo de usuario/contraseña.";

  return `Eres un explorador de interfaces web. Tu objetivo es completar, en la aplicación real, el flujo descrito por este escenario Gherkin:
"""
${featureText}
"""

Estás en la URL: ${currentUrl}

Esto es lo que hay en la pantalla ahora mismo (snapshot de accesibilidad: rol y nombre accesible de cada elemento visible):
"""
${ariaSnapshot}
"""

${credentialsNote}

Responde ÚNICAMENTE con un objeto JSON (sin explicación, sin bloques de código markdown) con una de estas formas exactas:
- {"action": "goto", "target": "<ruta o URL a la que navegar>"}
- {"action": "click", "role": "button" | "link" | "menuitem" | "tab" | "checkbox", "name": "<nombre accesible exacto visto en el snapshot>"}
- {"action": "fill_credential", "labelText": "<label o nombre accesible exacto del campo>", "field": "username" | "password"}
- {"action": "done"} — cuando la pantalla actual ya representa el estado final del escenario
- {"action": "fail", "reason": "<por qué no se puede continuar>"} — cuando la pantalla actual no permite seguir`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/siteExplorer/explorerAction.test.ts core/src/prompts/explorer.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/siteExplorer/explorerAction.ts core/src/siteExplorer/explorerAction.test.ts core/src/prompts/explorer.ts core/src/prompts/explorer.test.ts
git commit -m "feat(core): add explorer action schema and prompt for the agentic exploration path"
```

---

## Task 5: `realSiteExplorer` — hybrid Playwright-backed `SiteExplorer`

**Files:**
- Modify: `core/package.json` (+ `playwright` dependency)
- Create: `core/src/siteExplorer/testFixtureApp.ts`
- Create: `core/src/siteExplorer/realSiteExplorer.ts`
- Test: `core/src/siteExplorer/realSiteExplorer.test.ts`

**Interfaces:**
- Consumes: `SiteExplorer`, `ExplorationInput`, `ExplorationResult`, `ScreenEvidence` (Task 3); `ExplorerActionSchema` (Task 4); `explorerActionPrompt` (Task 4); `LLMProvider` (existing); `parseJsonResponse` (existing, `core/src/llm/parseJson.ts`)
- Produces: `MissingExplorerToolError`, `createRealSiteExplorer(llm: LLMProvider, options?: { executablePath?: string }): SiteExplorer`

This is the largest task in the plan — it's the actual browser automation. `options.executablePath` exists purely for deterministic testing of the "missing tool" error path (mirrors `createRealTestRunner`'s `pythonCommand` override).

- [ ] **Step 1: Install the Playwright (Node) dependency**

Run: `npm install playwright --workspace=core`

This updates `core/package.json` and the root `package-lock.json` together — both get committed at the end of this task.

- [ ] **Step 2: Write the failing test**

`core/src/siteExplorer/testFixtureApp.ts` (this is a test helper, not itself under test — it's exercised by every test below):
```ts
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureApp {
  url: string;
  close(): Promise<void>;
}

const TEST_USERNAME = "qa-tester@example.com";
const TEST_PASSWORD = "hunter2-test-only";
export const FIXTURE_CREDENTIALS = { username: TEST_USERNAME, password: TEST_PASSWORD };

function loginPageHtml(): string {
  return `<!doctype html>
<html>
<body>
  <form id="login-form">
    <label for="email">Correo electrónico</label>
    <input id="email" name="email" type="text" />
    <label for="password">Contraseña</label>
    <input id="password" name="password" type="password" />
    <button type="submit">Iniciar sesión</button>
  </form>
  <script>
    document.getElementById("login-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var email = document.getElementById("email").value;
      var password = document.getElementById("password").value;
      if (email === "${TEST_USERNAME}" && password === "${TEST_PASSWORD}") {
        window.location.href = "/dashboard";
      } else {
        var alertBox = document.createElement("div");
        alertBox.setAttribute("role", "alert");
        alertBox.textContent = "Credenciales inválidas";
        document.body.appendChild(alertBox);
      }
    });
  </script>
</body>
</html>`;
}

const DASHBOARD_PAGE = `<!doctype html>
<html>
<body>
  <nav>
    <span>Hola, tester</span>
    <button type="button">Menú de usuario</button>
    <a href="/login">Cerrar sesión</a>
  </nav>
  <main><h1>Panel</h1></main>
</body>
</html>`;

const NOT_FOUND_PAGE = `<!doctype html><html><body><h1>404</h1></body></html>`;
const EMPTY_HOME_PAGE = `<!doctype html><html><body><h1>Home</h1></body></html>`;

export type FixtureMode = "conventional" | "spa" | "custom";

export function startFixtureApp(mode: FixtureMode): Promise<FixtureApp> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const send = (status: number, body: string): void => {
      res.writeHead(status, { "Content-Type": "text/html" });
      res.end(body);
    };

    if (url.startsWith("/dashboard")) return send(200, DASHBOARD_PAGE);
    if (mode === "conventional" && (url === "/login" || url === "/signin")) return send(200, loginPageHtml());
    if (mode === "conventional" && url === "/") return send(200, EMPTY_HOME_PAGE);
    if (mode === "spa" && url === "/") return send(200, loginPageHtml());
    if (mode === "custom" && url === "/access") return send(200, loginPageHtml());

    send(404, NOT_FOUND_PAGE);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
```

`core/src/siteExplorer/realSiteExplorer.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { createRealSiteExplorer, MissingExplorerToolError } from "./realSiteExplorer.js";
import { startFixtureApp, FIXTURE_CREDENTIALS, type FixtureApp } from "./testFixtureApp.js";
import { FakeLLMProvider } from "../llm/testUtils.js";
import type { Pattern } from "../schemas/pattern.js";
import type { ExplorationInput } from "./siteExplorer.js";

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

describe("createRealSiteExplorer missing tool handling", () => {
  it("throws MissingExplorerToolError when the browser executable doesn't exist", async () => {
    const explorer = createRealSiteExplorer(new FakeLLMProvider([]), {
      executablePath: "/definitely/missing/chromium-binary",
    });
    await expect(
      explorer.explore({
        featureText: "Feature: x\n",
        matchedPattern: null,
        baseUrl: "http://127.0.0.1:1",
        headed: false,
      })
    ).rejects.toThrow(MissingExplorerToolError);
  });
});

function baseInput(overrides: Partial<ExplorationInput> = {}): ExplorationInput {
  return {
    featureText: "Feature: Login\n  Scenario: entrar\n    Given estoy en la página de login\n",
    matchedPattern: null,
    baseUrl: "http://127.0.0.1",
    headed: false,
    ...overrides,
  };
}

const loginPattern: Pattern = {
  name: "login",
  description: "login",
  gherkinTemplate: "Feature: Login\n",
  pageObjectTemplate: "",
  navigationHints: { routeCandidates: ["/login", "/signin"], requiresLogin: true },
};

describe.skipIf(!chromiumAvailable)("createRealSiteExplorer (requires Playwright Chromium installed)", () => {
  describe("conventional app (real routes match the known pattern)", () => {
    let app: FixtureApp;
    beforeAll(async () => {
      app = await startFixtureApp("conventional");
    });
    afterAll(async () => {
      await app.close();
    });

    it("fast path finds /login, logs in for real, and captures both screens without ever calling the LLM", async () => {
      const llm = new FakeLLMProvider([]);
      const explorer = createRealSiteExplorer(llm);
      const steps: string[] = [];

      const result = await explorer.explore(
        baseInput({ matchedPattern: loginPattern, baseUrl: app.url, credentials: FIXTURE_CREDENTIALS }),
        (message) => steps.push(message)
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.screens).toHaveLength(2);
      expect(result.screens[0].url).toContain("/login");
      expect(result.screens[1].url).toContain("/dashboard");
      expect(result.screens[1].ariaSnapshot).toContain("Cerrar sesión");
      expect(llm.receivedCalls).toHaveLength(0);
      expect(steps.some((s) => s.includes("/login"))).toBe(true);
    });

    it("returns a clear error when the pattern requires login but no credentials were configured", async () => {
      const explorer = createRealSiteExplorer(new FakeLLMProvider([]));
      const result = await explorer.explore(baseInput({ matchedPattern: loginPattern, baseUrl: app.url }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("AGENTE_QA_TEST_USERNAME");
    });
  });

  describe("spa app (login only reachable at the root — the exact bug this feature fixes)", () => {
    let app: FixtureApp;
    beforeAll(async () => {
      app = await startFixtureApp("spa");
    });
    afterAll(async () => {
      await app.close();
    });

    it("finds the login form at the root when /login and /signin both 404, without escalating to the agentic path", async () => {
      const patternWithRootFallback: Pattern = {
        ...loginPattern,
        navigationHints: { routeCandidates: ["/login", "/signin", "/"], requiresLogin: false },
      };
      const llm = new FakeLLMProvider([]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: patternWithRootFallback, baseUrl: app.url }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.screens[0].url).toBe(`${app.url}/`);
      expect(llm.receivedCalls).toHaveLength(0);
    });
  });

  describe("custom app (login lives outside any known route candidate)", () => {
    let app: FixtureApp;
    beforeAll(async () => {
      app = await startFixtureApp("custom");
    });
    afterAll(async () => {
      await app.close();
    });

    it("escalates to the agentic path when every route candidate fails, and reaches the target via the model's actions", async () => {
      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "goto", target: "/access" }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: loginPattern, baseUrl: app.url }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.screens[0].url).toContain("/access");
      expect(llm.receivedCalls.length).toBeGreaterThan(0);
    });

    it("fills credentials via the driver without ever sending the real password to the LLM", async () => {
      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "goto", target: "/access" }),
        JSON.stringify({ action: "fill_credential", labelText: "Correo electrónico", field: "username" }),
        JSON.stringify({ action: "fill_credential", labelText: "Contraseña", field: "password" }),
        JSON.stringify({ action: "click", role: "button", name: "Iniciar sesión" }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(
        baseInput({ matchedPattern: null, baseUrl: app.url, credentials: FIXTURE_CREDENTIALS })
      );

      expect(result.ok).toBe(true);
      const allPromptText = llm.receivedCalls.flat().map((m) => m.content).join("\n");
      expect(allPromptText).not.toContain(FIXTURE_CREDENTIALS.password);
    });

    it("fails clearly after exceeding the step limit instead of looping forever", async () => {
      const neverDone = JSON.stringify({ action: "click", role: "button", name: "no existe" });
      const llm = new FakeLLMProvider(new Array(25).fill(neverDone));
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: null, baseUrl: app.url }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("20 acciones");
      expect(llm.receivedCalls).toHaveLength(20);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run core/src/siteExplorer/realSiteExplorer.test.ts`
Expected: FAIL (`Cannot find module './realSiteExplorer.js'`)

- [ ] **Step 4: Implement**

`core/src/siteExplorer/realSiteExplorer.ts`:
```ts
import { chromium, type Browser, type Page } from "playwright";
import type { LLMProvider } from "../llm/provider.js";
import { parseJsonResponse } from "../llm/parseJson.js";
import { ExplorerActionSchema } from "./explorerAction.js";
import { explorerActionPrompt } from "../prompts/explorer.js";
import type {
  SiteExplorer,
  ExplorationInput,
  ExplorationResult,
  ExplorationStepCallback,
  ScreenEvidence,
} from "./siteExplorer.js";

export class MissingExplorerToolError extends Error {
  constructor(detail: string) {
    super(
      `No se pudo abrir el navegador para explorar la aplicación: ${detail}. Instala los navegadores de Playwright con "npx playwright install chromium".`
    );
    this.name = "MissingExplorerToolError";
  }
}

const MAX_AGENTIC_STEPS = 20;

async function launchBrowser(headed: boolean, executablePath?: string): Promise<Browser> {
  try {
    return await chromium.launch({ headless: !headed, executablePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MissingExplorerToolError(message);
  }
}

async function ariaSnapshotOf(page: Page): Promise<string> {
  return page.locator("body").ariaSnapshot();
}

async function looksLikeUsablePage(page: Page): Promise<boolean> {
  const count = await page.getByRole("textbox").or(page.getByRole("button")).count();
  return count > 0;
}

const LOGIN_FIELD_LABEL = /correo|usuario|email|user/i;
const PASSWORD_FIELD_LABEL = /contraseña|password/i;
const SUBMIT_BUTTON_NAME = /iniciar sesión|ingresar|log ?in/i;

async function performRealLogin(
  page: Page,
  credentials: { username: string; password: string }
): Promise<ScreenEvidence | null> {
  const emailField = page.getByLabel(LOGIN_FIELD_LABEL).first();
  const passwordField = page.getByLabel(PASSWORD_FIELD_LABEL).first();
  const submitButton = page.getByRole("button", { name: SUBMIT_BUTTON_NAME }).first();

  if ((await emailField.count()) === 0 || (await passwordField.count()) === 0) {
    return null;
  }

  await emailField.fill(credentials.username);
  await passwordField.fill(credentials.password);
  await submitButton.click();
  await page.waitForLoadState("networkidle").catch(() => {});

  return {
    stepText: "tras iniciar sesión con las credenciales de test",
    url: page.url(),
    ariaSnapshot: await ariaSnapshotOf(page),
  };
}

async function exploreByHints(
  page: Page,
  input: ExplorationInput,
  onStep: ExplorationStepCallback,
  triedRoutes: string[]
): Promise<ExplorationResult | null> {
  const hints = input.matchedPattern?.navigationHints;
  if (!hints) return null;

  for (const candidate of hints.routeCandidates) {
    const url = new URL(candidate, input.baseUrl).toString();
    triedRoutes.push(url);
    onStep(`Probando ruta ${candidate}...`);

    const response = await page.goto(url).catch(() => null);
    if (!response || response.status() >= 400) {
      onStep(`Ruta ${candidate} no disponible (${response ? response.status() : "sin respuesta"}).`);
      continue;
    }
    if (!(await looksLikeUsablePage(page))) {
      onStep(`Ruta ${candidate} cargó pero no parece tener contenido interactivo.`);
      continue;
    }

    onStep(`Ruta ${candidate} encontrada.`);
    const screens: ScreenEvidence[] = [
      { stepText: `pantalla en ${candidate}`, url: page.url(), ariaSnapshot: await ariaSnapshotOf(page) },
    ];

    if (hints.requiresLogin) {
      if (!input.credentials) {
        return {
          ok: false,
          error:
            "Este escenario necesita iniciar sesión pero no hay AGENTE_QA_TEST_USERNAME/AGENTE_QA_TEST_PASSWORD configurados en .agente-qa/.env.",
        };
      }
      const postLogin = await performRealLogin(page, input.credentials);
      if (!postLogin) {
        onStep(`No se encontraron campos de login en ${candidate} para iniciar sesión de verdad.`);
        continue;
      }
      screens.push(postLogin);
    }

    return { ok: true, screens };
  }

  return null;
}

async function exploreAgentically(
  page: Page,
  llm: LLMProvider,
  input: ExplorationInput,
  onStep: ExplorationStepCallback
): Promise<ExplorationResult> {
  if (page.url() === "about:blank") {
    await page.goto(input.baseUrl).catch(() => {});
  }

  for (let step = 0; step < MAX_AGENTIC_STEPS; step++) {
    const snapshot = await ariaSnapshotOf(page);
    const prompt = explorerActionPrompt(input.featureText, page.url(), snapshot, Boolean(input.credentials));
    const raw = await llm.generate([
      { role: "system", content: "Eres un explorador de interfaces web que decide una acción a la vez." },
      { role: "user", content: prompt },
    ]);
    const action = parseJsonResponse(ExplorerActionSchema, raw);
    onStep(`Acción ${step + 1}: ${action.action}`);

    if (action.action === "done") {
      return {
        ok: true,
        screens: [{ stepText: "estado final del escenario", url: page.url(), ariaSnapshot: snapshot }],
      };
    }
    if (action.action === "fail") {
      return { ok: false, error: action.reason };
    }
    if (action.action === "goto") {
      const url = new URL(action.target, input.baseUrl).toString();
      await page.goto(url).catch(() => {});
    } else if (action.action === "click") {
      await page.getByRole(action.role, { name: action.name }).first().click().catch(() => {});
    } else if (action.action === "fill_credential") {
      if (!input.credentials) {
        return {
          ok: false,
          error:
            "El modelo pidió rellenar credenciales de test, pero no hay AGENTE_QA_TEST_USERNAME/AGENTE_QA_TEST_PASSWORD configurados en .agente-qa/.env.",
        };
      }
      const value = action.field === "username" ? input.credentials.username : input.credentials.password;
      await page.getByLabel(action.labelText, { exact: false }).first().fill(value).catch(() => {});
    }
  }

  return { ok: false, error: `No se pudo completar el escenario tras ${MAX_AGENTIC_STEPS} acciones.` };
}

export function createRealSiteExplorer(llm: LLMProvider, options?: { executablePath?: string }): SiteExplorer {
  return {
    async explore(input: ExplorationInput, onStep: ExplorationStepCallback = () => {}): Promise<ExplorationResult> {
      const browser = await launchBrowser(input.headed, options?.executablePath);
      try {
        const page = await browser.newPage();
        const triedRoutes: string[] = [];

        const hintsResult = await exploreByHints(page, input, onStep, triedRoutes);
        if (hintsResult) return hintsResult;

        onStep(
          triedRoutes.length > 0
            ? `Ninguna ruta conocida sirvió (${triedRoutes.join(", ")}); explorando con ayuda del modelo...`
            : "No hay patrón conocido; explorando con ayuda del modelo..."
        );

        const agenticResult = await exploreAgentically(page, llm, input, onStep);
        if (!agenticResult.ok && triedRoutes.length > 0) {
          return { ok: false, error: `${agenticResult.error} (rutas ya descartadas: ${triedRoutes.join(", ")})` };
        }
        return agenticResult;
      } finally {
        await browser.close();
      }
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run core/src/siteExplorer/realSiteExplorer.test.ts`
Expected: PASS. The "missing tool" test always runs and passes regardless of environment. The gated block's 7 tests pass if Playwright Chromium is installed (`npx playwright install chromium` — see README update in Task 9), otherwise shown as skipped.

- [ ] **Step 6: Commit**

```bash
git add core/package.json package-lock.json core/src/siteExplorer/testFixtureApp.ts core/src/siteExplorer/realSiteExplorer.ts core/src/siteExplorer/realSiteExplorer.test.ts
git commit -m "feat(core): add real Playwright-backed SiteExplorer (hybrid fast-path + agentic)"
```

---

## Task 6: `codeGenerationPrompt` / `generateCode` gain real evidence

**Files:**
- Modify: `core/src/prompts/generador.ts`
- Modify: `core/src/agents/generador/codeGenerator.ts`
- Modify: `core/src/agents/generador/codeGenerator.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks (evidence is a plain structural type, decoupled from `ScreenEvidence` on purpose — same pattern as `matchedPattern`'s ad-hoc `{ name, pageObjectTemplate }` type already used here)
- Produces: `CodeGenerationEvidence { stepText: string; url: string; ariaSnapshot: string }`; `codeGenerationPrompt(featureText, matchedPattern, naming, evidence, retry?)`; `generateCode(featureText, llm, matchedPattern, naming, evidence, retry?)` — evidence is a new required 5th parameter (4th positional after `naming`, before the still-optional `retry`)

- [ ] **Step 1: Write the failing tests**

Replace `core/src/agents/generador/codeGenerator.test.ts` in full:

```ts
import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateCode } from "./codeGenerator.js";
import type { Pattern } from "../../schemas/pattern.js";

const featureText = "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n";
const naming = { slug: "login", featureFileName: "login.feature" };

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
`;

describe("generateCode", () => {
  it("parses the two # FILE: blocks into separate files", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const files = await generateCode(featureText, llm, null, naming, []);

    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("tests/test_login.py");
    expect(files[0].content).toContain("from pytest_bdd import scenarios");
    expect(files[1].path).toBe("pages/login_page.py");
    expect(files[1].content).toContain("class LoginPage");
  });

  it("sends the feature text, pattern skeleton, and exact naming to the model when a pattern matched", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const matchedPattern: Pattern = {
      name: "login",
      description: "Inicio de sesión",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "class LoginPage:\n    pass\n",
    };
    await generateCode(featureText, llm, matchedPattern, naming, []);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain(featureText);
    expect(userMessage?.content).toContain("class LoginPage:\n    pass");
    expect(userMessage?.content).toContain("features/login.feature");
    expect(userMessage?.content).toContain("test_login.py");
    expect(userMessage?.content).toContain("login_page.py");
  });

  it("instructs the model to read the app URL and test credentials from environment variables, never literal values", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, []);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("AGENTE_QA_APP_URL");
    expect(userMessage?.content).toContain("AGENTE_QA_TEST_USERNAME");
    expect(userMessage?.content).toContain("AGENTE_QA_TEST_PASSWORD");
  });

  it("includes real captured evidence in the prompt when the explorer found any", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [
      { stepText: "pantalla de login", url: "https://example.com/login", ariaSnapshot: 'textbox "Email"' },
    ]);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("https://example.com/login");
    expect(userMessage?.content).toContain('textbox "Email"');
  });

  it("tells the model no real evidence was captured when the list is empty", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, []);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("No se pudo capturar evidencia real");
  });

  it("includes the previous attempt's code and the retry feedback in the prompt when provided", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const previousFiles = [
      { path: "tests/test_login.py", content: "broken code here\n" },
      { path: "pages/login_page.py", content: "class LoginPage:\n    pass\n" },
    ];
    await generateCode(featureText, llm, null, naming, [], {
      previousFiles,
      feedback: "SyntaxError: unexpected token",
    });

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("SyntaxError: unexpected token");
    expect(userMessage?.content).toContain("broken code here");
  });

  it("throws a clear error when the response has no # FILE: blocks", async () => {
    const llm = new FakeLLMProvider(["esto no tiene el formato esperado"]);
    await expect(generateCode(featureText, llm, null, naming, [])).rejects.toThrow(/# FILE:/);
  });

  it("throws a clear error when the response has the wrong number of file blocks", async () => {
    const threeFileResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
# FILE: conftest.py
import pytest
`;
    const llm = new FakeLLMProvider([threeFileResponse]);
    await expect(generateCode(featureText, llm, null, naming, [])).rejects.toThrow(/2 esperados/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: FAIL — `generateCode` still takes 4-5 positional args (no `evidence` slot), so TypeScript rejects the extra argument / the two new evidence-specific tests fail.

- [ ] **Step 3: Implement**

`core/src/prompts/generador.ts` (full file):
```ts
export interface CodeGenerationNaming {
  slug: string;
  featureFileName: string;
}

export interface CodeGenerationEvidence {
  stepText: string;
  url: string;
  ariaSnapshot: string;
}

export interface CodeGenerationRetry {
  previousFiles: { path: string; content: string }[];
  feedback: string;
}

export function codeGenerationPrompt(
  featureText: string,
  matchedPattern: { name: string; pageObjectTemplate: string } | null,
  naming: CodeGenerationNaming,
  evidence: CodeGenerationEvidence[],
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

Dado este archivo Gherkin ya aprobado, ubicado en "features/${naming.featureFileName}":
"""
${featureText}
"""

${patternSection}

${evidenceSection}

El proyecto ya tiene instalado el plugin "pytest-playwright": el fixture "page" (una página de navegador ya lista) está disponible automáticamente en cualquier test, no lo definas tú ni escribas ningún conftest.py.

La URL de la aplicación bajo test y las credenciales de una cuenta de prueba NUNCA se escriben como texto literal en este código: se guarda en el repositorio del usuario. Léelas siempre con "os.environ": "os.environ[\"AGENTE_QA_APP_URL\"]" para la URL base, y si el escenario prueba un login, "os.environ[\"AGENTE_QA_TEST_USERNAME\"]" / "os.environ[\"AGENTE_QA_TEST_PASSWORD\"]" para usuario y contraseña.

Genera EXACTAMENTE dos bloques de código, cada uno empezando por una línea con este formato exacto "# FILE: <ruta>", seguida del contenido completo de ese archivo. No incluyas explicaciones fuera de los bloques ni bloques de código markdown (\`\`\`).

Los dos archivos, en este orden, usando exactamente estos nombres (no inventes otros):
1. "tests/test_${naming.slug}.py" — step definitions pytest-bdd. Importa "scenarios" de "pytest_bdd" y llama "scenarios(\"../features/${naming.featureFileName}\")". Importa de "pytest_bdd" solo los decoradores "given"/"when"/"then" que realmente vayas a usar según los pasos del feature (no importes los que no uses). Usa el fixture "page" (parámetro de las funciones step) para interactuar con el navegador a través del Page Object.
2. "pages/${naming.slug}_page.py" — clase(s) Page Object en Python (Playwright sync API) para las pantallas involucradas, recibiendo "page" en su constructor.${retrySection}`;
}
```

`core/src/agents/generador/codeGenerator.ts` (full file):
```ts
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import {
  codeGenerationPrompt,
  type CodeGenerationNaming,
  type CodeGenerationEvidence,
  type CodeGenerationRetry,
} from "../../prompts/generador.js";

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

  if (files.length !== 2) {
    throw new Error(
      `La respuesta del modelo generó ${files.length} archivo(s) en vez de los 2 esperados (step definitions y Page Object): ${cleaned.slice(0, 80)}...`
    );
  }

  return files;
}

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/codeGenerator.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/generador.ts core/src/agents/generador/codeGenerator.ts core/src/agents/generador/codeGenerator.test.ts
git commit -m "feat(core): inject real explored evidence into the code generation prompt"
```

---

## Task 7: Wire the explorer into `runGenerador`

**Files:**
- Modify: `core/src/agents/generador/runGenerador.ts`
- Modify: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Consumes: `SiteExplorer`, `ExplorationCredentials` (Task 3); `generateCode(..., evidence, retry?)` (Task 6)
- Produces: `GeneratorCallbacks` gains `onExplorationStep(message: string): void`; `runGenerador` signature becomes `runGenerador(featureFilePath, llm, patterns, checker, explorer, projectRoot, testsDir, baseUrl, credentials, callbacks)`

- [ ] **Step 1: Write the failing tests**

Replace `core/src/agents/generador/runGenerador.test.ts` in full:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { FakeCodeChecker } from "../../codeCheck/testUtils.js";
import { FakeSiteExplorer } from "../../siteExplorer/testUtils.js";
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

    const { writtenPaths } = await runGenerador(
      featureFilePath, llm, [loginPattern], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

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

    await runGenerador(
      featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

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

    await runGenerador(
      featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

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
      runGenerador(
        featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
      )
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
      runGenerador(
        featureFilePath, llm, [loginPattern], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
      )
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

    await runGenerador(
      featureFilePath, llm, [loginPattern], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

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

    await runGenerador(
      featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

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
      runGenerador(
        featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
      )
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

    await runGenerador(
      featureFilePath, llm, [loginPattern], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("https://example.com/login");
    expect(promptContent).toContain('textbox "Email"');
  });

  it("passes baseUrl, credentials, and headed:true through to the explorer", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks();

    await runGenerador(
      featureFilePath,
      llm,
      [],
      checker,
      explorer,
      tmpProject,
      "tests",
      "https://example.com",
      { username: "qa@example.com", password: "s3cret" },
      cb
    );

    expect(explorer.receivedCalls[0].baseUrl).toBe("https://example.com");
    expect(explorer.receivedCalls[0].credentials).toEqual({ username: "qa@example.com", password: "s3cret" });
    expect(explorer.receivedCalls[0].headed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL — `runGenerador` doesn't accept an `explorer`/`baseUrl`/`credentials` yet, and `GeneratorCallbacks` has no `onExplorationStep`.

- [ ] **Step 3: Implement**

`core/src/agents/generador/runGenerador.ts` (full file):
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { CodeChecker } from "../../codeCheck/codeChecker.js";
import type { SiteExplorer, ExplorationCredentials } from "../../siteExplorer/siteExplorer.js";
import { saveProjectPattern } from "../../patterns/registry.js";
import { parseFeatureHeader } from "./parseFeatureHeader.js";
import { generateCode, type GeneratedFile } from "./codeGenerator.js";
import { testFileExists, testFilePath, writeTestFiles } from "./writeTestFiles.js";

function toPythonModuleSlug(rawSlug: string): string {
  const sanitized = rawSlug.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

const MAX_ATTEMPTS = 4; // 1 initial generation + up to 3 corrections

export interface GeneratorCallbacks {
  offerSavePattern(featureText: string): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
  onExplorationStep(message: string): void;
}

export async function runGenerador(
  featureFilePath: string,
  llm: LLMProvider,
  patterns: Pattern[],
  checker: CodeChecker,
  explorer: SiteExplorer,
  projectRoot: string,
  testsDir: string,
  baseUrl: string,
  credentials: ExplorationCredentials | undefined,
  callbacks: GeneratorCallbacks
): Promise<{ writtenPaths: string[] }> {
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/generador/runGenerador.ts core/src/agents/generador/runGenerador.test.ts
git commit -m "feat(core): run real site exploration before code generation, abort on failure"
```

---

## Task 8: Export the new public surface from `core`

**Files:**
- Modify: `core/src/index.ts`
- Modify: `core/src/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7
- Produces: barrel exports

- [ ] **Step 1: Write the failing test**

Append this `it` block inside the existing `describe("@agente-qa/core public API", ...)` in `core/src/index.test.ts` (as the next block after `"exports the Agente 2 (generador) surface"`, before the closing `});`):

```ts
  it("exports the schema's navigation hints", () => {
    expect(typeof core.NavigationHintsSchema.parse).toBe("function");
  });

  it("exports the site explorer surface", () => {
    expect(typeof core.FakeSiteExplorer).toBe("function");
    expect(typeof core.createRealSiteExplorer).toBe("function");
    expect(typeof core.MissingExplorerToolError).toBe("function");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/src/index.test.ts`
Expected: FAIL — `core.NavigationHintsSchema`, `core.FakeSiteExplorer`, `core.createRealSiteExplorer`, `core.MissingExplorerToolError` are all `undefined`.

- [ ] **Step 3: Implement**

In `core/src/index.ts`, replace this existing block:
```ts
export { PatternSchema } from "./schemas/pattern.js";
export type { Pattern } from "./schemas/pattern.js";
```
with:
```ts
export { PatternSchema, NavigationHintsSchema } from "./schemas/pattern.js";
export type { Pattern, NavigationHints } from "./schemas/pattern.js";
```

Then append, right after the existing `export type { GeneratorCallbacks } from "./agents/generador/runGenerador.js";` line:
```ts

export type {
  ScreenEvidence,
  ExplorationInput,
  ExplorationResult,
  ExplorationCredentials,
  SiteExplorer,
} from "./siteExplorer/siteExplorer.js";
export { FakeSiteExplorer } from "./siteExplorer/testUtils.js";
export { createRealSiteExplorer, MissingExplorerToolError } from "./siteExplorer/realSiteExplorer.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run core/src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/index.ts core/src/index.test.ts
git commit -m "feat(core): export the site explorer public surface from the barrel"
```

---

## Task 9: CLI wiring + README prerequisite

**Files:**
- Modify: `cli/src/commands/generate.ts`
- Modify: `cli/src/commands/generate.test.ts`
- Modify: `cli/src/commands/generate.e2e.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createRealSiteExplorer`, `requireAppUrl`, `FakeSiteExplorer` (Task 8); `runGenerador`'s new signature (Task 7)
- Produces: `runGenerateTests` (unchanged external signature: `(prompts, projectRoot) => Promise<string[]>`) now also validates `AGENTE_QA_APP_URL`, builds the real explorer, and streams exploration progress to the console

Note: no change needed to `cli/src/prompts/types.ts` — `onExplorationStep` is a progress callback like `ExecutorCallbacks.onOutput`, wired directly to `console.log` inside `generate.ts`, not a user-input prompt.

- [ ] **Step 1: Write the failing tests**

Replace `cli/src/commands/generate.test.ts` in full:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, projectEnvPath, FakeLLMProvider, FakeSiteExplorer, realCodeChecker } from "@agente-qa/core";
import type { GeneratorPrompts } from "../prompts/types.js";

const createProviderMock = vi.fn();
const realCodeCheckerCheckMock = vi.fn();
const createRealSiteExplorerMock = vi.fn();
const withLLMSpinnerMock = vi.fn((provider: unknown) => provider);
const withCodeCheckerSpinnerMock = vi.fn((checker: unknown) => checker);

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
    realCodeChecker: { check: (...args: unknown[]) => realCodeCheckerCheckMock(...args) },
    createRealSiteExplorer: (...args: unknown[]) => createRealSiteExplorerMock(...args),
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

const BASE_ENV = {
  AGENTE_QA_LLM_PROVIDER: "anthropic",
  AGENTE_QA_LLM_API_KEY: "sk-test",
  AGENTE_QA_APP_URL: "https://example.com",
};

describe("runGenerateTests", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-generate-project-"));
    createProviderMock.mockReset();
    realCodeCheckerCheckMock.mockReset();
    createRealSiteExplorerMock.mockReset();
    createRealSiteExplorerMock.mockReturnValue(new FakeSiteExplorer([{ ok: true, screens: [] }]));
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

  it("throws a clear error when AGENTE_QA_APP_URL isn't configured", async () => {
    await writeEnv(tmpProject, { AGENTE_QA_LLM_PROVIDER: "anthropic", AGENTE_QA_LLM_API_KEY: "sk-test" });
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpProject)).rejects.toThrow(/AGENTE_QA_APP_URL/);
  });

  it("throws a clear error when there are no approved .feature files yet", async () => {
    await writeEnv(tmpProject, BASE_ENV);
    await saveProjectConfig(tmpProject, { testsDir: "tests" });

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn(),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn(),
    };
    await expect(runGenerateTests(prompts, tmpProject)).rejects.toThrow(/Crear plan de pruebas/);
  });

  it("lists feature files, generates code through the fake LLM, and writes the test files", async () => {
    await writeEnv(tmpProject, BASE_ENV);
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
    await writeEnv(tmpProject, BASE_ENV);
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

  it("builds the site explorer from the LLM provider and passes app URL and test credentials through", async () => {
    await writeEnv(tmpProject, {
      ...BASE_ENV,
      AGENTE_QA_TEST_USERNAME: "qa@example.com",
      AGENTE_QA_TEST_PASSWORD: "s3cret",
    });
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
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    createRealSiteExplorerMock.mockReturnValue(explorer);

    const prompts: GeneratorPrompts = {
      selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
      offerSavePattern: vi.fn().mockResolvedValue({ save: false }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    await runGenerateTests(prompts, tmpProject);

    expect(createRealSiteExplorerMock).toHaveBeenCalledWith(fake);
    expect(explorer.receivedCalls[0].baseUrl).toBe("https://example.com");
    expect(explorer.receivedCalls[0].credentials).toEqual({ username: "qa@example.com", password: "s3cret" });
  });
});
```

Replace `cli/src/commands/generate.e2e.test.ts` in full:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { saveProjectConfig, projectEnvPath, FakeSiteExplorer } from "@agente-qa/core";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}
const hasPython = commandExists("python");
const hasRuff = commandExists("ruff");

const generateTextMock = vi.fn();
const createRealSiteExplorerMock = vi.fn();
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
vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createRealSiteExplorer: (...args: unknown[]) => createRealSiteExplorerMock(...args),
  };
});

import { runGenerateTests } from "./generate.js";
import type { GeneratorPrompts } from "../prompts/types.js";

describe.skipIf(!hasPython || !hasRuff)(
  "end-to-end: generate tests via the real wiring (ruff/py_compile real; site explorer and LLM network call mocked)",
  () => {
    let tmpProject: string;

    beforeEach(async () => {
      tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-gen-e2e-project-"));
      await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
      await fs.writeFile(
        projectEnvPath(tmpProject),
        "AGENTE_QA_LLM_PROVIDER=anthropic\nAGENTE_QA_LLM_API_KEY=sk-test\nAGENTE_QA_APP_URL=https://example.com\n",
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
      createRealSiteExplorerMock.mockReset();
      createRealSiteExplorerMock.mockReturnValue(new FakeSiteExplorer([{ ok: true, screens: [] }]));
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run cli/src/commands/generate.test.ts cli/src/commands/generate.e2e.test.ts`
Expected: FAIL — `runGenerateTests` doesn't call `requireAppUrl`/`createRealSiteExplorer` yet, so the new/updated assertions don't hold (and some existing tests fail because `runGenerador`'s real signature now requires more arguments than `generate.ts` passes).

- [ ] **Step 3: Implement**

`cli/src/commands/generate.ts` (full file):
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
  const baseUrl = requireAppUrl(env, projectEnvPath(projectRoot));

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
  const explorer = createRealSiteExplorer(llm);
  const credentials =
    env.testUsername && env.testPassword ? { username: env.testUsername, password: env.testPassword } : undefined;

  const callbacks: GeneratorCallbacks = {
    offerSavePattern: () => prompts.offerSavePattern(),
    confirmOverwrite: (filePath) => prompts.confirmOverwrite(filePath),
    onExplorationStep: (message) => {
      console.log(message);
    },
  };

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

  return writtenPaths;
}
```

In `README.md`, replace this line:
```
> A partir de "Generar tests Playwright" (Agente 2), la CLI standalone necesita además **Python 3 y `ruff`** en el `PATH` — se usan para verificar que el código generado compila y pasa lint antes de escribirlo al proyecto. No hace falta para "Crear plan de pruebas" (Agente 1).
```
with:
```
> A partir de "Generar tests Playwright" (Agente 2), la CLI standalone necesita además **Python 3 y `ruff`** en el `PATH` — se usan para verificar que el código generado compila y pasa lint antes de escribirlo al proyecto — y los **navegadores de Playwright para Node** (`npx playwright install chromium`, una sola vez tras instalar `agente-qa`) — Agente 2 abre un navegador real para verificar rutas y localizadores contra la aplicación bajo test antes de generar código. No hace falta para "Crear plan de pruebas" (Agente 1).
```

And replace this line:
```
- `playwright install` descarga los navegadores (Chromium/Firefox/WebKit) que usan los tests — sin esto, `pytest-playwright` falla al lanzar el primer test aunque el paquete esté instalado.
```
with:
```
- `playwright install` descarga los navegadores (Chromium/Firefox/WebKit) que usan los tests generados (Python `pytest-playwright`) — sin esto, `pytest-playwright` falla al lanzar el primer test aunque el paquete esté instalado.

`agente-qa` en sí (no los tests que genera) también controla un navegador real durante "Generar tests Playwright", para verificar rutas y localizadores contra la aplicación antes de escribir código — es un Playwright para Node, aparte del anterior. Una sola vez, tras instalar `agente-qa`:

```
npx playwright install chromium
```
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run cli/src/commands/generate.test.ts cli/src/commands/generate.e2e.test.ts`
Expected: PASS (7 tests; the e2e test's 1 test passes if Python+ruff are on PATH, otherwise shown as skipped)

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/generate.ts cli/src/commands/generate.test.ts cli/src/commands/generate.e2e.test.ts README.md
git commit -m "feat(cli): wire the real site explorer into 'Generar tests Playwright'"
```

---

## Task 10: Security audit (required before merging)

This feature automates real logins against the application under test and handles test credentials programmatically — CLAUDE.md requires a `seguridad-seo` pass before any work touching credentials/auth is considered done.

- [ ] Invoke the `seguridad-seo` skill against this branch's full diff (Tasks 1-9) and resolve every finding it raises (or explicitly park each one with a stated reason, per this project's "hecho" definition) before proceeding to `superpowers:finishing-a-development-branch`.

---

## Full verification (run once all tasks are complete)

```bash
npx tsc -p core/tsconfig.json --noEmit
npx tsc -p cli/tsconfig.json --noEmit
npx vitest run
```

All three must be clean/green — this is this project's definition of "hecho" (CLAUDE.md), together with Task 10's security pass.
