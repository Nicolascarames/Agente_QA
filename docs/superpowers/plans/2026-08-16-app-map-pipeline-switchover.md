# Pipeline Switchover to the App Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Intake and Generador read the app map instead of exploring and guessing, so a generated test asserts the text the application really shows on the screen the click really produces.

**Architecture:** The map produced by Agente 1 becomes the only source of truth. Intake writes English Gherkin whose quoted literals are copied from the map and whose scenarios declare which screen and state they run in; a pure lint rejects any literal the map does not contain. Generador stops writing Page Objects entirely — those already come from the map — and writes only step definitions that go through them. `core/src/siteExplorer/` is retired, the per-agent progress callbacks collapse into the event channel, and the README gains the five-agent walkthrough.

**Tech Stack:** TypeScript (ESM NodeNext), Zod v4, Playwright for Node, Vitest, inquirer (CLI only).

**Spec:** `docs/superpowers/specs/2026-08-15-agente-1-app-map-design.md` — sections 3, 6, 7, 8, 9, 10, 11 and 15. Task 1 additionally implements an amendment recorded below.

## Spec amendment implemented by this plan

The spec's §5.1 map schema records only the *result* of disambiguation (`disambiguatedBy`). Running the crawler against a real application showed that a human correcting a locator by hand, and a reviewer judging why a control was discarded, both need the raw DOM facts. Task 1 therefore adds a small set of **semantic** attributes to each locator entry.

The rule that governs which attributes qualify is unchanged and absolute: an attribute may be recorded and used when it says what the element *is* (`type`, `name`, `data-testid`, `role`, `id`), never when it says how it *looks* (`class`, `style`). A class is rewritten by any restyle without a single behavioural change, and under utility CSS it is not even unique — a locator built on one fails for reasons that have nothing to do with the application's behaviour.

## Global Constraints

- `core/src` never does terminal I/O — no `console.*`, no `readline`. Progress leaves through the injected `emit`; questions cross each agent's callbacks.
- Explicit DI: `core` functions take `projectRoot` as a parameter and never read `process.cwd()`. Tests use a real `fs.mkdtemp`, never a mocked `fs`.
- Relative imports carry the `.js` suffix even when the file is `.ts` (ESM NodeNext).
- Zod is v4: `z.record()` takes two arguments.
- Code, identifiers and commit messages in English; Conventional Commits. Everything the end user reads is Spanish (Spain).
- **Generated `.feature` files are English**, with quoted literals copied character for character from the map. The idiom is fixed; `appLanguage` no longer governs it.
- A locator is never disambiguated by position (`.first`, `.last`, `.nth`) nor by `class`.
- The Playwright Node API is camelCase; the Python that gets emitted is snake_case. Never unified.
- `cli` imports `core` as `@agente-qa/core`. If `tsc` cannot resolve it, run `npm run build --workspace=core` — never edit `cli/tsconfig.json`.
- Baseline to preserve: 621 passing, 3 skipped; `tsc` clean in both packages; full build green.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/appMap/schema.ts` | Gains `attributes` on a locator entry. |
| `core/src/appMap/realCrawler.ts` | Records those attributes at capture. |
| `core/src/appMap/mapQuery.ts` | Pure lookups every consumer needs: screen by id, all literals of a screen including its states, the texts a given click produces, a locator by name. |
| `core/src/prompts/intake.ts` | Rewritten Gherkin prompt: English, map-quoted literals, declared screen, state-aware assertions. |
| `core/src/agents/intake/checkFeatureLiterals.ts` | Pure lint: every quoted literal must exist in the declared screen or one of its states. |
| `core/src/agents/intake/runIntake.ts` | Requires the map, offers its candidate scenarios, drops the explorer. |
| `core/src/prompts/generador.ts` | Rewritten code prompt: step definitions only, Page Objects imported never written. |
| `core/src/codeCheck/pageFixtureLint.ts` | Pure lint: a step definition may not touch `page` directly. |
| `core/src/locatorVerify/mapFreshness.ts` | Revalidates only the locators a scenario uses; offers remap or manual override. |
| `core/src/agents/generador/runGenerador.ts` | Drops the explorer and Page Object generation; adds freshness + lint. |
| `cli/src/commands/chat.ts`, `generate.ts` | Wire the event channel and the new options. |
| `README.md` | The five-agent walkthrough. |

---

### Task 1: Record semantic attributes on every locator

**Files:**
- Modify: `core/src/appMap/schema.ts`
- Modify: `core/src/appMap/realCrawler.ts`
- Modify: `core/src/appMap/realCrawler.capture.test.ts`

**Interfaces:**
- Produces: `LocatorEntry.attributes?: Record<string, string>`.

- [ ] **Step 1: Write the failing test**

Add to `core/src/appMap/realCrawler.capture.test.ts`:

```ts
it("records the semantic attributes of a control", async () => {
  const page = await (await browser!.newContext()).newPage();
  await page.goto(site.url);
  const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
  const submit = screen.locators.find((l) => l.kind === "button" && l.python.includes("type"));
  expect(submit?.attributes?.type).toBe("submit");
  await page.close();
});

it("never records class or style, whatever the element carries", async () => {
  const page = await (await browser!.newContext()).newPage();
  await page.goto(site.url);
  const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
  for (const locator of screen.locators) {
    expect(Object.keys(locator.attributes ?? {})).not.toContain("class");
    expect(Object.keys(locator.attributes ?? {})).not.toContain("style");
  }
  await page.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: FAIL — `attributes` is undefined.

- [ ] **Step 3: Implement**

In `core/src/appMap/schema.ts`, add to `LocatorEntrySchema`:

```ts
  /**
   * Semantic attributes only: what the element IS, never how it looks.
   * A class is rewritten by any restyle without a behavioural change, and
   * under utility CSS it is not even unique.
   */
  attributes: z.record(z.string(), z.string()).optional(),
```

In `core/src/appMap/realCrawler.ts`, add near the other helpers and call it when building each `LocatorEntry`:

```ts
const SEMANTIC_ATTRIBUTES = ["type", "name", "id", "role", "data-testid"] as const;

async function semanticAttributes(handle: Locator): Promise<Record<string, string> | undefined> {
  const found: Record<string, string> = {};
  for (const name of SEMANTIC_ATTRIBUTES) {
    const value = (await handle.getAttribute(name, { timeout: SHORT_READ_TIMEOUT_MS }).catch(() => null)) ?? "";
    if (value.trim().length > 0) found[name] = value.trim();
  }
  return Object.keys(found).length > 0 ? found : undefined;
}
```

Attribute values pass through `redactText` with the capture's secrets, exactly like every other string on the screen.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap
git commit -m "feat(core): record the semantic attributes of each mapped locator"
```

---

### Task 2: Map query helpers

**Files:**
- Create: `core/src/appMap/mapQuery.ts`
- Create: `core/src/appMap/mapQuery.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `AppMap`, `Screen`, `LocatorEntry` from `./schema.js`.
- Produces: `findScreen(map, screenId): Screen | null`; `screenLiterals(map, screenId): string[]`; `textsAfterClick(map, screenId, locatorName): string[]`; `findLocator(map, screenId, locatorName): LocatorEntry | null`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/mapQuery.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findScreen, screenLiterals, textsAfterClick, findLocator } from "./mapQuery.js";
import type { AppMap } from "./schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Email"], probeValues: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "forgot_button", kind: "button", accessibleName: "Forgot password?",
      python: 'page.get_by_role("button", name="Forgot password?", exact=True)', count: 1, verifiedAt: "t" }],
    states: [{ id: "click-forgot_button",
      reachedBy: { action: "click", locator: "forgot_button", data: "none" },
      addsTexts: ["Reset password", "Send reset link"] }],
  }],
};

describe("findScreen", () => {
  it("finds a screen by id", () => expect(findScreen(map, "login")?.name).toBe("Log in"));
  it("returns null for an unknown id", () => expect(findScreen(map, "nope")).toBeNull());
});

describe("screenLiterals", () => {
  it("includes the screen's own texts and every state's texts", () => {
    expect(screenLiterals(map, "login")).toEqual(
      expect.arrayContaining(["Welcome back", "Email", "Reset password", "Send reset link"])
    );
  });
  it("returns an empty list for an unknown screen", () => expect(screenLiterals(map, "nope")).toEqual([]));
});

describe("textsAfterClick", () => {
  it("returns the texts a click produces, not the ones already on screen", () => {
    expect(textsAfterClick(map, "login", "forgot_button")).toEqual(["Reset password", "Send reset link"]);
  });
  it("returns an empty list when the locator produces no state", () => {
    expect(textsAfterClick(map, "login", "unknown_button")).toEqual([]);
  });
});

describe("findLocator", () => {
  it("finds a locator by name", () => {
    expect(findLocator(map, "login", "forgot_button")?.kind).toBe("button");
  });
  it("returns null when the screen has no such locator", () => {
    expect(findLocator(map, "login", "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/mapQuery.test.ts`
Expected: FAIL — cannot resolve `./mapQuery.js`.

- [ ] **Step 3: Implement**

`core/src/appMap/mapQuery.ts`:

```ts
import type { AppMap, LocatorEntry, Screen } from "./schema.js";

export function findScreen(map: AppMap, screenId: string): Screen | null {
  return map.screens.find((screen) => screen.id === screenId) ?? null;
}

/**
 * Every text a scenario on this screen may legitimately quote: what the screen
 * shows on arrival PLUS what any of its states adds. An error message exists
 * only after a bad submit, and a reset panel only after a click — both are
 * still literals of this screen, and a test is entitled to assert them.
 */
export function screenLiterals(map: AppMap, screenId: string): string[] {
  const screen = findScreen(map, screenId);
  if (!screen) return [];
  const fromStates = screen.states.flatMap((state) => state.addsTexts);
  return Array.from(new Set([...screen.texts, ...fromStates]));
}

/** The texts that appear as a direct result of clicking one locator. */
export function textsAfterClick(map: AppMap, screenId: string, locatorName: string): string[] {
  const screen = findScreen(map, screenId);
  if (!screen) return [];
  return screen.states
    .filter((state) => state.reachedBy.locator === locatorName && state.reachedBy.action === "click")
    .flatMap((state) => state.addsTexts);
}

export function findLocator(map: AppMap, screenId: string, locatorName: string): LocatorEntry | null {
  return findScreen(map, screenId)?.locators.find((l) => l.name === locatorName) ?? null;
}
```

Add to `core/src/index.ts` as its own group:

```ts
export { findScreen, screenLiterals, textsAfterClick, findLocator } from "./appMap/mapQuery.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/mapQuery.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/mapQuery.ts core/src/appMap/mapQuery.test.ts core/src/index.ts
git commit -m "feat(core): add pure map lookups for the downstream agents"
```

---

### Task 3: The Gherkin contract

**Files:**
- Modify: `core/src/prompts/intake.ts`
- Modify: `core/src/prompts/intake.test.ts`

**Interfaces:**
- Consumes: `AppMap` from `../appMap/schema.js`; `screenLiterals`, `textsAfterClick` from `../appMap/mapQuery.js`.
- Produces: `gherkinGenerationPrompt(text: string, map: AppMap, screenId: string): string` — the `matchedPattern`, `appLanguage` and `evidence` parameters are gone.

- [ ] **Step 1: Write the failing test**

Replace the existing prompt tests in `core/src/prompts/intake.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { gherkinGenerationPrompt } from "./intake.js";
import type { AppMap } from "../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: true, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Email", "Password"],
    probeValues: ["agente-qa-probe@example.invalid"],
    ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "log_in_button", kind: "button", accessibleName: "Log in",
      python: 'page.get_by_role("button", name="Log in", exact=True)', count: 1, verifiedAt: "t" }],
    states: [{ id: "invalid-submit",
      reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
      addsTexts: ["Authentication failed. Please try again."] }],
  }],
};

describe("gherkinGenerationPrompt", () => {
  it("demands English", () => {
    expect(gherkinGenerationPrompt("probar login", map, "login")).toMatch(/English|inglés/);
  });

  it("offers the screen's own texts and its states' texts as the only quotable literals", () => {
    const prompt = gherkinGenerationPrompt("probar login", map, "login");
    expect(prompt).toContain("Welcome back");
    expect(prompt).toContain("Authentication failed. Please try again.");
  });

  it("says which text each click produces, so a Then can assert the destination", () => {
    const prompt = gherkinGenerationPrompt("probar login", map, "login");
    expect(prompt).toMatch(/log_in_button[\s\S]*Authentication failed/);
  });

  it("never leaks the crawler's own probe values", () => {
    expect(gherkinGenerationPrompt("probar login", map, "login")).not.toContain("agente-qa-probe@example.invalid");
  });

  it("declares the screen tag the scenario must carry", () => {
    expect(gherkinGenerationPrompt("probar login", map, "login")).toContain("@screen:login");
  });

  it("forbids quoting anything that is not in the list", () => {
    expect(gherkinGenerationPrompt("probar login", map, "login")).toMatch(/no inventes|do not invent/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/prompts/intake.test.ts`
Expected: FAIL — the signature does not accept a map.

- [ ] **Step 3: Implement**

Replace `gherkinGenerationPrompt` in `core/src/prompts/intake.ts`:

```ts
import type { AppMap } from "../appMap/schema.js";
import { findScreen, screenLiterals, textsAfterClick } from "../appMap/mapQuery.js";

export function gherkinGenerationPrompt(text: string, map: AppMap, screenId: string): string {
  const screen = findScreen(map, screenId);
  if (!screen) throw new Error(`La pantalla "${screenId}" no existe en el mapa.`);

  const literals = screenLiterals(map, screenId)
    .filter((literal) => !screen.probeValues.includes(literal))
    .map((literal) => `  - ${JSON.stringify(literal)}`)
    .join("\n");

  const clicks = screen.locators
    .filter((locator) => locator.kind === "button" || locator.kind === "link")
    .map((locator) => {
      const after = textsAfterClick(map, screenId, locator.name)
        .filter((literal) => !screen.probeValues.includes(literal));
      const effect = after.length > 0
        ? `hace aparecer: ${after.map((a) => JSON.stringify(a)).join(", ")}`
        : "no se registró ningún cambio de contenido";
      return `  - ${locator.name} (${JSON.stringify(locator.accessibleName ?? locator.name)}) → ${effect}`;
    })
    .join("\n");

  const fields = screen.locators
    .filter((locator) => locator.kind === "input" || locator.kind === "select")
    .map((locator) => `  - ${JSON.stringify(locator.accessibleName ?? locator.name)}`)
    .join("\n");

  return `Eres un ingeniero de QA. Escribe un plan de pruebas en Gherkin para esta petición:

"""
${text}
"""

Transcurre en la pantalla "${screen.name}" del mapa de la aplicación, recorrida con un
navegador real. Estos son los ÚNICOS textos que existen de verdad en esa pantalla:

${literals}

Campos que se pueden rellenar:

${fields.length > 0 ? fields : "  (ninguno)"}

Qué provoca cada acción — úsalo para que cada Then afirme sobre el DESTINO, no sobre el
elemento que se acaba de pulsar:

${clicks.length > 0 ? clicks : "  (ninguna)"}

Reglas, todas obligatorias:

1. Escribe el Gherkin en INGLÉS: la prosa de los pasos y los títulos de escenario.
2. Todo texto entre comillas debe estar copiado LETRA POR LETRA de las listas de arriba.
   No inventes ningún texto de interfaz: si no está en la lista, no existe.
3. Cada escenario lleva la etiqueta @screen:${screen.id}.
4. Un Then afirma lo que aparece DESPUÉS de la acción. Si pulsas un elemento y la lista
   dice qué hace aparecer, afirma ese texto — nunca el nombre del elemento que pulsaste,
   porque tras la acción puede haber desaparecido.
5. Usa este vocabulario de pasos:
     Given I am on the "<pantalla>" screen
     When  I fill "<campo>" with "<valor>"
     When  I click "<elemento>"
     Then  I see "<texto>"
     Then  I do not see "<texto>"

Responde SOLO con el JSON: {"fileName": "kebab-case.feature", "featureText": "..."}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/prompts/intake.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/intake.ts core/src/prompts/intake.test.ts
git commit -m "feat(core): ground the Gherkin prompt in the map, states included"
```

---

### Task 4: The literal lint

**Files:**
- Create: `core/src/agents/intake/checkFeatureLiterals.ts`
- Create: `core/src/agents/intake/checkFeatureLiterals.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `AppMap` from `../../appMap/schema.js`; `screenLiterals` from `../../appMap/mapQuery.js`.
- Produces: `checkFeatureLiterals(featureText: string, map: AppMap): { missing: { literal: string; screenId: string }[]; candidates: string[] }`.

- [ ] **Step 1: Write the failing test**

`core/src/agents/intake/checkFeatureLiterals.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkFeatureLiterals } from "./checkFeatureLiterals.js";
import type { AppMap } from "../../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Email"], probeValues: [], locators: [],
    ambiguous: [], transitions: [], writeActions: [],
    states: [{ id: "invalid", reachedBy: { action: "submit", locator: "b", data: "invalid" },
      addsTexts: ["Authentication failed. Please try again."] }],
  }],
};

const feature = (body: string) => `Feature: Log in\n\n  @screen:login\n  Scenario: S\n${body}`;

describe("checkFeatureLiterals", () => {
  it("accepts a literal present in the screen's texts", () => {
    expect(checkFeatureLiterals(feature('    Then I see "Welcome back"\n'), map).missing).toEqual([]);
  });

  it("accepts a literal that only exists in one of the screen's states", () => {
    const text = feature('    Then I see "Authentication failed. Please try again."\n');
    expect(checkFeatureLiterals(text, map).missing).toEqual([]);
  });

  it("rejects a literal the map does not contain", () => {
    const result = checkFeatureLiterals(feature('    Then I see "Invalid email or password"\n'), map);
    expect(result.missing).toEqual([{ literal: "Invalid email or password", screenId: "login" }]);
  });

  it("offers the real texts as candidates so the caller can show them", () => {
    const result = checkFeatureLiterals(feature('    Then I see "Nope"\n'), map);
    expect(result.candidates).toContain("Welcome back");
  });

  it("reports a scenario whose declared screen is not in the map", () => {
    const text = `Feature: X\n\n  @screen:ghost\n  Scenario: S\n    Then I see "Anything"\n`;
    expect(checkFeatureLiterals(text, map).missing).toEqual([{ literal: "Anything", screenId: "ghost" }]);
  });

  it("ignores a scenario with no screen tag rather than crashing", () => {
    const text = `Feature: X\n\n  Scenario: S\n    Then I see "Anything"\n`;
    expect(checkFeatureLiterals(text, map).missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/agents/intake/checkFeatureLiterals.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`core/src/agents/intake/checkFeatureLiterals.ts`:

```ts
import type { AppMap } from "../../appMap/schema.js";
import { screenLiterals } from "../../appMap/mapQuery.js";

export interface MissingLiteral {
  literal: string;
  screenId: string;
}

export interface FeatureLiteralCheck {
  missing: MissingLiteral[];
  candidates: string[];
}

const SCREEN_TAG = /@screen:([\p{L}\p{N}_-]+)/u;

/**
 * The gate that stops an invented literal from ever reaching a generated test.
 * It runs on the .feature, which is the file a human can still fix — by the
 * time the code exists the value is baked into an assertion.
 */
export function checkFeatureLiterals(featureText: string, map: AppMap): FeatureLiteralCheck {
  const missing: MissingLiteral[] = [];
  const candidates = new Set<string>();
  let currentScreen: string | null = null;

  for (const rawLine of featureText.split(/\r?\n/)) {
    const line = rawLine.trim();

    const tag = line.match(SCREEN_TAG);
    if (tag) {
      currentScreen = tag[1];
      for (const literal of screenLiterals(map, currentScreen)) candidates.add(literal);
      continue;
    }
    if (/^(Feature|Scenario Outline|Scenario):/i.test(line) && !SCREEN_TAG.test(line)) {
      if (/^Feature:/i.test(line)) currentScreen = null;
      continue;
    }
    if (currentScreen === null) continue;

    const allowed = screenLiterals(map, currentScreen);
    for (const quoted of line.matchAll(/"([^"]*)"/g)) {
      const literal = quoted[1];
      if (literal.length === 0) continue;
      if (!allowed.includes(literal)) missing.push({ literal, screenId: currentScreen });
    }
  }

  return { missing, candidates: Array.from(candidates) };
}
```

Add to `core/src/index.ts`:

```ts
export { checkFeatureLiterals } from "./agents/intake/checkFeatureLiterals.js";
export type { MissingLiteral, FeatureLiteralCheck } from "./agents/intake/checkFeatureLiterals.js";
```

Note: a step's *data* values (an email typed into a field) are also quoted and will be reported as missing. Task 5 resolves this by only checking literals in `Then` steps and in `I click "…"` — assertions and element names — never the value half of a `fill`. Implement that filter here: skip the value in a line matching `I fill "…" with "…"` (the second quoted group).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/agents/intake/checkFeatureLiterals.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/intake/checkFeatureLiterals.ts core/src/agents/intake/checkFeatureLiterals.test.ts core/src/index.ts
git commit -m "feat(core): reject a Gherkin literal the map does not contain"
```

---

### Task 5: Intake reads the map

**Files:**
- Modify: `core/src/agents/intake/runIntake.ts`
- Modify: `core/src/agents/intake/runIntake.test.ts`
- Modify: `core/src/agents/intake/gherkinGenerator.ts`

**Interfaces:**
- Consumes: `loadAppMap`, `checkFeatureLiterals`, `gherkinGenerationPrompt`, `EmitEvent`.
- Produces: `RunIntakeOptions` becomes `{ initialText, llm, projectRoot, testsDir, callbacks, emit }`; `IntakeCallbacks` becomes `{ askUser, chooseScenario, presentForApproval, confirmOverwrite }`; `chooseScenario(candidates: ScenarioCandidate[]): Promise<ScenarioCandidate | null>` returns `null` when the user prefers to type their own request.

- [ ] **Step 1: Write the failing test**

Replace the exploration-related tests in `core/src/agents/intake/runIntake.test.ts` with:

```ts
it("stops with an actionable message when there is no map", async () => {
  await expect(runIntake({
    initialText: "probar login", llm: new FakeLLMProvider(["{}"]),
    projectRoot, testsDir: "tests", callbacks, emit: () => {},
  })).rejects.toThrow(/agente-qa map/);
});

it("offers the map's candidate scenarios before asking for free text", async () => {
  await saveAppMap(projectRoot, mapWithScenario);
  let offered = 0;
  await runIntake({
    initialText: "", llm: new FakeLLMProvider([validPlanJson]),
    projectRoot, testsDir: "tests", emit: () => {},
    callbacks: { ...callbacks, chooseScenario: async (list) => { offered = list.length; return list[0]; } },
  });
  expect(offered).toBe(1);
});

it("regenerates instead of presenting a plan whose literal is not in the map", async () => {
  await saveAppMap(projectRoot, mapWithScenario);
  const llm = new FakeLLMProvider([invented, grounded]);
  const presented: string[] = [];
  await runIntake({
    initialText: "probar login", llm, projectRoot, testsDir: "tests", emit: () => {},
    callbacks: { ...callbacks, presentForApproval: async (plan) => { presented.push(plan.featureText); return { approved: true }; } },
  });
  expect(presented).toHaveLength(1);
  expect(presented[0]).toContain("Authentication failed. Please try again.");
});
```

Build `mapWithScenario`, `validPlanJson`, `invented` and `grounded` as local fixtures in that file: `invented` quotes `"Invalid email or password"`, `grounded` quotes `"Authentication failed. Please try again."`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/agents/intake/runIntake.test.ts`
Expected: FAIL — the options shape does not match.

- [ ] **Step 3: Implement**

Rewrite `runIntake`:

```ts
export interface IntakeCallbacks {
  askUser(question: string): Promise<string>;
  chooseScenario(candidates: ScenarioCandidate[]): Promise<ScenarioCandidate | null>;
  presentForApproval(plan: GherkinPlan): Promise<{ approved: boolean; feedback?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}

export interface RunIntakeOptions {
  initialText: string;
  llm: LLMProvider;
  projectRoot: string;
  testsDir: string;
  callbacks: IntakeCallbacks;
  emit: EmitEvent;
}

const MAX_GROUNDING_ATTEMPTS = 3;

export async function runIntake(options: RunIntakeOptions): Promise<{ plan: GherkinPlan; filePath: string }> {
  const { llm, projectRoot, testsDir, callbacks, emit } = options;

  const map = await loadAppMap(projectRoot);
  if (!map) {
    throw new Error(
      'No hay mapa de la aplicación. Ejecuta "agente-qa map" antes de crear un plan de pruebas: sin él, los textos esperados serían inventados.'
    );
  }

  let text = options.initialText;
  let screenId = map.screens[0]?.id ?? "";

  if (map.scenarios.length > 0) {
    const chosen = await callbacks.chooseScenario(map.scenarios);
    if (chosen) {
      text = chosen.title;
      screenId = chosen.screenId;
    }
  }

  const ambiguity = await checkAmbiguity(text, llm);
  if (ambiguity.ambiguous) {
    const answers: string[] = [];
    for (const question of ambiguity.questions) {
      answers.push(`${question}\n${await callbacks.askUser(question)}`);
    }
    text = `${text}\n\nAclaraciones:\n${answers.join("\n\n")}`;
  }

  let plan = await generateGherkin(text, llm, map, screenId);

  for (let attempt = 1; attempt <= MAX_GROUNDING_ATTEMPTS; attempt++) {
    const { missing, candidates } = checkFeatureLiterals(plan.featureText, map);
    if (missing.length === 0) break;
    emit({
      agent: "intake", status: "warn", depth: 1,
      message: `${missing.length} texto(s) no existen en la aplicación, regenerando`,
      detail: missing.map((m) => `"${m.literal}"`).join(", "),
    });
    if (attempt === MAX_GROUNDING_ATTEMPTS) {
      throw new Error(
        `El plan sigue esperando textos que no existen en la aplicación: ${missing
          .map((m) => `"${m.literal}"`)
          .join(", ")}.\nTextos reales de esa pantalla: ${candidates.slice(0, 20).join(" · ")}`
      );
    }
    text = `${text}\n\nEstos textos NO existen en la aplicación y no debes usarlos: ${missing
      .map((m) => `"${m.literal}"`)
      .join(", ")}`;
    plan = await generateGherkin(text, llm, map, screenId);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const decision = await callbacks.presentForApproval(plan);
    if (decision.approved) break;
    text = `${text}\n\nPlan anterior:\n"""\n${plan.featureText}\n"""\n\nCambios solicitados:\n${decision.feedback ?? ""}`;
    plan = await generateGherkin(text, llm, map, screenId);
  }

  const alreadyExists = await featureFileExists(projectRoot, testsDir, plan.fileName);
  if (alreadyExists) {
    const targetPath = featureFilePath(projectRoot, testsDir, plan.fileName);
    if (!(await callbacks.confirmOverwrite(targetPath))) {
      throw new Error(`Cancelado: ya existe ${targetPath} y no se sobrescribió.`);
    }
  }

  const filePath = await writeFeatureFile(projectRoot, testsDir, plan);
  emit({ agent: "intake", status: "ok", depth: 0, message: `Plan escrito en ${filePath}` });
  return { plan, filePath };
}
```

Change `generateGherkin` in `gherkinGenerator.ts` to take `(text, llm, map, screenId)` and call the new prompt. Delete the pattern, `appLanguage` and evidence parameters, and delete the `# agente-qa:pattern=` header from `writeFeatureFile` — the `@screen:` tag replaces it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/agents/intake`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/intake
git commit -m "feat(core): make Intake read the map and refuse ungrounded literals"
```

---

### Task 6: Map freshness check

**Files:**
- Create: `core/src/locatorVerify/mapFreshness.ts`
- Create: `core/src/locatorVerify/mapFreshness.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `AppMap`, `findScreen`, `LocatorVerifier`, `LocatorCheck`.
- Produces: `locatorsUsedBy(featureText: string, map: AppMap): { screenId: string; locator: LocatorEntry }[]`; `checkMapFreshness(used, verifier, baseUrl, credentials): Promise<{ ok: true } | { ok: false; stale: { screenId: string; name: string; count: number }[] }>`.

- [ ] **Step 1: Write the failing test**

`core/src/locatorVerify/mapFreshness.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { locatorsUsedBy, checkMapFreshness } from "./mapFreshness.js";
import { FakeLocatorVerifier } from "./testUtils.js";
import type { AppMap } from "../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 2, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back"], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [
      { name: "log_in_button", kind: "button", accessibleName: "Log in",
        python: 'page.get_by_role("button", name="Log in", exact=True)', count: 1, verifiedAt: "t" },
      { name: "email_input", kind: "input", accessibleName: "Email",
        python: 'page.get_by_role("textbox", name="Email", exact=True)', count: 1, verifiedAt: "t" },
    ],
  }],
};

const feature = `Feature: F\n\n  @screen:login\n  Scenario: S\n    When I click "Log in"\n    Then I see "Welcome back"\n`;

describe("locatorsUsedBy", () => {
  it("picks only the locators the scenario actually names", () => {
    const used = locatorsUsedBy(feature, map);
    expect(used.map((u) => u.locator.name)).toEqual(["log_in_button"]);
  });

  it("returns nothing for a scenario with no screen tag", () => {
    expect(locatorsUsedBy(`Feature: F\n  Scenario: S\n    When I click "Log in"\n`, map)).toEqual([]);
  });
});

describe("checkMapFreshness", () => {
  it("passes when every used locator still resolves to one element", async () => {
    const verifier = new FakeLocatorVerifier({ ok: true });
    const result = await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(true);
  });

  it("reports the stale locator by name and screen when it no longer resolves", async () => {
    const verifier = new FakeLocatorVerifier({ ok: false, errors: 'log_in_button: 0 coincidencias' });
    const result = await checkMapFreshness(locatorsUsedBy(feature, map), verifier, "https://example.test/", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stale[0].name).toBe("log_in_button");
  });
});
```

Match `FakeLocatorVerifier`'s real constructor rather than changing it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/mapFreshness.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`core/src/locatorVerify/mapFreshness.ts` — parse the `@screen:` tag, collect every name quoted in an `I click "…"` or `I fill "…" with` step, resolve each against that screen's locators by `accessibleName` then by `name`, and hand the resulting `LocatorCheck[]` to the existing verifier. On failure, map the verifier's error text back to the locator names it mentions so the caller can offer a per-locator override.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/locatorVerify/mapFreshness.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/locatorVerify/mapFreshness.ts core/src/locatorVerify/mapFreshness.test.ts core/src/index.ts
git commit -m "feat(core): revalidate only the locators a scenario uses"
```

---

### Task 7: Step definitions only, and the direct-page lint

**Files:**
- Modify: `core/src/prompts/generador.ts`
- Modify: `core/src/prompts/generador.test.ts`
- Create: `core/src/codeCheck/pageFixtureLint.ts`
- Create: `core/src/codeCheck/pageFixtureLint.test.ts`
- Modify: `core/src/codeCheck/realCodeChecker.ts`

**Interfaces:**
- Produces: `codeGenerationPrompt(featureText: string, map: AppMap, screenId: string, naming: CodeGenerationNaming, retry?: CodeGenerationRetry): string`; `checkNoDirectPageUse(files: CodeFile[]): string[]`.

- [ ] **Step 1: Write the failing tests**

`core/src/codeCheck/pageFixtureLint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkNoDirectPageUse } from "./pageFixtureLint.js";

describe("checkNoDirectPageUse", () => {
  it("accepts a step definition that goes through the Page Object", () => {
    const files = [{ path: "tests/test_login.py", content: 'def s(login_page):\n    login_page.click_log_in_button()\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });

  it("rejects a step definition that builds its own locator", () => {
    const files = [{ path: "tests/test_login.py", content: 'def s(page):\n    expect(page.get_by_role("alert")).to_be_visible()\n' }];
    expect(checkNoDirectPageUse(files)[0]).toMatch(/page\./);
  });

  it("allows page-level assertions that cannot come from a Page Object", () => {
    const files = [{ path: "tests/test_login.py", content: 'def s(page):\n    expect(page).to_have_url("/x")\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });

  it("ignores comments", () => {
    const files = [{ path: "tests/test_login.py", content: '# page.get_by_text("x")\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });

  it("does not inspect files under pages/", () => {
    const files = [{ path: "pages/login_page.py", content: 'return self.page.get_by_role("button")\n' }];
    expect(checkNoDirectPageUse(files)).toEqual([]);
  });
});
```

Prompt tests in `core/src/prompts/generador.test.ts`: assert the prompt lists the Page Object's methods, states that `pages/` already exists and must not be written, forbids `page.get_by_*` in step definitions, and names the module to import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/codeCheck/pageFixtureLint.test.ts core/src/prompts/generador.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`core/src/codeCheck/pageFixtureLint.ts`:

```ts
import type { CodeFile } from "./codeChecker.js";

const DIRECT_LOCATOR = /\bpage\.(get_by_|locator\()/;

/**
 * A step definition may not build its own locator. Every locator in this system
 * was validated against a real browser and lives in a Page Object generated from
 * the map; one written by hand here is exactly the invention the map exists to
 * prevent. `expect(page)` for a page-level assertion stays allowed.
 */
export function checkNoDirectPageUse(files: CodeFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith("tests/")) continue;
    file.content.split(/\r?\n/).forEach((line, index) => {
      if (line.trim().startsWith("#")) return;
      if (DIRECT_LOCATOR.test(line)) {
        problems.push(
          `${file.path}:${index + 1}: un step definition no puede construir su propio localizador (${line.trim()}). Usa un método del Page Object.`
        );
      }
    });
  }
  return problems;
}
```

Fold it into `createRealCodeChecker` beside the existing locator lint, so a violation returns `ok: false` with these messages and feeds the retry loop.

Rewrite `codeGenerationPrompt` to receive the map and the screen, list the Page Object's class name, module path and available methods, and state plainly that `pages/` is generated and must never be written.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run core/src/codeCheck core/src/prompts/generador.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/codeCheck core/src/prompts/generador.ts core/src/prompts/generador.test.ts
git commit -m "feat(core): generate step definitions only, and forbid hand-built locators"
```

---

### Task 8: Generador reads the map

**Files:**
- Modify: `core/src/agents/generador/runGenerador.ts`
- Modify: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Produces: `RunGeneradorOptions` becomes `{ featureFilePath, llm, checker, verifier, projectRoot, testsDir, baseUrl, credentials, callbacks, emit }`; `GeneratorCallbacks` becomes `{ confirmOverwrite, onStaleLocator }`, where `onStaleLocator(stale): Promise<{ action: "remap" } | { action: "override"; python: string }>`.

- [ ] **Step 1: Write the failing test**

Assert, in `runGenerador.test.ts`: it throws with an actionable message when there is no map; it never writes a file under `pages/`; a stale locator triggers `onStaleLocator` and an `override` answer is persisted through `saveOverride`; a `remap` answer aborts with a message naming `agente-qa map`; and the retry loop still runs for a compilation failure.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Load the map, read the `@screen:` tag from the feature, run `checkMapFreshness` on the locators the scenario uses, route a stale result through `onStaleLocator`, then generate only `tests/*.py` in the existing retry loop with `checker` (now including the new lint). Delete every reference to `explorer`, `patterns`, `appLanguage`, `routes`, `extractLocatorChecks`, `checkExpectedLiterals` and the Page Object emission path.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/agents/generador`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/generador
git commit -m "feat(core): make Generador consume the map and stop writing Page Objects"
```

---

### Task 9: Retire the site explorer

**Files:**
- Delete: `core/src/siteExplorer/` (all ten files)
- Delete: `core/src/locatorVerify/extractLocatorChecks.ts`, `checkExpectedLiterals.ts` and their tests
- Modify: `core/src/schemas/pattern.ts`, `core/src/patterns/registry.ts`, `core/src/patterns/applyProjectRoute.ts`, `core/src/index.ts`
- Modify: `core/src/config/projectConfig.ts`

**Interfaces:**
- Produces: `PatternSchema` keeps only `name`, `description`, `gherkinTemplate`.

- [ ] **Step 1: Write the failing test**

In `core/src/index.test.ts`, assert the barrel no longer exports `FakeSiteExplorer`, `createRealSiteExplorer`, `extractLocatorChecks` or `checkExpectedLiterals`, and that `PatternSchema.parse` rejects an object carrying `navigationHints`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/index.test.ts`
Expected: FAIL — the exports still exist.

- [ ] **Step 3: Implement**

Delete the files, strip `pageObjectTemplate` and `navigationHints` from `PatternSchema` (and `applyProjectRoute`, whose only purpose was the hints), remove the exports, and delete `appLanguage` from `ProjectConfigSchema`'s consumers — keep the field itself in the schema so existing `config.json` files still parse, marked deprecated in a comment.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run` — expect a lower total than the baseline, since deleted modules take their tests with them; no failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(core): retire the site explorer now the map replaces it"
```

---

### Task 10: The event channel in every agent

**Files:**
- Modify: `core/src/agents/ejecutor/runEjecutor.ts`, `core/src/agents/reportes/runReportes.ts`
- Modify: `cli/src/commands/chat.ts`, `generate.ts`, `execute.ts`, `reports.ts`

**Interfaces:**
- Produces: every `run*` takes `emit: EmitEvent`; `ExecutorCallbacks` and `ReportesCallbacks` lose their ad-hoc progress members.

- [ ] **Step 1: Write the failing test**

Assert in each agent's test that a step emits at least one `{ agent, status: "ok" }` event through the injected `emit`, and in the CLI tests that the printed line comes from `formatAgentEvent`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/agents cli/src/commands`
Expected: FAIL.

- [ ] **Step 3: Implement**

Thread `emit` through both remaining agents, replace the ad-hoc progress callbacks, and in the CLI pass `(event) => console.log(formatAgentEvent(event))` at each call site, mirroring `cli/src/commands/map.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src cli/src
git commit -m "feat(core): route every agent's progress through the event channel"
```

---

### Task 11: README and renumbering

**Files:**
- Modify: `README.md`
- Modify: `cli/src/prompts/inquirerPrompts.ts` (menu labels only)

**Interfaces:**
- Produces: nothing consumed by code.

- [ ] **Step 1: Write the failing test**

Add `README.test.ts` under `core/src/` asserting the README names all five agents in order and mentions `agente-qa map` before `agente-qa chat`:

```ts
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

describe("README", () => {
  it("documents the five agents in order", async () => {
    const readme = await fs.readFile(path.join(process.cwd(), "README.md"), "utf-8");
    const order = ["Agente 1", "Agente 2", "Agente 3", "Agente 4", "Agente 5"];
    let cursor = -1;
    for (const label of order) {
      const next = readme.indexOf(label);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/README.test.ts`
Expected: FAIL — the README names no agents.

- [ ] **Step 3: Implement**

Add a section after "Arquitectura" walking through the five agents in prose: what each one does, in what order, what it produces and what it needs. Agente 1 Explorador (map + Page Objects, must run first), Agente 2 Intake (English Gherkin grounded in the map), Agente 3 Generador (step definitions only), Agente 4 Ejecutor, Agente 5 Reportes. Include the security warning about mapping with a test account and the note that the map and Page Objects are committed. Update the menu labels to carry the new numbers.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/README.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

```bash
npm run build --workspace=core
npx tsc -p core/tsconfig.json --noEmit
npx tsc -p cli/tsconfig.json --noEmit
npx vitest run
git add README.md cli/src core/src/README.test.ts
git commit -m "docs: document the five-agent pipeline end to end"
```

---

## Self-Review

**Spec coverage:** §3 renumbering → Task 11. §6 Gherkin contract → Tasks 3, 4. §7 Intake → Task 5. §8 Generador → Tasks 6, 7, 8. §9 agents 4 and 5 → Task 10. §10 event channel → Task 10. §11 removals → Task 9. §15 README → Task 11. The amendment on semantic attributes → Task 1. Map lookups shared by Tasks 3-8 → Task 2.

**Ordering constraint:** Task 9 deletes modules that Tasks 5 and 8 stop referencing, so it must run after both — running it earlier breaks compilation between tasks.

**Known follow-up, deliberately out of scope:** the Playwright MCP surface for the Claude Code plugin (a separate spec), and re-running `init` overwriting an existing `config.json` including accumulated `routes`.
