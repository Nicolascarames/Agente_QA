# Agente 1 — Mapa de la aplicación (núcleo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the new Agente 1 (Explorador): a crawler that walks the whole app under test and persists a map of screens, texts, browser-validated locators and click transitions, from which Page Objects are emitted by a deterministic template with no LLM involved.

**Architecture:** A new `core/src/appMap/` module holds the map schema (Zod), the pure algorithms (URL templating, screen signature, loop detection, state merging, locator naming, Page Object emission, overrides, secret redaction) and the crawler behind the project's usual DI seam (interface + Fake + real Playwright implementation). `core/src/agents/explorador/runExplorador.ts` orchestrates it. A new one-way typed event channel (`core/src/events/`) carries step-by-step progress out of `core` without any terminal I/O, and the CLI renders it with check marks.

**Tech Stack:** TypeScript (ESM NodeNext), Zod v4, Playwright for Node (already a `core` dependency), Vitest, inquirer (CLI only).

**Spec:** `docs/superpowers/specs/2026-08-15-agente-1-app-map-design.md`

## Global Constraints

- `core/src` never does terminal I/O — no `console.*`, no `readline`. Human interaction crosses injected callbacks; progress output crosses the event channel.
- Explicit DI: `core` functions take `projectRoot` as a parameter and never read `process.cwd()`.
- Relative imports carry the `.js` suffix even when the file is `.ts`.
- Node floor `>=22`. Zod is v4: `z.record()` requires two arguments.
- Code, identifiers and commit messages in English; Conventional Commits. User-facing CLI strings in Spanish (España).
- Secrets never land in a versioned file. `.agente-qa/` files are written 0700 (dirs) / 0600 (files).
- Tests use real `fs.mkdtemp`, never a mocked `fs`.
- Verify with `npx vitest run <path>`, `npx tsc -p core/tsconfig.json --noEmit`, `npx tsc -p cli/tsconfig.json --noEmit`.

**Out of scope for this plan** (covered by the follow-up plan `2026-08-16-app-map-pipeline-switchover.md`): rewiring Agente 2/Intake and Agente 3/Generador to consume the map, retiring `core/src/siteExplorer/`, migrating the four existing agents to the event channel, and the README rewrite.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/events/agentEvent.ts` | Event types + `noopEmit`. One-way progress channel. |
| `cli/src/util/renderEvent.ts` | Turns an `AgentEvent` into a printable line. CLI-only. |
| `core/src/appMap/schema.ts` | Zod schemas + inferred types for the whole map and the overrides file. |
| `core/src/appMap/urlTemplate.ts` | Collapses variable URL segments into a template. |
| `core/src/appMap/signature.ts` | Normalized accessibility-tree fingerprint + loop detection. |
| `core/src/appMap/elementIdentity.ts` | Element key (never click the same thing twice) + state merging. |
| `core/src/appMap/naming.ts` | Deterministic screen/locator identifier slugs, collision-free. |
| `core/src/appMap/pageObjectEmitter.ts` | Screen → Python Page Object source. |
| `core/src/appMap/mapStore.ts` | Read/write `map.json` on disk, with permissions and gitignore wiring. |
| `core/src/appMap/overrides.ts` | Read/write `overrides.json`, reapply onto a fresh map, report orphans. |
| `core/src/appMap/redact.ts` | Single-point secret redaction + pre-write sweep. |
| `core/src/appMap/crawler.ts` | `Crawler` interface + input/result types. |
| `core/src/appMap/testUtils.ts` | `FakeCrawler` for tests of downstream code. |
| `core/src/appMap/realCrawler.ts` | Playwright implementation: capture, validate, disambiguate, walk, probe. |
| `core/src/appMap/__fixtures__/site/` | Static fixture site + local server helper for real-crawler tests. |
| `core/src/prompts/explorador.ts` | Prompt for candidate-scenario generation. |
| `core/src/agents/explorador/scenarioCandidates.ts` | LLM call + parse for candidate scenarios. |
| `core/src/agents/explorador/runExplorador.ts` | Orchestration, approval callbacks, event emission. |
| `cli/src/commands/map.ts` | `agente-qa map` + menu entry, real prompts, event rendering. |

---

### Task 1: Event channel types and CLI renderer

**Files:**
- Create: `core/src/events/agentEvent.ts`
- Create: `core/src/events/agentEvent.test.ts`
- Create: `cli/src/util/renderEvent.ts`
- Create: `cli/src/util/renderEvent.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentId`, `EventStatus`, `AgentEvent`, `EmitEvent`, `noopEmit` from `core`; `formatAgentEvent(event: AgentEvent): string` from the CLI.

- [ ] **Step 1: Write the failing tests**

`core/src/events/agentEvent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { noopEmit, type AgentEvent } from "./agentEvent.js";

describe("noopEmit", () => {
  it("accepts an event and returns undefined", () => {
    const event: AgentEvent = { agent: "explorador", status: "ok", depth: 0, message: "listo" };
    expect(noopEmit(event)).toBeUndefined();
  });
});
```

`cli/src/util/renderEvent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatAgentEvent } from "./renderEvent.js";

describe("formatAgentEvent", () => {
  it("marks a successful step with a check and no indentation at depth 0", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "ok", depth: 0, message: "Navegador abierto" }))
      .toBe("  ✓ Navegador abierto");
  });

  it("indents two extra spaces per depth level", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "ok", depth: 2, message: "6 textos anotados" }))
      .toBe("      ✓ 6 textos anotados");
  });

  it("uses a cross for failures and a warning sign for warnings", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "fail", depth: 0, message: "roto" })).toContain("✗ roto");
    expect(formatAgentEvent({ agent: "explorador", status: "warn", depth: 0, message: "ojo" })).toContain("⚠ ojo");
  });

  it("appends the duration in seconds when present", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "ok", depth: 0, message: "Ruta 1", durationMs: 900 }))
      .toBe("  ✓ Ruta 1 · 0.9s");
  });

  it("appends the detail after the message when present", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "warn", depth: 1, message: "Ambiguo", detail: "2 elementos" }))
      .toBe("    ⚠ Ambiguo — 2 elementos");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/events cli/src/util/renderEvent.test.ts`
Expected: FAIL — cannot resolve `./agentEvent.js` and `./renderEvent.js`.

- [ ] **Step 3: Write the implementation**

`core/src/events/agentEvent.ts`:

```ts
export type AgentId = "explorador" | "intake" | "generador" | "ejecutor" | "reportes";

/** `start` opens a step, `ok`/`fail` close one, `warn`/`info` stand alone. */
export type EventStatus = "start" | "ok" | "fail" | "warn" | "info";

export interface AgentEvent {
  agent: AgentId;
  status: EventStatus;
  /** Indentation level. 0 is a top-level step of the agent. */
  depth: number;
  message: string;
  detail?: string;
  durationMs?: number;
}

/**
 * The channel is one-way: it carries progress OUT of core and never asks
 * anything. Questions keep crossing each agent's own callbacks, which are
 * bidirectional by nature.
 */
export type EmitEvent = (event: AgentEvent) => void;

export const noopEmit: EmitEvent = () => {};
```

`cli/src/util/renderEvent.ts`:

```ts
import type { AgentEvent } from "@agente-qa/core";

const MARKS: Record<AgentEvent["status"], string> = {
  start: "·",
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  info: "·",
};

export function formatAgentEvent(event: AgentEvent): string {
  const indent = "  ".repeat(event.depth + 1);
  const detail = event.detail ? ` — ${event.detail}` : "";
  const duration = event.durationMs === undefined ? "" : ` · ${(event.durationMs / 1000).toFixed(1)}s`;
  return `${indent}${MARKS[event.status]} ${event.message}${detail}${duration}`;
}
```

Add to `core/src/index.ts`:

```ts
export type { AgentId, EventStatus, AgentEvent, EmitEvent } from "./events/agentEvent.js";
export { noopEmit } from "./events/agentEvent.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run core/src/events cli/src/util/renderEvent.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/events cli/src/util/renderEvent.ts cli/src/util/renderEvent.test.ts core/src/index.ts
git commit -m "feat(core): add one-way typed agent event channel"
```

---

### Task 2: Map schema

**Files:**
- Create: `core/src/appMap/schema.ts`
- Create: `core/src/appMap/schema.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppMapSchema`, `OverridesFileSchema` and the inferred types `AppMap`, `Screen`, `LocatorEntry`, `ScreenState`, `Transition`, `WriteAction`, `AmbiguousCandidate`, `ScenarioCandidate`, `OverridesFile`, `LocatorOverride`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AppMapSchema, OverridesFileSchema } from "./schema.js";

const minimalScreen = {
  id: "login",
  name: "Log in",
  className: "LoginPage",
  urlTemplate: "/",
  signature: "sha256:abc",
  requiresAuth: false,
  texts: ["Welcome back"],
  probeValues: [],
  locators: [],
  states: [],
  ambiguous: [],
  transitions: [],
  writeActions: [],
};

describe("AppMapSchema", () => {
  it("accepts a minimal complete map", () => {
    const parsed = AppMapSchema.parse({
      schemaVersion: 1,
      appUrl: "https://example.test/",
      createdAt: "2026-08-16T10:00:00.000Z",
      complete: true,
      authenticated: false,
      screens: [minimalScreen],
      scenarios: [],
      stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 10 },
    });
    expect(parsed.screens[0].id).toBe("login");
  });

  it("rejects a locator whose count is not exactly 1", () => {
    const result = AppMapSchema.safeParse({
      schemaVersion: 1,
      appUrl: "https://example.test/",
      createdAt: "2026-08-16T10:00:00.000Z",
      complete: true,
      authenticated: false,
      screens: [
        {
          ...minimalScreen,
          locators: [{ name: "x", kind: "button", python: "page.get_by_role(\"button\")", count: 2, verifiedAt: "2026-08-16T10:00:00.000Z" }],
        },
      ],
      scenarios: [],
      stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 10 },
    });
    expect(result.success).toBe(false);
  });
});

describe("OverridesFileSchema", () => {
  it("accepts a manual locator correction", () => {
    const parsed = OverridesFileSchema.parse({
      schemaVersion: 1,
      locators: [{ screenId: "login", name: "error_message", python: "page.get_by_text(\"Nope\")" }],
    });
    expect(parsed.locators).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/schema.test.ts`
Expected: FAIL — cannot resolve `./schema.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/schema.ts`:

```ts
import { z } from "zod";

/**
 * A locator only ever enters the map with count 1. Anything the crawler could
 * not pin down to a single element lives in `ambiguous` instead, so consumers
 * never have to reason about ambiguity.
 */
export const LocatorEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["input", "button", "link", "select", "text", "heading"]),
  accessibleName: z.string().optional(),
  python: z.string().min(1),
  count: z.literal(1),
  /** Set when the raw candidate matched more than one element and a region scoped it down. */
  disambiguatedBy: z.string().optional(),
  /** Set when the locator only exists in a non-default state of the screen. */
  stateId: z.string().optional(),
  verifiedAt: z.string(),
});

export const ScreenStateSchema = z.object({
  id: z.string().min(1),
  reachedBy: z.object({
    action: z.enum(["click", "submit"]),
    locator: z.string(),
    data: z.enum(["valid", "invalid", "none"]),
  }),
  addsTexts: z.array(z.string()),
});

export const TransitionSchema = z.object({
  locator: z.string(),
  action: z.enum(["click", "submit"]),
  toScreenId: z.string().nullable(),
  urlChanged: z.boolean(),
  /** Set for links that leave the app's host: recorded, never followed. */
  externalUrl: z.string().optional(),
});

export const WriteActionSchema = z.object({
  locator: z.string(),
  label: z.string(),
  kind: z.enum(["submit"]),
  formFields: z.array(z.string()),
});

export const AmbiguousCandidateSchema = z.object({
  candidate: z.string(),
  count: z.number().int().min(2),
  reason: z.string(),
});

export const ScreenSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  className: z.string().min(1),
  urlTemplate: z.string().min(1),
  signature: z.string().min(1),
  requiresAuth: z.boolean(),
  texts: z.array(z.string()),
  /** Values the crawler itself typed. Excluded from `texts`: they are our input, not app copy. */
  probeValues: z.array(z.string()),
  locators: z.array(LocatorEntrySchema),
  states: z.array(ScreenStateSchema),
  ambiguous: z.array(AmbiguousCandidateSchema),
  transitions: z.array(TransitionSchema),
  writeActions: z.array(WriteActionSchema),
});

export const ScenarioCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  screenId: z.string().min(1),
  involvedScreens: z.array(z.string()),
  rationale: z.string(),
});

export const AppMapSchema = z.object({
  schemaVersion: z.literal(1),
  appUrl: z.string().url(),
  createdAt: z.string(),
  /** false when the crawl was interrupted or hit a safety limit. */
  complete: z.boolean(),
  authenticated: z.boolean(),
  screens: z.array(ScreenSchema),
  scenarios: z.array(ScenarioCandidateSchema),
  stats: z.object({
    screens: z.number().int().min(0),
    locators: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    durationMs: z.number().int().min(0),
  }),
});

export const LocatorOverrideSchema = z.object({
  screenId: z.string().min(1),
  name: z.string().min(1),
  python: z.string().min(1),
  note: z.string().optional(),
});

export const OverridesFileSchema = z.object({
  schemaVersion: z.literal(1),
  locators: z.array(LocatorOverrideSchema),
});

export type LocatorEntry = z.infer<typeof LocatorEntrySchema>;
export type ScreenState = z.infer<typeof ScreenStateSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type WriteAction = z.infer<typeof WriteActionSchema>;
export type AmbiguousCandidate = z.infer<typeof AmbiguousCandidateSchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type ScenarioCandidate = z.infer<typeof ScenarioCandidateSchema>;
export type AppMap = z.infer<typeof AppMapSchema>;
export type LocatorOverride = z.infer<typeof LocatorOverrideSchema>;
export type OverridesFile = z.infer<typeof OverridesFileSchema>;
```

Add to `core/src/index.ts`:

```ts
export { AppMapSchema, OverridesFileSchema } from "./appMap/schema.js";
export type {
  AppMap, Screen, LocatorEntry, ScreenState, Transition, WriteAction,
  AmbiguousCandidate, ScenarioCandidate, OverridesFile, LocatorOverride,
} from "./appMap/schema.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/schema.ts core/src/appMap/schema.test.ts core/src/index.ts
git commit -m "feat(core): add app map and overrides schemas"
```

---

### Task 3: URL templating

**Files:**
- Create: `core/src/appMap/urlTemplate.ts`
- Create: `core/src/appMap/urlTemplate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toUrlTemplate(url: string, baseUrl: string): string`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/urlTemplate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toUrlTemplate } from "./urlTemplate.js";

const base = "https://example.test/";

describe("toUrlTemplate", () => {
  it("keeps a static path as-is", () => {
    expect(toUrlTemplate("https://example.test/settings/profile", base)).toBe("/settings/profile");
  });

  it("collapses a numeric segment", () => {
    expect(toUrlTemplate("https://example.test/user/123", base)).toBe("/user/:id");
  });

  it("collapses a uuid segment", () => {
    expect(toUrlTemplate("https://example.test/order/3f2504e0-4f89-11d3-9a0c-0305e82c3301", base))
      .toBe("/order/:id");
  });

  it("collapses every variable segment in the same path", () => {
    expect(toUrlTemplate("https://example.test/user/7/post/42", base)).toBe("/user/:id/post/:id");
  });

  it("normalises the root to a single slash", () => {
    expect(toUrlTemplate("https://example.test", base)).toBe("/");
    expect(toUrlTemplate("https://example.test/", base)).toBe("/");
  });

  it("drops the query string and hash: they are state, not route", () => {
    expect(toUrlTemplate("https://example.test/search?q=hola#top", base)).toBe("/search");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/urlTemplate.test.ts`
Expected: FAIL — cannot resolve `./urlTemplate.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/urlTemplate.ts`:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;

function isVariableSegment(segment: string): boolean {
  return NUMERIC.test(segment) || UUID.test(segment);
}

/**
 * Two URLs that differ only in a variable segment are the same screen with
 * different data (/user/123 and /user/456), so the crawler must visit one of
 * them and not both. Query string and hash are dropped: they carry state
 * within a screen, not identity of the screen.
 */
export function toUrlTemplate(url: string, baseUrl: string): string {
  const parsed = new URL(url, baseUrl);
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "/";
  return "/" + segments.map((s) => (isVariableSegment(s) ? ":id" : s)).join("/");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/urlTemplate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/urlTemplate.ts core/src/appMap/urlTemplate.test.ts
git commit -m "feat(core): collapse variable URL segments into route templates"
```

---

### Task 4: Screen signature and loop detection

**Files:**
- Create: `core/src/appMap/signature.ts`
- Create: `core/src/appMap/signature.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `screenSignature(ariaSnapshot: string): string`, `isSuspectedLoop(recentSignatures: string[], threshold: number): boolean`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/signature.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { screenSignature, isSuspectedLoop } from "./signature.js";

describe("screenSignature", () => {
  it("gives the same signature to two pages that differ only in data", () => {
    const page1 = `- heading "Orders" [level=1]\n- text: Total 1.234,50 €\n- text: 12/03/2026`;
    const page2 = `- heading "Orders" [level=1]\n- text: Total 9,99 €\n- text: 01/01/2025`;
    expect(screenSignature(page1)).toBe(screenSignature(page2));
  });

  it("gives different signatures when the structure differs", () => {
    const orders = `- heading "Orders" [level=1]\n- button "New"`;
    const settings = `- heading "Settings" [level=1]\n- button "New"`;
    expect(screenSignature(orders)).not.toBe(screenSignature(settings));
  });

  it("is insensitive to leading whitespace changes", () => {
    expect(screenSignature(`- button "Log in"`)).toBe(screenSignature(`    - button "Log in"`));
  });

  it("returns a sha256-prefixed value", () => {
    expect(screenSignature(`- button "Log in"`)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("isSuspectedLoop", () => {
  it("flags three consecutive identical signatures at threshold 3", () => {
    expect(isSuspectedLoop(["a", "a", "a"], 3)).toBe(true);
  });

  it("does not flag when the last signatures differ", () => {
    expect(isSuspectedLoop(["a", "a", "b"], 3)).toBe(false);
  });

  it("does not flag before reaching the threshold", () => {
    expect(isSuspectedLoop(["a", "a"], 3)).toBe(false);
  });

  it("only looks at the most recent window", () => {
    expect(isSuspectedLoop(["b", "a", "a", "a"], 3)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/signature.test.ts`
Expected: FAIL — cannot resolve `./signature.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/signature.ts`:

```ts
import { createHash } from "node:crypto";

const VOLATILE = [
  /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/g,          // dates
  /\d[\d.,]*\s?(?:€|\$|%)/g,                  // amounts
  /\b\d+\b/g,                                 // any bare number
];

/**
 * Fingerprint of the accessibility tree with the data stripped out: roles and
 * accessible names survive, numbers, dates and amounts do not. Two pages of a
 * paginated list share a signature, which is what turns "click Next forever"
 * into a detectable loop instead of an endless supply of new screens.
 */
export function screenSignature(ariaSnapshot: string): string {
  let normalized = ariaSnapshot;
  for (const pattern of VOLATILE) normalized = normalized.replace(pattern, "#");
  normalized = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return "sha256:" + createHash("sha256").update(normalized).digest("hex");
}

export function isSuspectedLoop(recentSignatures: string[], threshold: number): boolean {
  if (threshold < 1 || recentSignatures.length < threshold) return false;
  const window = recentSignatures.slice(-threshold);
  return window.every((signature) => signature === window[0]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/signature.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/signature.ts core/src/appMap/signature.test.ts
git commit -m "feat(core): add screen signature and loop detection"
```

---

### Task 5: Element identity and state merging

**Files:**
- Create: `core/src/appMap/elementIdentity.ts`
- Create: `core/src/appMap/elementIdentity.test.ts`

**Interfaces:**
- Consumes: `Screen`, `ScreenState` from Task 2.
- Produces: `elementKey(input: { screenId: string; role: string; accessibleName: string; index: number }): string`, `mergeScreenState(screen: Screen, state: { id: string; reachedBy: ScreenState["reachedBy"]; texts: string[]; locators: Screen["locators"] }): Screen`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/elementIdentity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { elementKey, mergeScreenState } from "./elementIdentity.js";
import type { Screen } from "./schema.js";

const screen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: ["Email", "Password"], probeValues: [], locators: [], states: [],
  ambiguous: [], transitions: [], writeActions: [],
};

describe("elementKey", () => {
  it("distinguishes two same-named buttons at different positions", () => {
    const a = elementKey({ screenId: "orders", role: "button", accessibleName: "Edit", index: 0 });
    const b = elementKey({ screenId: "orders", role: "button", accessibleName: "Edit", index: 1 });
    expect(a).not.toBe(b);
  });

  it("is stable for the same element", () => {
    const input = { screenId: "login", role: "button", accessibleName: "Log in", index: 0 };
    expect(elementKey(input)).toBe(elementKey({ ...input }));
  });

  it("distinguishes the same element on different screens", () => {
    expect(elementKey({ screenId: "a", role: "button", accessibleName: "Save", index: 0 }))
      .not.toBe(elementKey({ screenId: "b", role: "button", accessibleName: "Save", index: 0 }));
  });
});

describe("mergeScreenState", () => {
  it("adds the new texts to the same screen instead of creating another one", () => {
    const merged = mergeScreenState(screen, {
      id: "invalid-credentials",
      reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
      texts: ["Authentication failed. Please try again."],
      locators: [],
    });
    expect(merged.texts).toContain("Authentication failed. Please try again.");
    expect(merged.states).toHaveLength(1);
    expect(merged.states[0].addsTexts).toEqual(["Authentication failed. Please try again."]);
  });

  it("does not duplicate texts the screen already had", () => {
    const merged = mergeScreenState(screen, {
      id: "invalid-credentials",
      reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
      texts: ["Email", "Required"],
      locators: [],
    });
    expect(merged.texts.filter((t) => t === "Email")).toHaveLength(1);
    expect(merged.states[0].addsTexts).toEqual(["Required"]);
  });

  it("tags locators that only exist in that state", () => {
    const merged = mergeScreenState(screen, {
      id: "invalid-credentials",
      reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
      texts: [],
      locators: [{
        name: "text_auth_failed", kind: "text",
        python: 'page.get_by_text("Authentication failed. Please try again.")',
        count: 1, verifiedAt: "2026-08-16T10:00:00.000Z",
      }],
    });
    expect(merged.locators[0].stateId).toBe("invalid-credentials");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/elementIdentity.test.ts`
Expected: FAIL — cannot resolve `./elementIdentity.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/elementIdentity.ts`:

```ts
import type { LocatorEntry, Screen, ScreenState } from "./schema.js";

/**
 * The crawler never clicks the same element twice. Position is part of the
 * identity because two "Edit" buttons in different table rows are different
 * elements with the same accessible name.
 */
export function elementKey(input: {
  screenId: string;
  role: string;
  accessibleName: string;
  index: number;
}): string {
  return `${input.screenId}|${input.role}|${input.accessibleName}|${input.index}`;
}

/**
 * An error message under a form is not a new screen: it is a state of the same
 * one. Merging keeps "one Page Object per route" intact — without it the login
 * screen would get one map entry per possible combination of error messages,
 * and the loop detector would see new screens where there are only states.
 */
export function mergeScreenState(
  screen: Screen,
  state: { id: string; reachedBy: ScreenState["reachedBy"]; texts: string[]; locators: LocatorEntry[] }
): Screen {
  const newTexts = state.texts.filter((text) => !screen.texts.includes(text));
  const taggedLocators: LocatorEntry[] = state.locators.map((locator) => ({ ...locator, stateId: state.id }));
  return {
    ...screen,
    texts: [...screen.texts, ...newTexts],
    locators: [...screen.locators, ...taggedLocators],
    states: [...screen.states, { id: state.id, reachedBy: state.reachedBy, addsTexts: newTexts }],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/elementIdentity.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/elementIdentity.ts core/src/appMap/elementIdentity.test.ts
git commit -m "feat(core): add element identity and screen state merging"
```

---

### Task 6: Deterministic naming and Page Object emission

**Files:**
- Create: `core/src/appMap/naming.ts`
- Create: `core/src/appMap/naming.test.ts`
- Create: `core/src/appMap/pageObjectEmitter.ts`
- Create: `core/src/appMap/pageObjectEmitter.test.ts`

**Interfaces:**
- Consumes: `Screen`, `LocatorEntry` from Task 2.
- Produces: `pythonIdentifier(raw: string): string`, `uniqueName(candidate: string, taken: Set<string>): string`, `emitPageObject(screen: Screen): { path: string; content: string }`.

- [ ] **Step 1: Write the failing tests**

`core/src/appMap/naming.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pythonIdentifier, uniqueName } from "./naming.js";

describe("pythonIdentifier", () => {
  it("lowercases and joins words with underscores", () => {
    expect(pythonIdentifier("Log in")).toBe("log_in");
  });

  it("strips accents so Spanish UI copy yields plain identifiers", () => {
    expect(pythonIdentifier("Contraseña olvidada")).toBe("contrasena_olvidada");
  });

  it("drops punctuation", () => {
    expect(pythonIdentifier("Forgot password?")).toBe("forgot_password");
  });

  it("prefixes a leading digit so the result is a valid identifier", () => {
    expect(pythonIdentifier("2 factor")).toBe("_2_factor");
  });

  it("falls back to a placeholder when nothing usable remains", () => {
    expect(pythonIdentifier("···")).toBe("unnamed");
  });
});

describe("uniqueName", () => {
  it("returns the candidate when it is free", () => {
    expect(uniqueName("log_in", new Set())).toBe("log_in");
  });

  it("suffixes with a counter on collision", () => {
    expect(uniqueName("log_in", new Set(["log_in"]))).toBe("log_in_2");
    expect(uniqueName("log_in", new Set(["log_in", "log_in_2"]))).toBe("log_in_3");
  });
});
```

`core/src/appMap/pageObjectEmitter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emitPageObject } from "./pageObjectEmitter.js";
import type { Screen } from "./schema.js";

const screen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
  locators: [
    { name: "email_input", kind: "input", accessibleName: "Email",
      python: 'page.get_by_role("textbox", name="Email")', count: 1, verifiedAt: "t" },
    { name: "log_in_button", kind: "button", accessibleName: "Log in",
      python: 'page.get_by_role("main").get_by_role("button", name="Log in")',
      count: 1, disambiguatedBy: "region:main", verifiedAt: "t" },
    { name: "text_auth_failed", kind: "text",
      python: 'page.get_by_text("Authentication failed. Please try again.")',
      count: 1, stateId: "invalid-credentials", verifiedAt: "t" },
  ],
};

describe("emitPageObject", () => {
  it("writes to pages/<id>_page.py", () => {
    expect(emitPageObject(screen).path).toBe("pages/login_page.py");
  });

  it("carries a do-not-edit banner", () => {
    expect(emitPageObject(screen).content).toContain("NO EDITAR A MANO");
  });

  it("emits a get_* method per locator", () => {
    const { content } = emitPageObject(screen);
    expect(content).toContain("def get_email_input(self) -> Locator:");
    expect(content).toContain("def get_log_in_button(self) -> Locator:");
    expect(content).toContain("def get_text_auth_failed(self) -> Locator:");
  });

  it("emits fill_* only for inputs and click_* only for buttons and links", () => {
    const { content } = emitPageObject(screen);
    expect(content).toContain("def fill_email_input(self, value: str) -> None:");
    expect(content).toContain("def click_log_in_button(self) -> None:");
    expect(content).not.toContain("def click_email_input");
    expect(content).not.toContain("def fill_text_auth_failed");
  });

  it("keeps the locator expression verbatim from the map", () => {
    expect(emitPageObject(screen).content)
      .toContain('return self.page.get_by_role("main").get_by_role("button", name="Log in")');
  });

  it("notes in a comment which state a state-only locator belongs to", () => {
    expect(emitPageObject(screen).content).toContain("# solo visible en el estado: invalid-credentials");
  });

  it("emits goto() from the route template", () => {
    expect(emitPageObject(screen).content).toContain('URL_TEMPLATE = "/"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/appMap/naming.test.ts core/src/appMap/pageObjectEmitter.test.ts`
Expected: FAIL — cannot resolve `./naming.js` and `./pageObjectEmitter.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/naming.ts`:

```ts
export function pythonIdentifier(raw: string): string {
  const ascii = raw.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const cleaned = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) return "unnamed";
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function uniqueName(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  let counter = 2;
  while (taken.has(`${candidate}_${counter}`)) counter += 1;
  return `${candidate}_${counter}`;
}
```

`core/src/appMap/pageObjectEmitter.ts`:

```ts
import type { LocatorEntry, Screen } from "./schema.js";

const FILLABLE: LocatorEntry["kind"][] = ["input"];
const CLICKABLE: LocatorEntry["kind"][] = ["button", "link"];

function locatorMethods(locator: LocatorEntry): string {
  const stateNote = locator.stateId ? `        # solo visible en el estado: ${locator.stateId}\n` : "";
  const lines = [
    `    def get_${locator.name}(self) -> Locator:`,
    stateNote.trimEnd(),
    `        return self.${locator.python}`,
  ].filter((line) => line.length > 0);

  if (FILLABLE.includes(locator.kind)) {
    lines.push(
      "",
      `    def fill_${locator.name}(self, value: str) -> None:`,
      `        self.get_${locator.name}().fill(value)`
    );
  }
  if (CLICKABLE.includes(locator.kind)) {
    lines.push(
      "",
      `    def click_${locator.name}(self) -> None:`,
      `        self.get_${locator.name}().click()`
    );
  }
  if (locator.kind === "select") {
    lines.push(
      "",
      `    def select_${locator.name}(self, value: str) -> None:`,
      `        self.get_${locator.name}().select_option(value)`
    );
  }
  return lines.join("\n");
}

/**
 * Mechanical template, no LLM: every locator expression is copied verbatim
 * from the map, where it was validated against a real browser. That is what
 * makes an invented locator structurally impossible.
 */
export function emitPageObject(screen: Screen): { path: string; content: string } {
  const body = screen.locators.map(locatorMethods).join("\n\n");
  const content = `# GENERADO por agente-qa desde .agente-qa/map/map.json — NO EDITAR A MANO
# Las correcciones manuales van en .agente-qa/map/overrides.json
# Pantalla: ${screen.id}  ·  ruta: ${screen.urlTemplate}
import os

from playwright.sync_api import Locator, Page


class ${screen.className}:
    URL_TEMPLATE = "${screen.urlTemplate}"

    def __init__(self, page: Page):
        self.page = page

    def goto(self) -> None:
        base = os.environ["AGENTE_QA_APP_URL"].rstrip("/")
        self.page.goto(base + self.URL_TEMPLATE)

${body}
`;
  return { path: `pages/${screen.id.replace(/-/g, "_")}_page.py`, content };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run core/src/appMap/naming.test.ts core/src/appMap/pageObjectEmitter.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/naming.ts core/src/appMap/naming.test.ts core/src/appMap/pageObjectEmitter.ts core/src/appMap/pageObjectEmitter.test.ts
git commit -m "feat(core): emit Page Objects from the map with a deterministic template"
```

---

### Task 7: Map store on disk

**Files:**
- Create: `core/src/appMap/mapStore.ts`
- Create: `core/src/appMap/mapStore.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `AppMap`, `AppMapSchema` from Task 2.
- Produces: `appMapDir(projectRoot: string): string`, `appMapPath(projectRoot: string): string`, `saveAppMap(projectRoot: string, map: AppMap): Promise<string>`, `loadAppMap(projectRoot: string): Promise<AppMap | null>`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/mapStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appMapPath, saveAppMap, loadAppMap } from "./mapStore.js";
import type { AppMap } from "./schema.js";

const map: AppMap = {
  schemaVersion: 1,
  appUrl: "https://example.test/",
  createdAt: "2026-08-16T10:00:00.000Z",
  complete: true,
  authenticated: false,
  screens: [],
  scenarios: [],
  stats: { screens: 0, locators: 0, ambiguous: 0, durationMs: 0 },
};

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-map-"));
});
afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe("saveAppMap / loadAppMap", () => {
  it("writes to .agente-qa/map/map.json and reads it back", async () => {
    const written = await saveAppMap(projectRoot, map);
    expect(written).toBe(appMapPath(projectRoot));
    await expect(loadAppMap(projectRoot)).resolves.toEqual(map);
  });

  it("returns null when there is no map yet", async () => {
    await expect(loadAppMap(projectRoot)).resolves.toBeNull();
  });

  it("rejects a corrupt map instead of returning half a map", async () => {
    await fs.mkdir(path.dirname(appMapPath(projectRoot)), { recursive: true });
    await fs.writeFile(appMapPath(projectRoot), '{"schemaVersion": 99}', "utf-8");
    await expect(loadAppMap(projectRoot)).rejects.toThrow(/map\.json/);
  });

  it("overwrites a previous map", async () => {
    await saveAppMap(projectRoot, map);
    await saveAppMap(projectRoot, { ...map, authenticated: true });
    const loaded = await loadAppMap(projectRoot);
    expect(loaded?.authenticated).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/mapStore.test.ts`
Expected: FAIL — cannot resolve `./mapStore.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/mapStore.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { AppMapSchema, type AppMap } from "./schema.js";

export function appMapDir(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "map");
}

export function appMapPath(projectRoot: string): string {
  return path.join(appMapDir(projectRoot), "map.json");
}

export async function saveAppMap(projectRoot: string, map: AppMap): Promise<string> {
  const dir = appMapDir(projectRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const target = appMapPath(projectRoot);
  await fs.writeFile(target, JSON.stringify(map, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(target, 0o600);
  return target;
}

export async function loadAppMap(projectRoot: string): Promise<AppMap | null> {
  const target = appMapPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf-8");
  } catch {
    return null;
  }
  const parsed = AppMapSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `El fichero map.json de ${target} no tiene el formato esperado. Vuelve a mapear la aplicación con "agente-qa map".`
    );
  }
  return parsed.data;
}
```

Add to `core/src/index.ts`:

```ts
export { appMapDir, appMapPath, saveAppMap, loadAppMap } from "./appMap/mapStore.js";
```

Note on `mode` + `chmod`: both are applied on purpose. `mode` covers a fresh
creation; `chmod` covers a file that already existed from an earlier run. They
serve different cases and neither makes the other redundant.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/mapStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/mapStore.ts core/src/appMap/mapStore.test.ts core/src/index.ts
git commit -m "feat(core): persist the app map under .agente-qa/map"
```

---

### Task 8: Overrides and reapplication

**Files:**
- Create: `core/src/appMap/overrides.ts`
- Create: `core/src/appMap/overrides.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `AppMap`, `OverridesFile`, `LocatorOverride` from Task 2; `appMapDir` from Task 7.
- Produces: `overridesPath(projectRoot: string): string`, `loadOverrides(projectRoot: string): Promise<OverridesFile>`, `saveOverride(projectRoot: string, override: LocatorOverride): Promise<void>`, `applyOverrides(map: AppMap, overrides: OverridesFile): { map: AppMap; orphans: LocatorOverride[] }`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/overrides.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOverrides, saveOverride, applyOverrides } from "./overrides.js";
import type { AppMap } from "./schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false, texts: [], probeValues: [],
    states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "error_message", kind: "text", python: 'page.get_by_role("alert")', count: 1, verifiedAt: "t" }],
  }],
};

let projectRoot: string;
beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-ovr-"));
});
afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe("loadOverrides / saveOverride", () => {
  it("returns an empty file when none exists", async () => {
    await expect(loadOverrides(projectRoot)).resolves.toEqual({ schemaVersion: 1, locators: [] });
  });

  it("round-trips a saved override", async () => {
    await saveOverride(projectRoot, { screenId: "login", name: "error_message", python: 'page.get_by_text("Nope")' });
    const loaded = await loadOverrides(projectRoot);
    expect(loaded.locators).toHaveLength(1);
  });

  it("replaces an override for the same screen and name instead of appending", async () => {
    await saveOverride(projectRoot, { screenId: "login", name: "error_message", python: "first" });
    await saveOverride(projectRoot, { screenId: "login", name: "error_message", python: "second" });
    const loaded = await loadOverrides(projectRoot);
    expect(loaded.locators).toHaveLength(1);
    expect(loaded.locators[0].python).toBe("second");
  });
});

describe("applyOverrides", () => {
  it("replaces the locator expression in the map", () => {
    const { map: patched } = applyOverrides(map, {
      schemaVersion: 1,
      locators: [{ screenId: "login", name: "error_message", python: 'page.get_by_text("Nope")' }],
    });
    expect(patched.screens[0].locators[0].python).toBe('page.get_by_text("Nope")');
  });

  it("leaves the original map untouched", () => {
    applyOverrides(map, {
      schemaVersion: 1,
      locators: [{ screenId: "login", name: "error_message", python: "changed" }],
    });
    expect(map.screens[0].locators[0].python).toBe('page.get_by_role("alert")');
  });

  it("reports an override whose screen no longer exists as an orphan", () => {
    const { orphans } = applyOverrides(map, {
      schemaVersion: 1,
      locators: [{ screenId: "gone", name: "x", python: "y" }],
    });
    expect(orphans).toHaveLength(1);
    expect(orphans[0].screenId).toBe("gone");
  });

  it("reports an override whose locator name no longer exists as an orphan", () => {
    const { orphans } = applyOverrides(map, {
      schemaVersion: 1,
      locators: [{ screenId: "login", name: "vanished", python: "y" }],
    });
    expect(orphans).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/overrides.test.ts`
Expected: FAIL — cannot resolve `./overrides.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/overrides.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { appMapDir } from "./mapStore.js";
import { OverridesFileSchema, type AppMap, type LocatorOverride, type OverridesFile } from "./schema.js";

const EMPTY: OverridesFile = { schemaVersion: 1, locators: [] };

export function overridesPath(projectRoot: string): string {
  return path.join(appMapDir(projectRoot), "overrides.json");
}

export async function loadOverrides(projectRoot: string): Promise<OverridesFile> {
  let raw: string;
  try {
    raw = await fs.readFile(overridesPath(projectRoot), "utf-8");
  } catch {
    return EMPTY;
  }
  const parsed = OverridesFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `El fichero overrides.json de ${overridesPath(projectRoot)} no tiene el formato esperado. Corrígelo o bórralo.`
    );
  }
  return parsed.data;
}

export async function saveOverride(projectRoot: string, override: LocatorOverride): Promise<void> {
  const current = await loadOverrides(projectRoot);
  const rest = current.locators.filter(
    (existing) => !(existing.screenId === override.screenId && existing.name === override.name)
  );
  const next: OverridesFile = { schemaVersion: 1, locators: [...rest, override] };
  const dir = appMapDir(projectRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const target = overridesPath(projectRoot);
  await fs.writeFile(target, JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(target, 0o600);
}

/**
 * A remap regenerates map.json from scratch, so manual corrections live in a
 * separate file and are reapplied on top. Without that separation every crawl
 * would silently delete the user's work.
 */
export function applyOverrides(
  map: AppMap,
  overrides: OverridesFile
): { map: AppMap; orphans: LocatorOverride[] } {
  const orphans: LocatorOverride[] = [];
  const screens = map.screens.map((screen) => ({ ...screen, locators: screen.locators.map((l) => ({ ...l })) }));

  for (const override of overrides.locators) {
    const screen = screens.find((s) => s.id === override.screenId);
    const locator = screen?.locators.find((l) => l.name === override.name);
    if (!locator) {
      orphans.push(override);
      continue;
    }
    locator.python = override.python;
  }

  return { map: { ...map, screens }, orphans };
}
```

Add to `core/src/index.ts`:

```ts
export { overridesPath, loadOverrides, saveOverride, applyOverrides } from "./appMap/overrides.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/overrides.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/overrides.ts core/src/appMap/overrides.test.ts core/src/index.ts
git commit -m "feat(core): reapply manual locator overrides after a remap"
```

---

### Task 9: Secret redaction

**Files:**
- Create: `core/src/appMap/redact.ts`
- Create: `core/src/appMap/redact.test.ts`

**Interfaces:**
- Consumes: `AppMap`, `Screen` from Task 2.
- Produces: `REDACTED` constant, `redactText(text: string, secrets: string[]): string`, `redactMap(map: AppMap, secrets: string[]): AppMap`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/redact.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { redactText, redactMap, REDACTED } from "./redact.js";
import type { AppMap } from "./schema.js";

const secrets = ["s3cr3t-pass", "user@example.test"];

const mapWithSecret: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: true, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Email", "s3cr3t-pass"], probeValues: [],
    states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "pwd", kind: "input", python: 'page.get_by_text("s3cr3t-pass")', count: 1, verifiedAt: "t" }],
  }],
};

describe("redactText", () => {
  it("replaces a secret occurrence", () => {
    expect(redactText("typed s3cr3t-pass here", secrets)).toBe(`typed ${REDACTED} here`);
  });

  it("ignores empty secrets so an unset env var does not redact everything", () => {
    expect(redactText("anything", ["", "   "])).toBe("anything");
  });

  it("leaves unrelated text alone", () => {
    expect(redactText("Welcome back", secrets)).toBe("Welcome back");
  });
});

describe("redactMap", () => {
  it("removes the secret from screen texts", () => {
    const clean = redactMap(mapWithSecret, secrets);
    expect(clean.screens[0].texts).not.toContain("s3cr3t-pass");
    expect(clean.screens[0].texts).toContain(REDACTED);
  });

  it("removes the secret from locator expressions", () => {
    const clean = redactMap(mapWithSecret, secrets);
    expect(clean.screens[0].locators[0].python).not.toContain("s3cr3t-pass");
  });

  it("leaves no trace of any secret anywhere in the serialised map", () => {
    const serialised = JSON.stringify(redactMap(mapWithSecret, secrets));
    for (const secret of secrets) expect(serialised).not.toContain(secret);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/redact.test.ts`
Expected: FAIL — cannot resolve `./redact.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/redact.ts`:

```ts
import { AppMapSchema, type AppMap } from "./schema.js";

export const REDACTED = "[REDACTED]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.trim().length === 0) continue;
    result = result.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return result;
}

/**
 * Second net, applied right before the map is written. The first net is
 * redaction at the single point where a screen is captured (realCrawler). Both
 * exist because the map is versioned in the user's git: a secret that gets in
 * ends up in their repository.
 *
 * Serialise-redact-reparse is deliberate: it guarantees no field is missed as
 * the schema grows, which a hand-written per-field walk cannot promise.
 */
export function redactMap(map: AppMap, secrets: string[]): AppMap {
  const redacted = redactText(JSON.stringify(map), secrets);
  return AppMapSchema.parse(JSON.parse(redacted));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/redact.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Mutation-verify the redaction, then commit**

Temporarily change `redactText` to `return text;`, run
`npx vitest run core/src/appMap/redact.test.ts` and confirm the "leaves no
trace" test fails with the real secret visible in the diff. Restore the
implementation and confirm the suite is green again. Evidence of both runs goes
in the task report.

```bash
git add core/src/appMap/redact.ts core/src/appMap/redact.test.ts
git commit -m "feat(core): redact test credentials before the map is written"
```

---

### Task 10: Fixture site and local server

**Files:**
- Create: `core/src/appMap/__fixtures__/site/index.html`
- Create: `core/src/appMap/__fixtures__/site/reset.html`
- Create: `core/src/appMap/__fixtures__/site/dashboard.html`
- Create: `core/src/appMap/__fixtures__/site/list.html`
- Create: `core/src/appMap/__fixtures__/server.ts`
- Create: `core/src/appMap/__fixtures__/server.test.ts`
- Modify: `core/tsconfig.build.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `startFixtureSite(): Promise<{ url: string; close: () => Promise<void> }>`.

The fixture covers one mechanism per page: `index.html` a login form whose
submit shows an error for wrong credentials and redirects to the dashboard for
the right ones, plus a "Log in" button duplicated in the header (region
disambiguation) and an "Email" text that appears twice with no distinguishing
region (irreducible ambiguity); `reset.html` a second route reached by clicking;
`dashboard.html` the authenticated screen; `list.html` a paginated list whose
"Next" always renders the same structure (loop detection) and rows linking to
`/item/1`, `/item/2` (URL templating).

- [ ] **Step 1: Write the failing test**

`core/src/appMap/__fixtures__/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { startFixtureSite } from "./server.js";

describe("startFixtureSite", () => {
  it("serves the login page on the root", async () => {
    const site = await startFixtureSite();
    try {
      const response = await fetch(site.url);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('name="email"');
    } finally {
      await site.close();
    }
  });

  it("serves each fixture route", async () => {
    const site = await startFixtureSite();
    try {
      for (const route of ["/reset.html", "/dashboard.html", "/list.html"]) {
        expect((await fetch(site.url.replace(/\/$/, "") + route)).status).toBe(200);
      }
    } finally {
      await site.close();
    }
  });

  it("answers 404 for an unknown route", async () => {
    const site = await startFixtureSite();
    try {
      expect((await fetch(site.url.replace(/\/$/, "") + "/nope.html")).status).toBe(404);
    } finally {
      await site.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/__fixtures__/server.test.ts`
Expected: FAIL — cannot resolve `./server.js`.

- [ ] **Step 3: Write the fixture pages and the server**

`core/src/appMap/__fixtures__/site/index.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fixture · Log in</title></head>
  <body>
    <header><button type="button">Log in</button></header>
    <main>
      <h1>Welcome back</h1>
      <form id="login">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" />
        <button type="submit">Log in</button>
      </form>
      <a href="/reset.html">Forgot password?</a>
      <p id="error" hidden>Authentication failed. Please try again.</p>
      <aside><span>Email</span></aside>
    </main>
    <script>
      document.getElementById("login").addEventListener("submit", (event) => {
        event.preventDefault();
        const ok = document.getElementById("email").value === "user@example.test"
          && document.getElementById("password").value === "s3cr3t-pass";
        if (ok) { window.location.href = "/dashboard.html"; return; }
        document.getElementById("error").hidden = false;
      });
    </script>
  </body>
</html>
```

`core/src/appMap/__fixtures__/site/reset.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fixture · Reset</title></head>
  <body><main><h1>Reset password</h1><button type="button">Send reset link</button>
  <a href="/">Back to log in</a></main></body>
</html>
```

`core/src/appMap/__fixtures__/site/dashboard.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fixture · Dashboard</title></head>
  <body><main><h1>Your studio</h1><a href="/list.html">Orders</a>
  <button type="button">Log out</button></main></body>
</html>
```

`core/src/appMap/__fixtures__/site/list.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fixture · Orders</title></head>
  <body><main><h1>Orders</h1>
  <ul><li><a href="/item/1">Order 1</a></li><li><a href="/item/2">Order 2</a></li></ul>
  <a href="/list.html?page=2">Next</a></main></body>
</html>
```

`core/src/appMap/__fixtures__/server.ts`:

```ts
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");

/**
 * Test-only. Serving the fixture from disk keeps crawler tests independent of
 * any external site: a public app can change any day and break the suite for
 * reasons that have nothing to do with this project.
 */
export async function startFixtureSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const requested = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = requested === "/" ? "index.html" : requested.replace(/^\//, "");
    // /item/1 and /item/2 are route templates, not files: they share one page.
    const file = relative.startsWith("item/") ? "item.html" : relative;
    try {
      const body = await fs.readFile(path.join(SITE_DIR, file), "utf-8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("El servidor de fixtures no obtuvo un puerto.");

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
```

Create `core/src/appMap/__fixtures__/site/item.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fixture · Order</title></head>
  <body><main><h1>Order detail</h1><a href="/list.html">Back to orders</a></main></body>
</html>
```

In `core/tsconfig.build.json`, add `"src/appMap/__fixtures__/**"` to `exclude`
so the fixture never ships in `dist/` — it is test scaffolding, not product.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/__fixtures__/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/__fixtures__ core/tsconfig.build.json
git commit -m "test(core): add a local fixture site for crawler tests"
```

---

### Task 11: Crawler interface and fake

**Files:**
- Create: `core/src/appMap/crawler.ts`
- Create: `core/src/appMap/testUtils.ts`
- Create: `core/src/appMap/testUtils.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `AppMap`, `WriteAction` from Task 2; `EmitEvent` from Task 1.
- Produces: `CrawlCredentials`, `CrawlLimits`, `CrawlInput`, `CrawlResult`, `Crawler`, `CrawlCallbacks`, `FakeCrawler`, `MissingCrawlerToolError`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/testUtils.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeCrawler } from "./testUtils.js";
import type { AppMap } from "./schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, screens: [], scenarios: [],
  stats: { screens: 0, locators: 0, ambiguous: 0, durationMs: 0 },
};

describe("FakeCrawler", () => {
  it("returns the map it was seeded with", async () => {
    const crawler = new FakeCrawler({ ok: true, map });
    const result = await crawler.crawl({
      baseUrl: "https://example.test/",
      limits: { maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [] },
      callbacks: { confirmContinueOnLoop: async () => true, approveWriteActions: async () => [] },
      emit: () => {},
    });
    expect(result).toEqual({ ok: true, map });
  });

  it("records the input it was called with", async () => {
    const crawler = new FakeCrawler({ ok: true, map });
    await crawler.crawl({
      baseUrl: "https://example.test/",
      limits: { maxScreens: 1, maxDepth: 1, maxDurationMinutes: 1, loopSuspicionThreshold: 3, excludeRoutes: ["/admin"] },
      callbacks: { confirmContinueOnLoop: async () => true, approveWriteActions: async () => [] },
      emit: () => {},
    });
    expect(crawler.calls).toHaveLength(1);
    expect(crawler.calls[0].limits.excludeRoutes).toEqual(["/admin"]);
  });

  it("can be seeded with a failure", async () => {
    const crawler = new FakeCrawler({ ok: false, error: "sin navegador" });
    const result = await crawler.crawl({
      baseUrl: "https://example.test/",
      limits: { maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [] },
      callbacks: { confirmContinueOnLoop: async () => true, approveWriteActions: async () => [] },
      emit: () => {},
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/testUtils.test.ts`
Expected: FAIL — cannot resolve `./testUtils.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/crawler.ts`:

```ts
import type { EmitEvent } from "../events/agentEvent.js";
import type { AppMap, WriteAction } from "./schema.js";

export interface CrawlCredentials {
  username: string;
  password: string;
}

export interface CrawlLimits {
  maxScreens: number;
  maxDepth: number;
  maxDurationMinutes: number;
  loopSuspicionThreshold: number;
  excludeRoutes: string[];
}

export interface CrawlCallbacks {
  /**
   * Called when N consecutive screens share a signature. Answering false prunes
   * that branch only; the crawl continues elsewhere.
   */
  confirmContinueOnLoop(context: { urlTemplate: string; repeats: number }): Promise<boolean>;
  /** The user picks which write actions the second pass may execute. Never bypassable. */
  approveWriteActions(actions: { screenId: string; action: WriteAction }[]): Promise<{ screenId: string; locator: string }[]>;
}

export interface CrawlInput {
  baseUrl: string;
  credentials?: CrawlCredentials;
  limits: CrawlLimits;
  headed?: boolean;
  callbacks: CrawlCallbacks;
  emit: EmitEvent;
}

export type CrawlResult = { ok: true; map: AppMap } | { ok: false; error: string };

export interface Crawler {
  crawl(input: CrawlInput): Promise<CrawlResult>;
}

export class MissingCrawlerToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCrawlerToolError";
  }
}
```

`core/src/appMap/testUtils.ts`:

```ts
import type { CrawlInput, CrawlResult, Crawler } from "./crawler.js";

export class FakeCrawler implements Crawler {
  readonly calls: CrawlInput[] = [];

  constructor(private readonly result: CrawlResult) {}

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    this.calls.push(input);
    return this.result;
  }
}
```

Add to `core/src/index.ts`:

```ts
export type {
  CrawlCredentials, CrawlLimits, CrawlCallbacks, CrawlInput, CrawlResult, Crawler,
} from "./appMap/crawler.js";
export { MissingCrawlerToolError } from "./appMap/crawler.js";
export { FakeCrawler } from "./appMap/testUtils.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/testUtils.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/crawler.ts core/src/appMap/testUtils.ts core/src/appMap/testUtils.test.ts core/src/index.ts
git commit -m "feat(core): add crawler seam with a fake implementation"
```

---

### Task 12: Real crawler — capture one screen with validated locators

**Files:**
- Create: `core/src/appMap/realCrawler.ts`
- Create: `core/src/appMap/realCrawler.capture.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-11.
- Produces: `captureScreen(page, context): Promise<Screen>` (exported for tests), `createRealCrawler(): Crawler`.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/realCrawler.capture.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { captureScreen } from "./realCrawler.js";

let browser: Browser | null = null;
let site: Awaited<ReturnType<typeof startFixtureSite>>;

beforeAll(async () => {
  site = await startFixtureSite();
  try {
    browser = await chromium.launch();
  } catch {
    browser = null; // sin navegadores instalados: los tests se saltan
  }
});
afterAll(async () => {
  await browser?.close();
  await site.close();
});

describe.skipIf(!process.env.CI && !chromium.executablePath())("captureScreen", () => {
  it("records every visible text of the screen", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    expect(screen.texts).toContain("Welcome back");
    expect(screen.texts).toContain("Forgot password?");
    await page.close();
  });

  it("only keeps locators that resolve to exactly one element", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    for (const locator of screen.locators) expect(locator.count).toBe(1);
    await page.close();
  });

  it("disambiguates a duplicated button by scoping it to a region", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    const logIn = screen.locators.find((l) => l.accessibleName === "Log in" && l.kind === "button");
    expect(logIn).toBeDefined();
    expect(logIn!.disambiguatedBy).toBe("region:main");
    expect(logIn!.python).toContain('get_by_role("main")');
    await page.close();
  });

  it("never disambiguates by position", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    for (const locator of screen.locators) {
      expect(locator.python).not.toMatch(/\.(first|last|nth\()/);
    }
    await page.close();
  });

  it("records an irreducibly duplicated text as ambiguous instead of guessing", async () => {
    const page = await (await browser!.newContext()).newPage();
    await page.goto(site.url);
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: [] });
    expect(screen.ambiguous.some((candidate) => candidate.candidate.includes("Email"))).toBe(true);
    await page.close();
  });

  it("redacts a secret typed into the page", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await page.goto(site.url);
    await page.getByRole("textbox", { name: "Password" }).fill("s3cr3t-pass");
    const screen = await captureScreen(page, { screenId: "login", baseUrl: site.url, secrets: ["s3cr3t-pass"] });
    expect(JSON.stringify(screen)).not.toContain("s3cr3t-pass");
    await page.close();
  });
});
```

Note on casing: the Playwright **Node** API is camelCase (`page.getByRole`),
while the Python source the emitter writes is snake_case (`page.get_by_role`).
Both appear in this task — the first in the crawler's own code, the second only
inside the strings it produces. Do not unify them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: FAIL — cannot resolve `./realCrawler.js`.

- [ ] **Step 3: Write the implementation**

`core/src/appMap/realCrawler.ts` (capture half; the walk arrives in Task 13):

```ts
import type { Locator, Page } from "playwright";
import type { AmbiguousCandidate, LocatorEntry, Screen } from "./schema.js";
import { screenSignature } from "./signature.js";
import { toUrlTemplate } from "./urlTemplate.js";
import { pythonIdentifier, uniqueName } from "./naming.js";
import { redactText } from "./redact.js";

const REGIONS = ["main", "form", "navigation", "banner", "contentinfo", "dialog"] as const;

interface CaptureContext {
  screenId: string;
  baseUrl: string;
  secrets: string[];
}

interface Candidate {
  kind: LocatorEntry["kind"];
  role: string | null;
  accessibleName: string;
  build: (scope: Locator | Page) => Locator;
  python: (scopePrefix: string) => string;
}

function pythonLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function collectCandidates(page: Page): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const roleKinds: { role: string; kind: LocatorEntry["kind"] }[] = [
    { role: "textbox", kind: "input" },
    { role: "button", kind: "button" },
    { role: "link", kind: "link" },
    { role: "combobox", kind: "select" },
    { role: "heading", kind: "heading" },
  ];

  for (const { role, kind } of roleKinds) {
    const names = new Set<string>();
    for (const handle of await page.getByRole(role as never).all()) {
      const name = (await handle.getAttribute("aria-label")) ?? (await handle.innerText().catch(() => "")) ?? "";
      const trimmed = name.trim();
      if (trimmed.length === 0 || names.has(trimmed)) continue;
      names.add(trimmed);
      candidates.push({
        kind,
        role,
        accessibleName: trimmed,
        build: (scope) => scope.getByRole(role as never, { name: trimmed, exact: true }),
        python: (prefix) => `${prefix}get_by_role(${pythonLiteral(role)}, name=${pythonLiteral(trimmed)})`,
      });
    }
  }

  for (const text of await page.getByRole("paragraph").allInnerTexts()) {
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    candidates.push({
      kind: "text",
      role: null,
      accessibleName: trimmed,
      build: (scope) => scope.getByText(trimmed, { exact: true }),
      python: (prefix) => `${prefix}get_by_text(${pythonLiteral(trimmed)})`,
    });
  }

  return candidates;
}

/**
 * A candidate that matches more than one element is NOT discarded on the spot:
 * it is first scoped to the nearest meaningful region. The reference app has
 * "Log in" twice (header and form), so a rule that dropped every duplicate
 * would leave the screen's main element out of the map. Position (.first,
 * .nth()) is never used to disambiguate: it survives any reordering of the
 * interface without failing, which is the worst way to fail.
 */
async function resolveCandidate(
  page: Page,
  candidate: Candidate
): Promise<{ python: string; disambiguatedBy?: string } | { ambiguous: AmbiguousCandidate }> {
  const plainPython = candidate.python("page.");
  const plainCount = await candidate.build(page).count();
  if (plainCount === 1) return { python: plainPython };
  if (plainCount === 0) return { ambiguous: { candidate: plainPython, count: 2, reason: "no encontrado al validar" } };

  for (const region of REGIONS) {
    const scope = page.getByRole(region as never);
    if ((await scope.count()) !== 1) continue;
    if ((await candidate.build(scope).count()) !== 1) continue;
    return {
      python: `page.get_by_role(${pythonLiteral(region)}).${candidate.python("")}`,
      disambiguatedBy: `region:${region}`,
    };
  }

  return {
    ambiguous: {
      candidate: plainPython,
      count: plainCount,
      reason: "aparece varias veces y ninguna región lo deja en 1",
    },
  };
}

export async function captureScreen(page: Page, context: CaptureContext): Promise<Screen> {
  const ariaSnapshot = redactText(await page.locator("body").ariaSnapshot(), context.secrets);
  const verifiedAt = new Date().toISOString();
  const locators: LocatorEntry[] = [];
  const ambiguous: AmbiguousCandidate[] = [];
  const taken = new Set<string>();
  const texts: string[] = [];

  for (const candidate of await collectCandidates(page)) {
    const cleanName = redactText(candidate.accessibleName, context.secrets);
    if (!texts.includes(cleanName)) texts.push(cleanName);

    const resolved = await resolveCandidate(page, candidate);
    if ("ambiguous" in resolved) {
      ambiguous.push({ ...resolved.ambiguous, candidate: redactText(resolved.ambiguous.candidate, context.secrets) });
      continue;
    }
    const prefix = candidate.kind === "text" ? "text_" : candidate.kind === "input" ? "" : "";
    const suffix = candidate.kind === "input" ? "_input" : candidate.kind === "button" ? "_button" : "";
    const name = uniqueName(`${prefix}${pythonIdentifier(cleanName)}${suffix}`, taken);
    taken.add(name);
    locators.push({
      name,
      kind: candidate.kind,
      accessibleName: cleanName,
      python: redactText(resolved.python, context.secrets),
      count: 1,
      ...(resolved.disambiguatedBy ? { disambiguatedBy: resolved.disambiguatedBy } : {}),
      verifiedAt,
    });
  }

  const urlTemplate = toUrlTemplate(page.url(), context.baseUrl);
  return {
    id: context.screenId,
    name: context.screenId,
    className: `${pythonIdentifier(context.screenId).replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())}Page`,
    urlTemplate,
    signature: screenSignature(ariaSnapshot),
    requiresAuth: false,
    texts,
    probeValues: [],
    locators,
    states: [],
    ambiguous,
    transitions: [],
    writeActions: [],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: PASS (6 tests), or SKIPPED as a block if Playwright browsers are not installed. If skipped, run `npx playwright install chromium` and re-run — this task must not be reported as done on a skipped suite.

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/realCrawler.capture.test.ts
git commit -m "feat(core): capture a screen with browser-validated locators"
```

---

### Task 13: Real crawler — exploration queue, transitions and limits

**Files:**
- Modify: `core/src/appMap/realCrawler.ts`
- Create: `core/src/appMap/realCrawler.walk.test.ts`

**Interfaces:**
- Consumes: `captureScreen` from Task 12; `elementKey` from Task 5; `isSuspectedLoop` from Task 4; `CrawlInput`/`CrawlResult` from Task 11.
- Produces: `createRealCrawler(): Crawler` — the first pass only (navigation, no form submits).

- [ ] **Step 1: Write the failing test**

`core/src/appMap/realCrawler.walk.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { createRealCrawler } from "./realCrawler.js";
import type { CrawlLimits } from "./crawler.js";

const limits: CrawlLimits = {
  maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
  loopSuspicionThreshold: 3, excludeRoutes: [],
};

let site: Awaited<ReturnType<typeof startFixtureSite>>;
beforeAll(async () => { site = await startFixtureSite(); });
afterAll(async () => { await site.close(); });

describe.skipIf(!chromium.executablePath())("createRealCrawler — first pass", () => {
  it("discovers the routes reachable by clicking", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const templates = result.map.screens.map((s) => s.urlTemplate).sort();
    expect(templates).toContain("/");
    expect(templates).toContain("/reset.html");
  });

  it("collapses /item/1 and /item/2 into a single templated screen", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.screens.filter((s) => s.urlTemplate === "/item/:id")).toHaveLength(1);
  });

  it("records a transition for each click that changed screen", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.transitions.some((t) => t.urlChanged)).toBe(true);
  });

  it("asks before continuing down a suspected loop and honours a no", async () => {
    let asked = 0;
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits: { ...limits, loopSuspicionThreshold: 2 },
      callbacks: { confirmContinueOnLoop: async () => { asked += 1; return false; }, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(asked).toBeGreaterThan(0);
  });

  it("skips routes matched by excludeRoutes", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits: { ...limits, excludeRoutes: ["/reset.html"] },
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.screens.some((s) => s.urlTemplate === "/reset.html")).toBe(false);
  });

  it("marks the map incomplete when a safety limit stops the crawl", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits: { ...limits, maxScreens: 1 },
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.complete).toBe(false);
  });

  it("emits a start and an ok event per visited screen", async () => {
    const events: string[] = [];
    await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: (event) => events.push(`${event.status}:${event.message}`),
    });
    expect(events.some((e) => e.startsWith("ok:"))).toBe(true);
  });

  it("does not submit any form during the first pass", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.states).toHaveLength(0);
    expect(login?.writeActions.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/realCrawler.walk.test.ts`
Expected: FAIL — `createRealCrawler` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `core/src/appMap/realCrawler.ts`:

```ts
import { chromium } from "playwright";
import type { Crawler, CrawlInput, CrawlResult } from "./crawler.js";
import { MissingCrawlerToolError } from "./crawler.js";
import { elementKey } from "./elementIdentity.js";
import { isSuspectedLoop } from "./signature.js";
import type { AppMap, Screen, WriteAction } from "./schema.js";

function matchesExcluded(urlTemplate: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return regex.test(urlTemplate);
  });
}

async function collectWriteActions(page: Page, screen: Screen): Promise<WriteAction[]> {
  const actions: WriteAction[] = [];
  for (const submit of await page.locator("form button[type=submit], form input[type=submit]").all()) {
    const label = (await submit.innerText().catch(() => "")).trim() || "Enviar";
    const locator = screen.locators.find((l) => l.accessibleName === label && l.kind === "button");
    if (!locator) continue;
    actions.push({
      locator: locator.name,
      label,
      kind: "submit",
      formFields: screen.locators.filter((l) => l.kind === "input").map((l) => l.name),
    });
  }
  return actions;
}

export function createRealCrawler(): Crawler {
  return {
    async crawl(input: CrawlInput): Promise<CrawlResult> {
      const startedAt = Date.now();
      let browser;
      try {
        browser = await chromium.launch({ headless: input.headed !== true });
      } catch (err) {
        return {
          ok: false,
          error: new MissingCrawlerToolError(
            'No se pudo abrir el navegador. Ejecuta "npx playwright install chromium" e inténtalo de nuevo.'
          ).message,
        };
      }

      const context = await browser.newContext();
      const page = await context.newPage();
      const screens: Screen[] = [];
      const visitedTemplates = new Set<string>();
      const clickedElements = new Set<string>();
      const recentSignatures: string[] = [];
      const prunedTemplates = new Set<string>();
      let complete = true;

      const deadline = startedAt + input.limits.maxDurationMinutes * 60_000;
      const queue: { url: string; depth: number }[] = [{ url: input.baseUrl, depth: 0 }];

      try {
        while (queue.length > 0) {
          if (screens.length >= input.limits.maxScreens || Date.now() > deadline) {
            complete = false;
            input.emit({ agent: "explorador", status: "warn", depth: 0, message: "Límite de seguridad alcanzado, el mapa queda incompleto" });
            break;
          }

          const next = queue.shift()!;
          if (next.depth > input.limits.maxDepth) { complete = false; continue; }

          const stepStart = Date.now();
          await page.goto(next.url, { waitUntil: "domcontentloaded" });
          const template = toUrlTemplate(page.url(), input.baseUrl);
          if (visitedTemplates.has(template) || matchesExcluded(template, input.limits.excludeRoutes)) continue;
          if (prunedTemplates.has(template)) continue;
          visitedTemplates.add(template);

          const screenId = template === "/" ? "home" : pythonIdentifier(template).replace(/^_+/, "");
          const screen = await captureScreen(page, { screenId, baseUrl: input.baseUrl, secrets: secretsOf(input) });
          recentSignatures.push(screen.signature);

          if (isSuspectedLoop(recentSignatures, input.limits.loopSuspicionThreshold)) {
            const keepGoing = await input.callbacks.confirmContinueOnLoop({
              urlTemplate: template,
              repeats: input.limits.loopSuspicionThreshold,
            });
            if (!keepGoing) {
              prunedTemplates.add(template);
              input.emit({ agent: "explorador", status: "warn", depth: 1, message: `Rama podada por bucle: ${template}` });
              continue;
            }
            recentSignatures.length = 0;
          }

          screen.writeActions = await collectWriteActions(page, screen);
          screens.push(screen);
          input.emit({
            agent: "explorador", status: "ok", depth: 0,
            message: `${template} · pantalla ${screens.length}`,
            detail: `${screen.texts.length} textos · ${screen.locators.length} localizadores`,
            durationMs: Date.now() - stepStart,
          });

          // First pass: navigation only. Submits are recorded, never clicked.
          for (const locator of screen.locators.filter((l) => l.kind === "link" || l.kind === "button")) {
            if (screen.writeActions.some((action) => action.locator === locator.name)) continue;
            const key = elementKey({
              screenId: screen.id, role: locator.kind, accessibleName: locator.accessibleName ?? locator.name, index: 0,
            });
            if (clickedElements.has(key)) continue;
            clickedElements.add(key);

            await page.goto(next.url, { waitUntil: "domcontentloaded" });
            const before = page.url();
            await page.getByRole(locator.kind === "link" ? "link" : "button", {
              name: locator.accessibleName ?? "", exact: true,
            }).first().click({ timeout: 5_000 }).catch(() => undefined);
            await page.waitForLoadState("domcontentloaded").catch(() => undefined);
            const after = page.url();
            if (after === before) continue;

            const targetTemplate = toUrlTemplate(after, input.baseUrl);
            const external = !after.startsWith(input.baseUrl);
            screen.transitions.push({
              locator: locator.name,
              action: "click",
              toScreenId: external ? null : targetTemplate,
              urlChanged: true,
              ...(external ? { externalUrl: after } : {}),
            });
            if (!external && !visitedTemplates.has(targetTemplate)) queue.push({ url: after, depth: next.depth + 1 });
          }
        }
      } finally {
        await browser.close();
      }

      const map: AppMap = {
        schemaVersion: 1,
        appUrl: input.baseUrl,
        createdAt: new Date().toISOString(),
        complete,
        authenticated: false,
        screens,
        scenarios: [],
        stats: {
          screens: screens.length,
          locators: screens.reduce((sum, s) => sum + s.locators.length, 0),
          ambiguous: screens.reduce((sum, s) => sum + s.ambiguous.length, 0),
          durationMs: Date.now() - startedAt,
        },
      };
      return { ok: true, map };
    },
  };
}

function secretsOf(input: CrawlInput): string[] {
  return input.credentials ? [input.credentials.username, input.credentials.password] : [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/realCrawler.walk.test.ts`
Expected: PASS (8 tests). Do not report this task done on a skipped suite.

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/realCrawler.walk.test.ts
git commit -m "feat(core): walk the app recording routes, transitions and limits"
```

---

### Task 14: Real crawler — login and the approved write pass

**Files:**
- Modify: `core/src/appMap/realCrawler.ts`
- Create: `core/src/appMap/realCrawler.write.test.ts`

**Interfaces:**
- Consumes: `mergeScreenState` from Task 5; `CrawlCallbacks.approveWriteActions` from Task 11.
- Produces: no new exports — `createRealCrawler` gains authentication and the second pass.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/realCrawler.write.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { startFixtureSite } from "./__fixtures__/server.js";
import { createRealCrawler } from "./realCrawler.js";
import type { CrawlLimits } from "./crawler.js";

const limits: CrawlLimits = {
  maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
  loopSuspicionThreshold: 3, excludeRoutes: [],
};
const credentials = { username: "user@example.test", password: "s3cr3t-pass" };

let site: Awaited<ReturnType<typeof startFixtureSite>>;
beforeAll(async () => { site = await startFixtureSite(); });
afterAll(async () => { await site.close(); });

describe.skipIf(!chromium.executablePath())("createRealCrawler — write pass", () => {
  it("does not execute any write action when the user approves none", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.states).toHaveLength(0);
  });

  it("captures the error message only reachable by submitting invalid data", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.texts).toContain("Authentication failed. Please try again.");
    expect(login?.states.some((s) => s.reachedBy.data === "invalid")).toBe(true);
  });

  it("keeps the error message as a state of the same screen, not a new screen", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.screens.filter((s) => s.urlTemplate === "/")).toHaveLength(1);
  });

  it("records the values it typed in probeValues and keeps them out of texts", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    const login = result.map.screens.find((s) => s.urlTemplate === "/");
    expect(login?.probeValues.length).toBeGreaterThan(0);
    for (const value of login!.probeValues) expect(login!.texts).not.toContain(value);
  });

  it("marks the map as authenticated when the login succeeds", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.map.authenticated).toBe(true);
  });

  it("never leaks the real password into the map", async () => {
    const result = await createRealCrawler().crawl({
      baseUrl: site.url, limits, credentials,
      callbacks: {
        confirmContinueOnLoop: async () => false,
        approveWriteActions: async (actions) => actions.map((a) => ({ screenId: a.screenId, locator: a.action.locator })),
      },
      emit: () => {},
    });
    if (!result.ok) throw new Error(result.error);
    expect(JSON.stringify(result.map)).not.toContain("s3cr3t-pass");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/realCrawler.write.test.ts`
Expected: FAIL — no state is ever produced; the "authentication failed" assertions fail.

- [ ] **Step 3: Write the implementation**

Add to `core/src/appMap/realCrawler.ts` and call it after the first pass, before
building the map:

```ts
import { mergeScreenState } from "./elementIdentity.js";

const INVALID_EMAIL = "agente-qa-probe@example.invalid";
const INVALID_PASSWORD = "agente-qa-invalid-password";

function valueFor(fieldName: string, data: "valid" | "invalid", credentials?: CrawlCredentials): string {
  const looksLikeEmail = /email|correo|user|usuario/i.test(fieldName);
  const looksLikePassword = /password|contrasena|contraseña|clave/i.test(fieldName);
  if (data === "invalid") return looksLikeEmail ? INVALID_EMAIL : looksLikePassword ? INVALID_PASSWORD : "";
  if (looksLikeEmail) return credentials?.username ?? "agente-qa@example.test";
  if (looksLikePassword) return credentials?.password ?? "agente-qa-valid-password";
  return "agente-qa";
}

/**
 * Every approved write action runs TWICE, with different data, because the two
 * outcomes are different screens and both are needed. Without the invalid
 * variant the map would not contain the app's error messages at all — those
 * texts do not exist until somebody submits the form wrong, and that is exactly
 * the literal that was missing when a generated test invented
 * get_by_role("alert").
 */
async function runWritePass(
  page: Page,
  screens: Screen[],
  approved: { screenId: string; locator: string }[],
  input: CrawlInput
): Promise<void> {
  const secrets = secretsOf(input);
  for (const { screenId, locator: locatorName } of approved) {
    const index = screens.findIndex((s) => s.id === screenId);
    if (index < 0) continue;
    let screen = screens[index];
    const action = screen.writeActions.find((a) => a.locator === locatorName);
    if (!action) continue;

    for (const data of ["invalid", "valid"] as const) {
      const probeValues: string[] = [];
      await page.goto(input.baseUrl + screen.urlTemplate.replace(/^\//, ""), { waitUntil: "domcontentloaded" });

      for (const fieldName of action.formFields) {
        const field = screen.locators.find((l) => l.name === fieldName);
        if (!field?.accessibleName) continue;
        const value = valueFor(field.accessibleName, data, input.credentials);
        probeValues.push(value);
        await page.getByRole("textbox", { name: field.accessibleName, exact: true })
          .fill(value, { timeout: 5_000 }).catch(() => undefined);
      }

      const before = page.url();
      await page.getByRole("button", { name: action.label, exact: true }).last()
        .click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);

      if (page.url() !== before) {
        // A successful submit navigates: that destination is an ordinary screen
        // and was, or will be, captured by the walk. Nothing to merge here.
        if (data === "valid") input.emit({ agent: "explorador", status: "ok", depth: 1, message: `Envío válido de "${action.label}" → ${page.url()}` });
        continue;
      }

      const after = await captureScreen(page, { screenId: screen.id, baseUrl: input.baseUrl, secrets });
      screen = mergeScreenState(screen, {
        id: `${data}-submit-${action.locator}`,
        reachedBy: { action: "submit", locator: action.locator, data },
        texts: after.texts.filter((t) => !probeValues.includes(t)),
        locators: after.locators.filter((l) => !screen.locators.some((existing) => existing.python === l.python)),
      });
      screen = { ...screen, probeValues: Array.from(new Set([...screen.probeValues, ...probeValues])) };
      screens[index] = screen;
      input.emit({
        agent: "explorador", status: "ok", depth: 1,
        message: `Envío ${data === "invalid" ? "inválido" : "válido"} de "${action.label}"`,
        detail: `${screen.states.at(-1)?.addsTexts.length ?? 0} textos nuevos`,
      });
    }
  }
}
```

Wire it into `crawl`: after the walk loop, collect
`screens.flatMap((screen) => screen.writeActions.map((action) => ({ screenId: screen.id, action })))`,
pass it to `input.callbacks.approveWriteActions`, run `runWritePass` with the
result, and set `authenticated` to true when a valid submit navigated away from
the login screen.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/realCrawler.write.test.ts`
Expected: PASS (6 tests). Do not report this task done on a skipped suite.

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/realCrawler.write.test.ts
git commit -m "feat(core): probe approved forms with valid and invalid data"
```

---

### Task 15: Candidate scenarios from the map

**Files:**
- Create: `core/src/prompts/explorador.ts`
- Create: `core/src/prompts/explorador.test.ts`
- Create: `core/src/agents/explorador/scenarioCandidates.ts`
- Create: `core/src/agents/explorador/scenarioCandidates.test.ts`

**Interfaces:**
- Consumes: `AppMap`, `ScenarioCandidate` from Task 2; `LLMProvider`, `parseJsonResponse` from `core`.
- Produces: `scenarioCandidatesPrompt(map: AppMap): string`, `generateScenarioCandidates(map: AppMap, llm: LLMProvider): Promise<ScenarioCandidate[]>`.

- [ ] **Step 1: Write the failing test**

`core/src/prompts/explorador.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { scenarioCandidatesPrompt } from "./explorador.js";
import type { AppMap } from "../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: true, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Authentication failed. Please try again."],
    probeValues: ["agente-qa-probe@example.invalid"],
    states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "log_in_button", kind: "button", accessibleName: "Log in", python: "x", count: 1, verifiedAt: "t" }],
  }],
};

describe("scenarioCandidatesPrompt", () => {
  it("includes each screen id and its texts", () => {
    const prompt = scenarioCandidatesPrompt(map);
    expect(prompt).toContain("login");
    expect(prompt).toContain("Authentication failed. Please try again.");
  });

  it("never includes the crawler's own probe values", () => {
    expect(scenarioCandidatesPrompt(map)).not.toContain("agente-qa-probe@example.invalid");
  });

  it("asks for JSON only", () => {
    expect(scenarioCandidatesPrompt(map)).toMatch(/JSON/);
  });
});
```

`core/src/agents/explorador/scenarioCandidates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateScenarioCandidates } from "./scenarioCandidates.js";
import type { AppMap } from "../../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, screens: [], scenarios: [],
  stats: { screens: 0, locators: 0, ambiguous: 0, durationMs: 0 },
};

describe("generateScenarioCandidates", () => {
  it("parses the model's JSON into candidates", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify([{ id: "login-ok", title: "Log in with valid credentials", screenId: "login", involvedScreens: ["login"], rationale: "flujo principal" }]),
    ]);
    const candidates = await generateScenarioCandidates(map, llm);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe("Log in with valid credentials");
  });

  it("drops a malformed candidate instead of failing the whole crawl", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify([{ id: "ok", title: "Fine", screenId: "login", involvedScreens: [], rationale: "r" }, { title: "missing id" }]),
    ]);
    const candidates = await generateScenarioCandidates(map, llm);
    expect(candidates).toHaveLength(1);
  });

  it("returns an empty list when the model answers with nothing usable", async () => {
    const llm = new FakeLLMProvider(["no soy JSON"]);
    await expect(generateScenarioCandidates(map, llm)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run core/src/prompts/explorador.test.ts core/src/agents/explorador/scenarioCandidates.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Write the implementation**

`core/src/prompts/explorador.ts`:

```ts
import type { AppMap } from "../appMap/schema.js";

export function scenarioCandidatesPrompt(map: AppMap): string {
  const screens = map.screens
    .map((screen) => {
      const texts = screen.texts.filter((text) => !screen.probeValues.includes(text));
      const transitions = screen.transitions.map((t) => `      ${t.locator} -> ${t.toScreenId ?? "(externo)"}`).join("\n");
      return [
        `  - id: ${screen.id}  (ruta ${screen.urlTemplate})`,
        `    textos: ${JSON.stringify(texts)}`,
        `    acciones: ${JSON.stringify(screen.locators.filter((l) => l.kind === "button" || l.kind === "link").map((l) => l.accessibleName))}`,
        transitions.length > 0 ? `    transiciones:\n${transitions}` : "",
      ].filter((line) => line.length > 0).join("\n");
    })
    .join("\n");

  return `Eres un ingeniero de QA. Este es el mapa completo de una aplicación web, obtenido
recorriéndola con un navegador real:

${screens}

Propón los escenarios que merezca la pena automatizar como test. Céntrate en flujos
completos que ya estén demostrados por las transiciones del mapa; no inventes pantallas ni
textos que no aparezcan arriba.

Responde SOLO con un array JSON, sin texto alrededor, con esta forma exacta:
[{"id": "kebab-case", "title": "En inglés", "screenId": "id de la pantalla donde empieza",
  "involvedScreens": ["ids"], "rationale": "por qué merece la pena, en castellano"}]`;
}
```

`core/src/agents/explorador/scenarioCandidates.ts`:

```ts
import type { LLMProvider } from "../../llm/provider.js";
import { parseJsonResponse } from "../../llm/parseJson.js";
import { ScenarioCandidateSchema, type AppMap, type ScenarioCandidate } from "../../appMap/schema.js";
import { scenarioCandidatesPrompt } from "../../prompts/explorador.js";

/**
 * Candidate scenarios are a convenience, not the product: a malformed answer
 * must never throw away a map that took minutes of real browsing to build.
 */
export async function generateScenarioCandidates(map: AppMap, llm: LLMProvider): Promise<ScenarioCandidate[]> {
  let raw: unknown;
  try {
    raw = parseJsonResponse(await llm.generate([{ role: "user", content: scenarioCandidatesPrompt(map) }]));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const candidates: ScenarioCandidate[] = [];
  for (const item of raw) {
    const parsed = ScenarioCandidateSchema.safeParse(item);
    if (parsed.success) candidates.push(parsed.data);
  }
  return candidates;
}
```

If `FakeLLMProvider`'s constructor signature differs from the one used above,
match the existing one in `core/src/llm/testUtils.ts` rather than changing it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run core/src/prompts/explorador.test.ts core/src/agents/explorador/scenarioCandidates.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/prompts/explorador.ts core/src/prompts/explorador.test.ts core/src/agents/explorador
git commit -m "feat(core): propose candidate scenarios from the finished map"
```

---

### Task 16: runExplorador orchestration

**Files:**
- Create: `core/src/agents/explorador/runExplorador.ts`
- Create: `core/src/agents/explorador/runExplorador.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `Crawler`, `FakeCrawler` (Task 11), `generateScenarioCandidates` (Task 15), `saveAppMap` (Task 7), `loadOverrides`/`applyOverrides` (Task 8), `redactMap` (Task 9), `emitPageObject` (Task 6), `EmitEvent` (Task 1).
- Produces: `ExploradorCallbacks`, `RunExploradorOptions`, `ExploradorResult`, `runExplorador(options: RunExploradorOptions): Promise<ExploradorResult>`.

- [ ] **Step 1: Write the failing test**

`core/src/agents/explorador/runExplorador.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeCrawler } from "../../appMap/testUtils.js";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { loadAppMap } from "../../appMap/mapStore.js";
import { saveOverride } from "../../appMap/overrides.js";
import { runExplorador } from "./runExplorador.js";
import type { AppMap } from "../../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 5 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false, texts: [], probeValues: [],
    states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "email_input", kind: "input", accessibleName: "Email",
      python: 'page.get_by_role("textbox", name="Email")', count: 1, verifiedAt: "t" }],
  }],
};

let projectRoot: string;
beforeEach(async () => { projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-exp-")); });
afterEach(async () => { await fs.rm(projectRoot, { recursive: true, force: true }); });

function options(overrides: Partial<Parameters<typeof runExplorador>[0]> = {}) {
  return {
    crawler: new FakeCrawler({ ok: true, map }),
    llm: new FakeLLMProvider(["[]"]),
    projectRoot,
    testsDir: "tests",
    baseUrl: "https://example.test/",
    limits: { maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [] },
    callbacks: {
      confirmContinueOnLoop: async () => true,
      approveWriteActions: async () => [],
      confirmOverwrite: async () => true,
      onOrphanOverride: () => {},
    },
    emit: () => {},
    ...overrides,
  };
}

describe("runExplorador", () => {
  it("saves the map to disk", async () => {
    await runExplorador(options());
    await expect(loadAppMap(projectRoot)).resolves.not.toBeNull();
  });

  it("writes one Page Object per screen", async () => {
    const result = await runExplorador(options());
    expect(result.writtenPaths.some((p) => p.endsWith("login_page.py"))).toBe(true);
    const content = await fs.readFile(path.join(projectRoot, "tests", "pages", "login_page.py"), "utf-8");
    expect(content).toContain("def get_email_input(self) -> Locator:");
  });

  it("reapplies a manual override onto the fresh map", async () => {
    await saveOverride(projectRoot, { screenId: "login", name: "email_input", python: 'page.get_by_label("Email")' });
    await runExplorador(options());
    const saved = await loadAppMap(projectRoot);
    expect(saved?.screens[0].locators[0].python).toBe('page.get_by_label("Email")');
  });

  it("reports an orphan override instead of dropping it silently", async () => {
    await saveOverride(projectRoot, { screenId: "gone", name: "x", python: "y" });
    const orphans: unknown[] = [];
    await runExplorador(options({ callbacks: { ...options().callbacks, onOrphanOverride: (o) => orphans.push(o) } }));
    expect(orphans).toHaveLength(1);
  });

  it("redacts credentials before anything reaches disk", async () => {
    const leaky: AppMap = { ...map, screens: [{ ...map.screens[0], texts: ["s3cr3t"] }] };
    await runExplorador(options({
      crawler: new FakeCrawler({ ok: true, map: leaky }),
      credentials: { username: "u@example.test", password: "s3cr3t" },
    }));
    const raw = await fs.readFile(path.join(projectRoot, ".agente-qa", "map", "map.json"), "utf-8");
    expect(raw).not.toContain("s3cr3t");
  });

  it("propagates a crawl failure as a thrown error", async () => {
    await expect(runExplorador(options({ crawler: new FakeCrawler({ ok: false, error: "sin navegador" }) })))
      .rejects.toThrow(/sin navegador/);
  });

  it("emits a summary event when it finishes", async () => {
    const messages: string[] = [];
    await runExplorador(options({ emit: (event) => messages.push(event.message) }));
    expect(messages.some((m) => /1 pantalla/.test(m))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/agents/explorador/runExplorador.test.ts`
Expected: FAIL — cannot resolve `./runExplorador.js`.

- [ ] **Step 3: Write the implementation**

`core/src/agents/explorador/runExplorador.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmitEvent } from "../../events/agentEvent.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { Crawler, CrawlCallbacks, CrawlCredentials, CrawlLimits } from "../../appMap/crawler.js";
import type { AppMap, LocatorOverride } from "../../appMap/schema.js";
import { saveAppMap } from "../../appMap/mapStore.js";
import { applyOverrides, loadOverrides } from "../../appMap/overrides.js";
import { redactMap } from "../../appMap/redact.js";
import { emitPageObject } from "../../appMap/pageObjectEmitter.js";
import { generateScenarioCandidates } from "./scenarioCandidates.js";

export interface ExploradorCallbacks extends CrawlCallbacks {
  confirmOverwrite(filePath: string): Promise<boolean>;
  onOrphanOverride(override: LocatorOverride): void;
}

export interface RunExploradorOptions {
  crawler: Crawler;
  llm: LLMProvider;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  limits: CrawlLimits;
  credentials?: CrawlCredentials;
  headed?: boolean;
  callbacks: ExploradorCallbacks;
  emit: EmitEvent;
}

export interface ExploradorResult {
  map: AppMap;
  mapPath: string;
  writtenPaths: string[];
}

export async function runExplorador(options: RunExploradorOptions): Promise<ExploradorResult> {
  const { crawler, llm, projectRoot, testsDir, baseUrl, limits, credentials, headed, callbacks, emit } = options;

  emit({ agent: "explorador", status: "start", depth: 0, message: "Mapeo de la aplicación" });

  const crawled = await crawler.crawl({
    baseUrl, credentials, limits, headed,
    callbacks: {
      confirmContinueOnLoop: callbacks.confirmContinueOnLoop,
      approveWriteActions: callbacks.approveWriteActions,
    },
    emit,
  });
  if (!crawled.ok) throw new Error(`No se pudo mapear la aplicación: ${crawled.error}`);

  const scenarios = await generateScenarioCandidates(crawled.map, llm);
  emit({ agent: "explorador", status: "ok", depth: 1, message: `${scenarios.length} escenario(s) candidato(s)` });

  const secrets = credentials ? [credentials.username, credentials.password] : [];
  const withScenarios: AppMap = { ...crawled.map, scenarios };
  const { map: patched, orphans } = applyOverrides(withScenarios, await loadOverrides(projectRoot));
  for (const orphan of orphans) callbacks.onOrphanOverride(orphan);

  const safe = redactMap(patched, secrets);
  const mapPath = await saveAppMap(projectRoot, safe);
  emit({ agent: "explorador", status: "ok", depth: 1, message: `Mapa guardado en ${mapPath}` });

  const writtenPaths: string[] = [];
  for (const screen of safe.screens) {
    const emitted = emitPageObject(screen);
    const target = path.join(projectRoot, testsDir, emitted.path);
    const exists = await fs.access(target).then(() => true, () => false);
    if (exists && !(await callbacks.confirmOverwrite(target))) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, emitted.content, "utf-8");
    writtenPaths.push(target);
  }

  emit({
    agent: "explorador", status: "ok", depth: 0,
    message: `${safe.stats.screens} pantalla(s) · ${safe.stats.locators} localizador(es) · ${safe.stats.ambiguous} ambiguo(s)`,
    durationMs: safe.stats.durationMs,
  });

  return { map: safe, mapPath, writtenPaths };
}
```

Add to `core/src/index.ts`:

```ts
export { runExplorador } from "./agents/explorador/runExplorador.js";
export type { ExploradorCallbacks, RunExploradorOptions, ExploradorResult } from "./agents/explorador/runExplorador.js";
export { generateScenarioCandidates } from "./agents/explorador/scenarioCandidates.js";
export { createRealCrawler } from "./appMap/realCrawler.js";
export { emitPageObject } from "./appMap/pageObjectEmitter.js";
export { redactMap, redactText, REDACTED } from "./appMap/redact.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/agents/explorador/runExplorador.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/explorador core/src/index.ts
git commit -m "feat(core): orchestrate the explorer agent end to end"
```

---

### Task 17: CLI command and menu entry

**Files:**
- Create: `cli/src/commands/map.ts`
- Create: `cli/src/commands/map.test.ts`
- Modify: `cli/src/menu.ts`
- Modify: `cli/bin/agente-qa.ts`
- Modify: `core/src/config/projectConfig.ts` (add the `crawl` block)
- Modify: `core/src/config/projectConfig.test.ts`

**Interfaces:**
- Consumes: `runExplorador`, `createRealCrawler`, `formatAgentEvent`, `loadProjectConfig`, `requireAppUrl`, `loadProjectEnv`.
- Produces: `runMapCommand(deps): Promise<void>` and the `Mapear aplicación` menu entry.

- [ ] **Step 1: Write the failing tests**

`core/src/config/projectConfig.test.ts` — add:

```ts
it("defaults the crawl block when the config has none", () => {
  const parsed = ProjectConfigSchema.parse({ testsDir: "tests", appUrl: "https://example.test/" });
  expect(parsed.crawl).toEqual({
    maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [],
  });
});

it("keeps user-supplied crawl limits", () => {
  const parsed = ProjectConfigSchema.parse({
    testsDir: "tests", appUrl: "https://example.test/",
    crawl: { maxScreens: 20, maxDepth: 3, maxDurationMinutes: 5, loopSuspicionThreshold: 2, excludeRoutes: ["/admin/*"] },
  });
  expect(parsed.crawl.excludeRoutes).toEqual(["/admin/*"]);
});
```

`cli/src/commands/map.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runMapCommand } from "./map.js";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    runExplorador: vi.fn(async () => ({ map: { stats: { screens: 2 } }, mapPath: "/tmp/map.json", writtenPaths: ["/tmp/pages/a.py"] })),
    loadConfig: vi.fn(async () => ({
      testsDir: "tests", appUrl: "https://example.test/",
      crawl: { maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [] },
    })),
    loadEnv: vi.fn(async () => ({ AGENTE_QA_TEST_USERNAME: "u", AGENTE_QA_TEST_PASSWORD: "p" })),
    log: vi.fn(),
    ...overrides,
  };
}

describe("runMapCommand", () => {
  it("passes the configured limits through to the agent", async () => {
    const d = deps();
    await runMapCommand("/project", d as never);
    expect(d.runExplorador).toHaveBeenCalledTimes(1);
    expect((d.runExplorador.mock.calls[0][0] as { limits: { maxScreens: number } }).limits.maxScreens).toBe(500);
  });

  it("passes the test credentials through when present", async () => {
    const d = deps();
    await runMapCommand("/project", d as never);
    const passed = d.runExplorador.mock.calls[0][0] as { credentials?: { username: string } };
    expect(passed.credentials?.username).toBe("u");
  });

  it("prints a warning about mapping with a real account before starting", async () => {
    const d = deps();
    await runMapCommand("/project", d as never);
    expect(d.log.mock.calls.flat().join("\n")).toMatch(/cuenta de pruebas/i);
  });

  it("reports the failure message when the agent throws", async () => {
    const d = deps({ runExplorador: vi.fn(async () => { throw new Error("sin navegador"); }) });
    await runMapCommand("/project", d as never);
    expect(d.log.mock.calls.flat().join("\n")).toContain("sin navegador");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run cli/src/commands/map.test.ts core/src/config/projectConfig.test.ts`
Expected: FAIL — `crawl` is not in the schema; `./map.js` does not exist.

- [ ] **Step 3: Write the implementation**

In `core/src/config/projectConfig.ts`, add to `ProjectConfigSchema`:

```ts
crawl: z
  .object({
    maxScreens: z.number().int().min(1).default(500),
    maxDepth: z.number().int().min(1).default(25),
    maxDurationMinutes: z.number().int().min(1).default(60),
    loopSuspicionThreshold: z.number().int().min(2).default(3),
    excludeRoutes: z.array(z.string()).default([]),
  })
  .default({}),
```

`cli/src/commands/map.ts`:

```ts
import inquirer from "inquirer";
import {
  createRealCrawler, runExplorador as runExploradorReal,
  loadProjectConfig, loadProjectEnv, type AgentEvent,
} from "@agente-qa/core";
import { formatAgentEvent } from "../util/renderEvent.js";

export interface MapCommandDeps {
  runExplorador: typeof runExploradorReal;
  loadConfig: typeof loadProjectConfig;
  loadEnv: typeof loadProjectEnv;
  log: (message: string) => void;
}

const realDeps: MapCommandDeps = {
  runExplorador: runExploradorReal,
  loadConfig: loadProjectConfig,
  loadEnv: loadProjectEnv,
  log: (message) => console.log(message),
};

export async function runMapCommand(projectRoot: string, deps: MapCommandDeps = realDeps): Promise<void> {
  const config = await deps.loadConfig(projectRoot);
  const env = await deps.loadEnv(projectRoot);

  deps.log("\nMapeo de la aplicación (Agente 1)");
  deps.log("Usa SIEMPRE una cuenta de pruebas: el recorrido autenticado captura lo que esa");
  deps.log("cuenta ve, y el mapa se guarda en el git del proyecto.\n");

  try {
    const result = await deps.runExplorador({
      crawler: createRealCrawler(),
      llm: await buildLlm(projectRoot),
      projectRoot,
      testsDir: config.testsDir,
      baseUrl: config.appUrl,
      limits: config.crawl,
      credentials:
        env.AGENTE_QA_TEST_USERNAME && env.AGENTE_QA_TEST_PASSWORD
          ? { username: env.AGENTE_QA_TEST_USERNAME, password: env.AGENTE_QA_TEST_PASSWORD }
          : undefined,
      headed: config.headedMode,
      callbacks: {
        confirmContinueOnLoop: async ({ urlTemplate, repeats }) => {
          const { seguir } = await inquirer.prompt([{
            type: "confirm", name: "seguir", default: false,
            message: `"${urlTemplate}" se repite ${repeats} veces con la misma estructura. ¿Sigo explorando por ahí?`,
          }]);
          return seguir as boolean;
        },
        approveWriteActions: async (actions) => {
          if (actions.length === 0) return [];
          const { elegidas } = await inquirer.prompt([{
            type: "checkbox", name: "elegidas",
            message: "Estas acciones envían formularios y pueden modificar datos. ¿Cuáles puedo ejecutar?",
            choices: actions.map((a) => ({ name: `${a.screenId} · ${a.action.label}`, value: `${a.screenId}::${a.action.locator}` })),
          }]);
          return (elegidas as string[]).map((value) => {
            const [screenId, locator] = value.split("::");
            return { screenId, locator };
          });
        },
        confirmOverwrite: async (filePath) => {
          const { sobrescribir } = await inquirer.prompt([{
            type: "confirm", name: "sobrescribir", default: true,
            message: `Ya existe ${filePath}. ¿Lo sobrescribo?`,
          }]);
          return sobrescribir as boolean;
        },
        onOrphanOverride: (override) => {
          deps.log(`  ⚠ Corrección manual huérfana: ${override.screenId}.${override.name} ya no existe en el mapa.`);
        },
      },
      emit: (event: AgentEvent) => deps.log(formatAgentEvent(event)),
    });
    deps.log(`\nMapa listo: ${result.mapPath}`);
    deps.log(`Page Objects escritos: ${result.writtenPaths.length}`);
  } catch (err) {
    deps.log(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

`buildLlm` is the same three lines `cli/src/commands/chat.ts:18-28` already runs.
Extract them verbatim into `cli/src/util/buildLlm.ts` and have `chat.ts` import
from there, so the two commands cannot drift apart:

```ts
import {
  createProvider, loadProjectEnv, projectEnvPath, requireLlmConfig, type LLMProvider,
} from "@agente-qa/core";
import { withLLMSpinner } from "./spinner.js";

export async function buildLlm(projectRoot: string): Promise<LLMProvider> {
  const env = await loadProjectEnv(projectRoot);
  if (!env) throw new Error("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
  return withLLMSpinner(createProvider(requireLlmConfig(env, projectEnvPath(projectRoot))));
}
```

Add the menu entry in `cli/src/menu.ts` as the first option, `"Mapear
aplicación (Agente 1)"`, and register a `map` subcommand in
`cli/bin/agente-qa.ts` alongside `init`/`chat`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run cli/src/commands/map.test.ts core/src/config/projectConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

```bash
npm run build --workspace=core
npx tsc -p core/tsconfig.json --noEmit
npx tsc -p cli/tsconfig.json --noEmit
npx vitest run
git add cli/src core/src/config/projectConfig.ts core/src/config/projectConfig.test.ts
git commit -m "feat(cli): add the map command and menu entry for the explorer agent"
```

---

## Self-Review

**Spec coverage:** §4.1 preflight → Task 17 (config + env loading before the crawl). §4.2 capture and disambiguation → Task 12. §4.3 URL template, signature, states, element identity → Tasks 3, 4, 5. §4.4 queue → Task 13. §4.5 loop detection and safety limits → Tasks 4, 13, 17. §4.6 two passes → Tasks 13, 14. §4.7 authentication → Task 14. §4.8 LLM role → Task 15. §5.1 map schema → Task 2. §5.2 overrides → Task 8. §5.3 Page Objects → Task 6. §5.4 versioning → Task 17 (no gitignore entry is added for `pages/`). §10 event channel → Task 1, consumed by Tasks 13-17. §12 security → Tasks 9, 12, 14, 17. §13 error handling → Tasks 7, 8, 13, 16, 17. §14 testing → Task 10 plus every task's own tests.

**Deliberately deferred to the switchover plan:** §6 Gherkin contract, §7 Intake, §8 Generador, §9 agents 4 and 5, §11 removals, §15 README. Each is listed at the top of this plan as out of scope.

**Known follow-up inside this plan:** Task 13 emits `screenId` values derived from the route; Task 15's prompt and Task 16's overrides both key on that same `id`, so the derivation lives in exactly one place (`realCrawler.ts`) and must not be duplicated.
