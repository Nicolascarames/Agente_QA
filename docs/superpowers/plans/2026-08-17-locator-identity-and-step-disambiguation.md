# Locator Identity and Step Disambiguation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an emitted locator runnable, make its name depend on the fact that distinguished it rather than on crawl order, and make an ambiguous Gherkin step ask the user instead of silently picking the first match.

**Architecture:** One shared `page.` → `self.page.` rewrite owned by a single module and consumed by both the Page Object emitter and the freshness check. A locator's name suffix derives from its `disambiguatedBy`, never from a counter. `locatorsUsedBy` stops resolving ambiguity and reports it; `runGenerador` asks through a new callback, then rewrites the step in the `.feature` so the ambiguity is gone from the artifact forever.

**Tech Stack:** TypeScript (ESM NodeNext), Vitest, Zod v4, Playwright (Node, for the crawler) and Playwright Python (for the emitted tests).

**Spec:** `docs/superpowers/specs/2026-08-17-locator-identity-and-step-disambiguation-design.md`

## Global Constraints

- `core/src` never does terminal I/O — no `console.*`, no `readline`. Progress leaves through the injected `emit`; questions cross each agent's callbacks.
- Explicit DI: `core` functions take `projectRoot` as a parameter and never read `process.cwd()`. Tests use a real `fs.mkdtemp`, never a mocked `fs`.
- Relative imports carry the `.js` suffix even when the file is `.ts` (ESM NodeNext).
- Zod is v4: `z.record()` takes two arguments.
- Code, identifiers and commit messages in English; Conventional Commits. Everything the end user reads is Spanish (Spain).
- Generated `.feature` files are English, with quoted literals copied character for character from the map.
- A locator is never disambiguated by position (`.first`, `.last`, `.nth`) nor by `class`.
- **A locator name never depends on crawl order.** No counters. This is the property Task 2 and Task 3 exist to establish.
- The Playwright Node API is camelCase; the Python that gets emitted is snake_case. Never unified.
- `cli` imports `core` as `@agente-qa/core`. If `tsc` cannot resolve it, run `npm run build --workspace=core` — never edit `cli/tsconfig.json`.
- Baseline to preserve: 610 passing, 3 skipped; `tsc` clean in both packages; full build green.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/appMap/pythonExpression.ts` (new) | Sole owner of the `page.` → `self.page.` rewrite. |
| `core/src/appMap/pageObjectEmitter.ts` | Consumes the shared rewrite instead of prefixing `self.`. |
| `core/src/locatorVerify/mapFreshness.ts` | Consumes the shared rewrite; `locatorsUsedBy` reports ambiguity instead of resolving it. |
| `core/src/appMap/naming.ts` | Derives a locator name suffix from its disambiguator. |
| `core/src/appMap/realCrawler.ts` | Names locators through the new helper. |
| `core/src/agents/generador/rewriteStepLocator.ts` (new) | Pure Gherkin surgery: replace a quoted locator literal under one `@screen:` tag. |
| `core/src/agents/generador/runGenerador.ts` | Asks on ambiguity, rewrites the `.feature`, announces it. |
| `cli/src/prompts/types.ts`, `cli/src/prompts/inquirerPrompts.ts` | The prompt, with the read-only map dump. |

---

### Task 1: One owner for the `self.page` rewrite

**Files:**
- Create: `core/src/appMap/pythonExpression.ts`
- Create: `core/src/appMap/pythonExpression.test.ts`
- Modify: `core/src/appMap/pageObjectEmitter.ts`
- Modify: `core/src/appMap/pageObjectEmitter.test.ts`
- Modify: `core/src/locatorVerify/mapFreshness.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Produces: `toSelfPageExpression(python: string): string`.
- Consumed by Tasks 4 and 6 only indirectly; nothing else in this plan calls it.

- [ ] **Step 1: Write the failing test**

`core/src/appMap/pythonExpression.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toSelfPageExpression } from "./pythonExpression.js";

describe("toSelfPageExpression", () => {
  it("rewrites a plain expression", () => {
    expect(toSelfPageExpression('page.get_by_role("button", name="Log in", exact=True)')).toBe(
      'self.page.get_by_role("button", name="Log in", exact=True)'
    );
  });

  it("rewrites EVERY page reference, not just the leading one", () => {
    // This is the whole point: an attribute-disambiguated locator carries a
    // second `page.` inside `.and_(...)`, and leaving it bare raises
    // NameError at runtime inside a Page Object method.
    const input =
      'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))';
    const out = toSelfPageExpression(input);
    expect(out).toBe(
      'self.page.get_by_role("button", name="Log in", exact=True).and_(self.page.locator("[type=\'submit\']"))'
    );
    expect(out).not.toMatch(/(?<!self\.)\bpage\./);
  });

  it("does not corrupt an identifier that merely ends in page", () => {
    expect(toSelfPageExpression("login_page.get_by_role()")).toBe("login_page.get_by_role()");
  });

  it("leaves an expression that does not start from page untouched", () => {
    expect(toSelfPageExpression('self.page.locator("#x")')).toBe('self.page.locator("#x")');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/pythonExpression.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`core/src/appMap/pythonExpression.ts`:

```ts
/**
 * Every `page.` in a stored locator expression becomes `self.page.` — not just
 * the first. An attribute-disambiguated locator carries a second reference
 * inside `.and_(...)`, and a bare `page` inside a Page Object method raises
 * `NameError: name 'page' is not defined` at runtime.
 *
 * `\b` does not match inside `login_page.` because `_` is a word character, so
 * an expression that already goes through a Page Object survives unchanged.
 *
 * This function has exactly one owner on purpose: the same rule used to live
 * in the emitter and in the freshness check as two separate copies, and both
 * copies were wrong at once.
 */
export function toSelfPageExpression(python: string): string {
  return python.replace(/\bpage\./g, "self.page.");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/pythonExpression.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Use it in the emitter**

In `core/src/appMap/pageObjectEmitter.ts`, add the import:

```ts
import { toSelfPageExpression } from "./pythonExpression.js";
```

and replace the body line of the getter (currently `` `        return self.${locator.python}` ``) with:

```ts
    `        return ${toSelfPageExpression(locator.python)}`,
```

- [ ] **Step 6: Use it in the freshness check**

In `core/src/locatorVerify/mapFreshness.ts`, delete the local `toSelfPageExpression` function entirely and import the shared one instead:

```ts
import { toSelfPageExpression } from "../appMap/pythonExpression.js";
```

Leave every call site as it is — the name is identical.

- [ ] **Step 7: Export it from the barrel**

In `core/src/index.ts`, beside the other `appMap` exports:

```ts
export { toSelfPageExpression } from "./appMap/pythonExpression.js";
```

- [ ] **Step 8: Add the invariant test to the emitter**

Append to `core/src/appMap/pageObjectEmitter.test.ts`, inside the existing top-level `describe`:

```ts
  it("emits no bare page reference for an attribute-disambiguated locator", () => {
    const screen: Screen = {
      id: "home", name: "home", className: "HomePage", urlTemplate: "/",
      signature: "sha256:a", requiresAuth: false,
      texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
      locators: [
        {
          name: "log_in_button_submit", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))',
          count: 1, disambiguatedBy: "attribute:[type='submit']", verifiedAt: "t",
        },
      ],
    };
    // A bare `page.` anywhere in the emitted class is a NameError waiting to
    // happen: inside a method only `self.page` exists.
    expect(emitPageObject(screen).content).not.toMatch(/(?<!self\.)\bpage\./);
  });
```

Reuse whatever `Screen` import and fixture style the file already has; if it builds screens through a helper, use that helper instead of the literal above and keep the locator exactly as written.

- [ ] **Step 9: Prove it by execution, not by string comparison**

String equality is what let this bug ship. Add a gated test that actually runs the emitted class. Append the `describe` block below to `core/src/appMap/pageObjectEmitter.test.ts`, and move its four `import` lines to the top of the file beside the existing imports — they are shown here only so you know which ones the block needs:

```ts
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const hasPython = spawnSync("python", ["--version"], { encoding: "utf-8" }).status === 0;

describe.skipIf(!hasPython)("emitted Page Object executes", () => {
  it("resolves an attribute-disambiguated getter without NameError", async () => {
    const screen: Screen = {
      id: "home", name: "home", className: "HomePage", urlTemplate: "/",
      signature: "sha256:a", requiresAuth: false,
      texts: [], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
      locators: [
        {
          name: "log_in_button_submit", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))',
          count: 1, disambiguatedBy: "attribute:[type='submit']", verifiedAt: "t",
        },
      ],
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-emit-"));
    const emitted = emitPageObject(screen);
    const modulePath = path.join(dir, "page_object.py");
    await fs.writeFile(modulePath, emitted.content, "utf-8");

    // A fake page: every call returns the fake, so the only way this fails is
    // a name that does not exist in the method's scope.
    const driver = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("po", ${JSON.stringify(modulePath).replace(/\\/g, "/")})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Fake:
    def __getattr__(self, _name):
        return lambda *a, **k: self

po = mod.HomePage(Fake())
po.get_log_in_button_submit()
print("OK")
`;
    const driverPath = path.join(dir, "driver.py");
    await fs.writeFile(driverPath, driver, "utf-8");

    const run = spawnSync("python", [driverPath], { encoding: "utf-8" });
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/NameError/);
    expect(run.stdout).toContain("OK");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 10: Run the tests**

Run: `npx vitest run core/src/appMap core/src/locatorVerify`
Expected: PASS. If `python` is absent the execution test is skipped, not failed.

- [ ] **Step 11: Prove the tests discriminate, by mutation**

Temporarily change `pythonExpression.ts` back to the old rule:

```ts
return python.startsWith("page.") ? `self.page.${python.slice("page.".length)}` : python;
```

Run: `npx vitest run core/src/appMap/pythonExpression.test.ts core/src/appMap/pageObjectEmitter.test.ts`
Expected: FAIL — the "rewrites EVERY page reference" test, the emitter invariant test, and (with python present) the execution test with `NameError`.
Then restore the correct implementation with `git checkout -- core/src/appMap/pythonExpression.ts` and confirm green again. Paste both outputs in your report.

- [ ] **Step 12: Commit**

```bash
git add core/src/appMap/pythonExpression.ts core/src/appMap/pythonExpression.test.ts core/src/appMap/pageObjectEmitter.ts core/src/appMap/pageObjectEmitter.test.ts core/src/locatorVerify/mapFreshness.ts core/src/index.ts
git commit -m "fix(core): rewrite every page reference when emitting a locator"
```

---

### Task 2: A locator name derived from its disambiguator

**Files:**
- Modify: `core/src/appMap/naming.ts`
- Modify: `core/src/appMap/naming.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Consumes: `pythonIdentifier` (already in this file).
- Produces: `disambiguatorToken(disambiguatedBy: string | undefined): string` and `disambiguatedName(base: string, disambiguatedBy: string | undefined, fingerprint: string, taken: Set<string>): string`. Task 3 calls `disambiguatedName`.
- `uniqueName` stays exactly as it is: the crawler also uses it for screen identifiers, which are not in this plan's scope.

- [ ] **Step 1: Write the failing test**

Append to `core/src/appMap/naming.test.ts`:

```ts
import { disambiguatorToken, disambiguatedName } from "./naming.js";

describe("disambiguatorToken", () => {
  it("takes the value out of an attribute condition", () => {
    expect(disambiguatorToken("attribute:[type='submit']")).toBe("submit");
    expect(disambiguatorToken("attribute:[data-testid='login-submit']")).toBe("login_submit");
  });

  it("falls back to the whole condition when the attribute has no value", () => {
    expect(disambiguatorToken("attribute:[disabled]")).toBe("disabled");
  });

  it("takes the role from a region scope and the selector from a css scope", () => {
    expect(disambiguatorToken("region:banner")).toBe("banner");
    expect(disambiguatorToken("selector:form")).toBe("form");
  });

  it("gives nothing when there was no disambiguator", () => {
    expect(disambiguatorToken(undefined)).toBe("");
  });
});

describe("disambiguatedName", () => {
  it("appends the token that tells the two apart", () => {
    expect(disambiguatedName("log_in_button", "attribute:[type='submit']", "p1", new Set())).toBe(
      "log_in_button_submit"
    );
  });

  it("suppresses a token that only repeats the tail of the base name", () => {
    expect(disambiguatedName("log_in_button", "attribute:[type='button']", "p1", new Set())).toBe(
      "log_in_button"
    );
  });

  it("keeps the redundant token rather than colliding", () => {
    const taken = new Set(["log_in_button"]);
    expect(disambiguatedName("log_in_button", "attribute:[type='button']", "p1", taken)).toBe(
      "log_in_button_button"
    );
  });

  it("never appends a counter: a collision falls back to a fingerprint suffix", () => {
    const taken = new Set(["log_in_button", "log_in_button_submit"]);
    const name = disambiguatedName("log_in_button", "attribute:[type='submit']", "python-expr", taken);
    expect(name).not.toBe("log_in_button_2");
    expect(name.startsWith("log_in_button_submit_")).toBe(true);
  });

  it("is stable: the same element yields the same name regardless of when it was seen", () => {
    // The property the whole task exists for. `taken` differs (a different
    // crawl order), the element does not, so the name must not move.
    const first = disambiguatedName("log_in_button", "attribute:[type='submit']", "p1", new Set());
    const later = disambiguatedName("log_in_button", "attribute:[type='submit']", "p1", new Set(["other_button"]));
    expect(later).toBe(first);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/naming.test.ts`
Expected: FAIL — `disambiguatorToken` and `disambiguatedName` are not exported.

- [ ] **Step 3: Implement**

Append to `core/src/appMap/naming.ts`:

```ts
import { createHash } from "node:crypto";

const ATTRIBUTE_PREFIX = "attribute:";

/**
 * The word a disambiguator contributes to a locator's name, or "" when it has
 * none to give. `attribute:[type='submit']` contributes "submit"; a scope
 * contributes whatever follows its prefix.
 */
export function disambiguatorToken(disambiguatedBy: string | undefined): string {
  if (!disambiguatedBy) return "";
  if (disambiguatedBy.startsWith(ATTRIBUTE_PREFIX)) {
    const condition = disambiguatedBy.slice(ATTRIBUTE_PREFIX.length);
    const value = condition.match(/=\s*['"]([^'"]*)['"]/)?.[1];
    return pythonIdentifier(value ?? condition);
  }
  const separator = disambiguatedBy.indexOf(":");
  return pythonIdentifier(separator === -1 ? disambiguatedBy : disambiguatedBy.slice(separator + 1));
}

/**
 * A locator's name, suffixed by the fact that made it unique — never by a
 * counter. A counter encodes crawl order, so the same element could be
 * `log_in_button_2` today and `log_in_button_3` tomorrow, silently breaking
 * every reference to it. Deriving the suffix from `disambiguatedBy` makes the
 * name a property of the element instead.
 *
 * `fingerprint` is used only for the last-resort suffix: the locator's own
 * Python expression, which is unique whenever the disambiguation succeeded.
 */
export function disambiguatedName(
  base: string,
  disambiguatedBy: string | undefined,
  fingerprint: string,
  taken: Set<string>
): string {
  const token = disambiguatorToken(disambiguatedBy);
  if (token.length === 0) {
    return taken.has(base) ? `${base}_${fingerprintSuffix(fingerprint)}` : base;
  }
  // `log_in_button` + token "button" would say the same thing twice. Drop it,
  // unless dropping it collides with a sibling that already owns the base.
  if ((base === token || base.endsWith(`_${token}`)) && !taken.has(base)) return base;
  const withToken = `${base}_${token}`;
  if (!taken.has(withToken)) return withToken;
  return `${withToken}_${fingerprintSuffix(fingerprint)}`;
}

function fingerprintSuffix(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 6);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/naming.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from the barrel**

In `core/src/index.ts`, beside the existing `naming` exports if there are any, otherwise beside the other `appMap` exports:

```ts
export { disambiguatorToken, disambiguatedName } from "./appMap/naming.js";
```

- [ ] **Step 6: Commit**

```bash
git add core/src/appMap/naming.ts core/src/appMap/naming.test.ts core/src/index.ts
git commit -m "feat(core): derive a locator name suffix from its disambiguator"
```

---

### Task 3: The crawler names locators through the new helper

**Files:**
- Modify: `core/src/appMap/realCrawler.ts`
- Modify: `core/src/appMap/realCrawler.capture.test.ts`

**Interfaces:**
- Consumes: `disambiguatedName` from Task 2.
- Produces: locator names in the map that carry the disambiguator token and never a counter.

- [ ] **Step 1: Write the failing test**

The capture test file already drives the real crawler against a fixture through a real browser. Add a case with two same-named buttons distinguished by `type`, following whatever fixture-and-launch helper that file already uses — do not invent a new harness. The fixture page must contain:

```html
<form>
  <button type="button">Log in</button>
  <button type="submit">Log in</button>
</form>
```

and the assertion:

```ts
    const names = screen.locators.filter((l) => l.accessibleName === "Log in").map((l) => l.name).sort();
    // The submit says so in its name; neither name encodes crawl order.
    expect(names).toEqual(["log_in_button", "log_in_button_submit"]);
    expect(names.some((n) => /_\d+$/.test(n))).toBe(false);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: FAIL — the names come back as `log_in_button` and `log_in_button_2`.

- [ ] **Step 3: Implement**

In `core/src/appMap/realCrawler.ts`, add `disambiguatedName` to the existing import from `./naming.js`, then in the loop over `resolved.resolutions` replace:

```ts
      const name = uniqueName(`${prefix}${pythonIdentifier(cleanName)}${suffix}`, taken);
```

with:

```ts
      const base = `${prefix}${pythonIdentifier(cleanName)}${suffix}`;
      const name = disambiguatedName(base, resolution.disambiguatedBy, resolution.python, taken);
```

Leave the surrounding comment about `uniqueName` updated to describe what now happens, and leave every other `uniqueName` call site untouched — the route-template one is not part of this change.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole map suite**

Run: `npx vitest run core/src/appMap`
Expected: PASS. Existing tests that assert a `_2` name are asserting the defect — update them to the new expected name and say which ones you changed in your report.

- [ ] **Step 6: Prove the test discriminates, by mutation**

Temporarily restore the old line in `realCrawler.ts`:

```ts
      const name = uniqueName(`${prefix}${pythonIdentifier(cleanName)}${suffix}`, taken);
```

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: FAIL — the names come back `["log_in_button", "log_in_button_2"]`, and the `/_\d+$/` assertion catches the counter.
Restore with `git checkout -- core/src/appMap/realCrawler.ts`, re-run, confirm green. Paste both outputs in your report.

- [ ] **Step 7: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/realCrawler.capture.test.ts
git commit -m "feat(core): name a disambiguated locator after what distinguishes it"
```

---

### Task 4: `locatorsUsedBy` reports ambiguity instead of guessing

**Files:**
- Modify: `core/src/locatorVerify/mapFreshness.ts`
- Modify: `core/src/locatorVerify/mapFreshness.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AmbiguousStep {
    screenId: string;
    screenName: string;
    quoted: string;
    candidates: LocatorEntry[];
  }
  export interface UsedLocatorsResult {
    used: UsedLocator[];
    ambiguous: AmbiguousStep[];
  }
  export function locatorsUsedBy(featureText: string, map: AppMap): UsedLocatorsResult;
  ```
- `UsedLocator` and `checkMapFreshness` keep their current shapes. Task 6 consumes both fields.

- [ ] **Step 1: Write the failing test**

Append to `core/src/locatorVerify/mapFreshness.test.ts`, building the map with the file's existing fixture style:

```ts
describe("locatorsUsedBy with two locators sharing an accessible name", () => {
  const twinsMap: AppMap = {
    ...map,
    screens: [{
      id: "home", name: "home", className: "HomePage", urlTemplate: "/",
      signature: "sha256:t", requiresAuth: false,
      texts: ["Log in"], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
      locators: [
        { name: "log_in_button", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'button\']"))',
          count: 1, verifiedAt: "t" },
        { name: "log_in_button_submit", kind: "button", accessibleName: "Log in",
          python: 'page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type=\'submit\']"))',
          count: 1, verifiedAt: "t" },
      ],
    }],
  };

  const ambiguousFeature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n`;

  it("reports the ambiguity instead of silently taking the first match", () => {
    const result = locatorsUsedBy(ambiguousFeature, twinsMap);
    expect(result.used).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].quoted).toBe("Log in");
    expect(result.ambiguous[0].screenId).toBe("home");
    expect(result.ambiguous[0].candidates.map((c) => c.name)).toEqual([
      "log_in_button",
      "log_in_button_submit",
    ]);
  });

  it("resolves cleanly once the step names the locator itself", () => {
    const rewritten = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "log_in_button_submit"\n`;
    const result = locatorsUsedBy(rewritten, twinsMap);
    expect(result.ambiguous).toEqual([]);
    expect(result.used.map((u) => u.locator.name)).toEqual(["log_in_button_submit"]);
  });

  it("reports one ambiguity per quoted text, not one per step", () => {
    const twice = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n    When I click "Log in"\n`;
    expect(locatorsUsedBy(twice, twinsMap).ambiguous).toHaveLength(1);
  });

  it("treats the second quoted group of a fill step as data, never a locator", () => {
    const fill = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I fill "Log in" with "Log in"\n`;
    const result = locatorsUsedBy(fill, twinsMap);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].quoted).toBe("Log in");
  });
});
```

Every existing test in this file that calls `locatorsUsedBy(...)` directly must be updated to read `.used` — do that in this step, not later.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/locatorVerify/mapFreshness.test.ts`
Expected: FAIL — `locatorsUsedBy` returns an array.

- [ ] **Step 3: Implement**

In `core/src/locatorVerify/mapFreshness.ts`, add the two exported interfaces from the Interfaces block above, then change the resolution so that a name matching more than one locator becomes an ambiguity:

```ts
export function locatorsUsedBy(featureText: string, map: AppMap): UsedLocatorsResult {
  const used: UsedLocator[] = [];
  const ambiguous: AmbiguousStep[] = [];
  const seen = new Set<string>();
  const asked = new Set<string>();
  let currentScreenId: string | null = null;

  for (const rawLine of featureText.split(/\r?\n/)) {
    const line = rawLine.trim();

    const tag = line.match(SCREEN_TAG);
    if (tag) {
      currentScreenId = tag[1];
      continue;
    }
    if (/^Feature:/i.test(line)) {
      currentScreenId = null;
      continue;
    }
    if (currentScreenId === null) continue;

    const fillMatch = line.match(FILL_STEP);
    const name = fillMatch ? fillMatch[1] : line.match(CLICK_STEP)?.[1];
    if (!name) continue;

    const screen = findScreen(map, currentScreenId);
    if (!screen) continue;

    const byAccessibleName = screen.locators.filter((l) => l.accessibleName === name);
    if (byAccessibleName.length > 1) {
      // Taking the first match here is how a login scenario ends up clicking
      // the button that does not submit. The caller has to decide, so report
      // it: once per (screen, quoted text), because every step quoting the
      // same text on the same screen means the same element.
      const key = `${currentScreenId}::${name}`;
      if (asked.has(key)) continue;
      asked.add(key);
      ambiguous.push({
        screenId: currentScreenId,
        screenName: screen.name,
        quoted: name,
        candidates: byAccessibleName,
      });
      continue;
    }

    const locator = byAccessibleName[0] ?? screen.locators.find((l) => l.name === name);
    if (!locator) continue;

    const key = `${currentScreenId}::${locator.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    used.push({
      screenId: currentScreenId,
      screenName: screen.name,
      locator,
      urlTemplate: screen.urlTemplate,
      requiresAuth: screen.requiresAuth,
    });
  }

  return { used, ambiguous };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/locatorVerify`
Expected: PASS.

- [ ] **Step 5: Export the new types**

In `core/src/index.ts`, extend the existing `mapFreshness` type export line to include `AmbiguousStep` and `UsedLocatorsResult`.

- [ ] **Step 6: Commit**

`core/src/agents/generador/runGenerador.ts` will not compile until Task 6; that is the planned cut. Commit anyway:

```bash
git add core/src/locatorVerify/mapFreshness.ts core/src/locatorVerify/mapFreshness.test.ts core/src/index.ts
git commit -m "feat(core): report an ambiguous step instead of taking the first match"
```

---

### Task 5: Rewriting a step's locator literal

**Files:**
- Create: `core/src/agents/generador/rewriteStepLocator.ts`
- Create: `core/src/agents/generador/rewriteStepLocator.test.ts`
- Modify: `core/src/index.ts`

**Interfaces:**
- Produces: `rewriteStepLocator(featureText: string, screenId: string, quoted: string, locatorName: string): string`. Task 6 calls it.

- [ ] **Step 1: Write the failing test**

`core/src/agents/generador/rewriteStepLocator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rewriteStepLocator } from "./rewriteStepLocator.js";

describe("rewriteStepLocator", () => {
  it("replaces the quoted literal in a click step under the given screen", () => {
    const feature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit")).toBe(
      `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "log_in_button_submit"\n`
    );
  });

  it("replaces every step that quotes the same text under that screen", () => {
    const feature =
      `Feature: F\n\n  @screen:home\n  Scenario: A\n    When I click "Log in"\n\n  @screen:home\n  Scenario: B\n    When I click "Log in"\n`;
    const out = rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit");
    expect(out.match(/log_in_button_submit/g)).toHaveLength(2);
    expect(out).not.toContain('I click "Log in"');
  });

  it("rewrites only the field of a fill step, never the value", () => {
    const feature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I fill "Log in" with "Log in"\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "log_in_input")).toBe(
      `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I fill "log_in_input" with "Log in"\n`
    );
  });

  it("leaves another screen's identical step alone", () => {
    const feature =
      `Feature: F\n\n  @screen:home\n  Scenario: A\n    When I click "Log in"\n\n  @screen:other\n  Scenario: B\n    When I click "Log in"\n`;
    const out = rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit");
    expect(out).toContain(`@screen:other\n  Scenario: B\n    When I click "Log in"`);
  });

  it("leaves a Then step that merely asserts the same text alone", () => {
    const feature = `Feature: F\n\n  @screen:home\n  Scenario: S\n    Then I see "Log in"\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit")).toBe(feature);
  });

  it("preserves CRLF line endings", () => {
    const feature = `Feature: F\r\n\r\n  @screen:home\r\n  Scenario: S\r\n    When I click "Log in"\r\n`;
    expect(rewriteStepLocator(feature, "home", "Log in", "log_in_button_submit")).toContain("\r\n");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/agents/generador/rewriteStepLocator.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`core/src/agents/generador/rewriteStepLocator.ts`:

```ts
const SCREEN_TAG = /@screen:([\p{L}\p{N}_-]+)/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pin an ambiguous step to one locator by name. Only `I click "<x>"` and the
 * FIRST quoted group of `I fill "<x>" with "<y>"` name a locator; the fill
 * step's second group is test data and a `Then I see "<x>"` asserts app copy —
 * neither is ever rewritten.
 *
 * Scoped to the scenarios under `screenId`: the same words on another screen
 * are another screen's locators, and answering for one must not answer for the
 * other.
 */
export function rewriteStepLocator(
  featureText: string,
  screenId: string,
  quoted: string,
  locatorName: string
): string {
  const literal = escapeRegExp(quoted);
  const click = new RegExp(`(I click ")${literal}(")`);
  const fill = new RegExp(`(I fill ")${literal}(" with ")`);

  let current: string | null = null;
  return featureText
    .split(/\r?\n/)
    .map((line, index, lines) => {
      const tag = line.match(SCREEN_TAG);
      if (tag) {
        current = tag[1];
        return line;
      }
      if (/^\s*Feature:/i.test(line)) {
        current = null;
        return line;
      }
      if (current !== screenId) return line;
      const rewritten = line.replace(fill, `$1${locatorName}$2`);
      return rewritten === line ? line.replace(click, `$1${locatorName}$2`) : rewritten;
    })
    .join(featureText.includes("\r\n") ? "\r\n" : "\n");
}
```

The split/join round-trips a trailing newline on its own: a text ending in `\n` splits to a final empty element, which the join puts back. The `lines` and `index` parameters are unused — drop them from the `map` callback signature.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/agents/generador/rewriteStepLocator.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Export from the barrel**

```ts
export { rewriteStepLocator } from "./agents/generador/rewriteStepLocator.js";
```

- [ ] **Step 6: Commit**

```bash
git add core/src/agents/generador/rewriteStepLocator.ts core/src/agents/generador/rewriteStepLocator.test.ts core/src/index.ts
git commit -m "feat(core): pin an ambiguous Gherkin step to one locator by name"
```

---

### Task 6: The Generador asks, then writes the answer into the `.feature`

**Files:**
- Modify: `core/src/agents/generador/runGenerador.ts`
- Modify: `core/src/agents/generador/runGenerador.test.ts`

**Interfaces:**
- Consumes: `locatorsUsedBy` returning `{ used, ambiguous }` (Task 4), `rewriteStepLocator` (Task 5).
- Produces: `GeneratorCallbacks` gains
  ```ts
  onAmbiguousLocator(
    step: { screenId: string; screenName: string; quoted: string; candidates: LocatorEntry[] }
  ): Promise<LocatorEntry>;
  ```
  Task 7 implements it in the CLI.

- [ ] **Step 1: Write the failing test**

Append to `core/src/agents/generador/runGenerador.test.ts`, following the file's existing helpers for the temp project, the map on disk and the fake LLM:

```ts
  it("asks which locator an ambiguous step means, and writes the answer into the .feature", async () => {
    // Two buttons share the accessible name "Log in"; only one submits.
    const { projectRoot, featureFilePath } = await projectWithTwins(
      `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n`
    );
    const onAmbiguousLocator = vi.fn(async (step) =>
      step.candidates.find((c) => c.name === "log_in_button_submit")!
    );

    await runGenerador({ ...baseOptions(projectRoot, featureFilePath), callbacks: { ...callbacks(), onAmbiguousLocator } });

    expect(onAmbiguousLocator).toHaveBeenCalledTimes(1);
    const [step] = onAmbiguousLocator.mock.calls[0];
    expect(step.quoted).toBe("Log in");
    expect(step.candidates.map((c) => c.name)).toEqual(["log_in_button", "log_in_button_submit"]);

    // The answer lands in the artifact the user versions, not just in memory.
    const rewritten = await fs.readFile(featureFilePath, "utf-8");
    expect(rewritten).toContain('When I click "log_in_button_submit"');
    expect(rewritten).not.toContain('When I click "Log in"');
  });

  it("does not ask again once the .feature names the locator", async () => {
    const { projectRoot, featureFilePath } = await projectWithTwins(
      `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "log_in_button_submit"\n`
    );
    const onAmbiguousLocator = vi.fn();

    await runGenerador({ ...baseOptions(projectRoot, featureFilePath), callbacks: { ...callbacks(), onAmbiguousLocator } });

    expect(onAmbiguousLocator).not.toHaveBeenCalled();
  });

  it("verifies the locator the user chose, not the one that came first", async () => {
    const { projectRoot, featureFilePath, verifier } = await projectWithTwins(
      `Feature: F\n\n  @screen:home\n  Scenario: S\n    When I click "Log in"\n`
    );
    const onAmbiguousLocator = vi.fn(async (step) =>
      step.candidates.find((c) => c.name === "log_in_button_submit")!
    );

    await runGenerador({ ...baseOptions(projectRoot, featureFilePath), verifier, callbacks: { ...callbacks(), onAmbiguousLocator } });

    // The freshness check must run against the chosen locator's method.
    const checks = verifier.receivedCalls[0].checks.map((c) => c.method);
    expect(checks).toContain("get_log_in_button_submit");
    expect(checks).not.toContain("get_log_in_button");
  });
```

Write `projectWithTwins(featureText)` as a local helper in this file: it creates a temp project via the file's existing pattern, saves a map whose `home` screen holds the two locators from Task 4's fixture, writes `featureText` to `<testsDir>/features/twins.feature`, and returns the paths plus a `FakeLocatorVerifier` scripted with `[{ ok: true }]`. Every existing test in this file must gain `onAmbiguousLocator` in its callbacks object — default it to a `vi.fn()` that rejects, so a test that unexpectedly hits the ambiguity path fails loudly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL — `onAmbiguousLocator` does not exist and `locatorsUsedBy` now returns an object.

- [ ] **Step 3: Implement**

In `core/src/agents/generador/runGenerador.ts`:

1. Add `LocatorEntry` to the `../../appMap/schema.js` type import and `rewriteStepLocator` to the imports.
2. Extend `GeneratorCallbacks` with the `onAmbiguousLocator` member from the Interfaces block.
3. Replace the single `const used = locatorsUsedBy(featureText, map);` line with the resolution loop below, placed exactly where that line is today — before the freshness `emit` and before `checkMapFreshness`:

```ts
  let workingText = featureText;
  let resolution = locatorsUsedBy(workingText, map);

  if (resolution.ambiguous.length > 0) {
    for (const step of resolution.ambiguous) {
      const chosen = await callbacks.onAmbiguousLocator(step);
      workingText = rewriteStepLocator(workingText, step.screenId, step.quoted, chosen.name);
    }
    await fs.writeFile(featureFilePath, workingText, "utf-8");
    emit({
      agent: "generador", status: "ok", depth: 1,
      message: `Se ha concretado el localizador de ${resolution.ambiguous.length} paso(s) en ${featureFilePath}`,
      detail: resolution.ambiguous.map((s) => `"${s.quoted}"`).join(", "),
    });
    resolution = locatorsUsedBy(workingText, map);
  }

  const used = resolution.used;
```

4. Every later use of `featureText` — the code-generation prompt included — must read `workingText`, so the model sees the pinned step and not the ambiguous one. Search the function for `featureText` and change each remaining use.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run core/src/agents/generador`
Expected: PASS.

- [ ] **Step 5: Confirm `core` compiles and the cut from Task 4 is closed**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: clean, no output.

- [ ] **Step 6: Prove the tests discriminate, by mutation**

Temporarily make the ambiguity path silently pick the first candidate again, by replacing the body of the `if (resolution.ambiguous.length > 0)` block with nothing and changing Task 4's filter branch in `mapFreshness.ts` to `const locator = byAccessibleName[0] ?? ...` unconditionally.

Run: `npx vitest run core/src/agents/generador/runGenerador.test.ts`
Expected: FAIL — `onAmbiguousLocator` is never called, the `.feature` still reads `"Log in"`, and the verifier receives `get_log_in_button` instead of `get_log_in_button_submit`. All three new tests go red for three different reasons; if any stays green, that test is not guarding what it claims.
Restore with `git checkout -- core/src/agents/generador/runGenerador.ts core/src/locatorVerify/mapFreshness.ts`, re-run, confirm green. Paste both outputs in your report.

- [ ] **Step 7: Commit**

```bash
git add core/src/agents/generador/runGenerador.ts core/src/agents/generador/runGenerador.test.ts
git commit -m "feat(core): resolve an ambiguous step and pin the answer in the .feature"
```

---

### Task 7: The prompt, with the map in front of the user

**Files:**
- Modify: `cli/src/prompts/types.ts`
- Modify: `cli/src/prompts/inquirerPrompts.ts`
- Modify: `cli/src/commands/generate.ts`
- Modify: `cli/src/commands/generate.test.ts`

**Interfaces:**
- Consumes: `GeneratorCallbacks.onAmbiguousLocator` from Task 6.
- Produces: `GeneratorPrompts` gains the same member, and `generate.ts` wires it through.

- [ ] **Step 1: Write the failing test**

Append to `cli/src/commands/generate.test.ts`, following the file's existing mocking style:

```ts
  it("passes the prompt's ambiguity answer through to runGenerador", async () => {
    const chosen = { name: "log_in_button_submit", kind: "button", accessibleName: "Log in", python: "page.x", count: 1, verifiedAt: "t" };
    const prompts = { ...generatorPrompts(), onAmbiguousLocator: vi.fn(async () => chosen) };

    await runGenerateCommand({ ...baseArgs(), prompts });

    const [{ callbacks }] = runGeneradorMock.mock.calls[0];
    const step = { screenId: "home", screenName: "home", quoted: "Log in", candidates: [chosen] };
    await expect(callbacks.onAmbiguousLocator(step)).resolves.toBe(chosen);
    expect(prompts.onAmbiguousLocator).toHaveBeenCalledWith(step);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run cli/src/commands/generate.test.ts`
Expected: FAIL — `onAmbiguousLocator` is not on the prompts port.

- [ ] **Step 3: Implement the port**

In `cli/src/prompts/types.ts`, add to `GeneratorPrompts`:

```ts
  onAmbiguousLocator(step: {
    screenId: string;
    screenName: string;
    quoted: string;
    candidates: LocatorEntry[];
  }): Promise<LocatorEntry>;
```

importing `LocatorEntry` as a type from `@agente-qa/core`.

- [ ] **Step 4: Implement the prompt**

In `cli/src/prompts/inquirerPrompts.ts`, beside `onStaleLocator`, following its exact style:

```ts
    async onAmbiguousLocator(step) {
      console.log(
        `\n⚠ El texto "${step.quoted}" de la pantalla "${step.screenName}" coincide con ${step.candidates.length} elementos del mapa. Elige a cuál se refiere el paso.`
      );
      // Read-only dump: the user decides with every fact the map holds, and
      // nothing here edits map.json or the Page Object.
      for (const candidate of step.candidates) {
        console.log(`\n  ${candidate.name}   →   Page Object: get_${candidate.name}() / click_${candidate.name}()`);
        console.log(`    kind:            ${candidate.kind}`);
        console.log(`    accessibleName:  ${JSON.stringify(candidate.accessibleName ?? null)}`);
        console.log(`    python:          ${candidate.python}`);
        console.log(`    count:           ${candidate.count}`);
        console.log(`    disambiguatedBy: ${candidate.disambiguatedBy ?? "(ninguno)"}`);
        console.log(`    attributes:      ${JSON.stringify(candidate.attributes ?? {})}`);
        console.log(`    verifiedAt:      ${candidate.verifiedAt}`);
        if (candidate.stateId) console.log(`    estado:          ${candidate.stateId}`);
      }
      const name = await select<string>({
        message: `¿A cuál se refiere "${step.quoted}"?`,
        choices: step.candidates.map((c) => ({ name: c.name, value: c.name })),
      });
      return step.candidates.find((c) => c.name === name)!;
    },
```

- [ ] **Step 5: Wire it in the command**

In `cli/src/commands/generate.ts`, add to the callbacks object handed to `runGenerador`:

```ts
      onAmbiguousLocator: (step) => prompts.onAmbiguousLocator(step),
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run cli/src/commands`
Expected: PASS.

- [ ] **Step 7: Full verification**

Run, synchronously and in the foreground, reading each output:

```
npx vitest run
npx tsc -p core/tsconfig.json --noEmit
npm run build --workspace=core
npx tsc -p cli/tsconfig.json --noEmit
```

Expected: full suite green with zero failures and 3 skipped (or 4, if `python` is absent and Task 1's execution test skips); both typechecks clean.

- [ ] **Step 8: Commit**

```bash
git add cli/src/prompts/types.ts cli/src/prompts/inquirerPrompts.ts cli/src/commands/generate.ts cli/src/commands/generate.test.ts
git commit -m "feat(cli): ask which locator an ambiguous step means, showing the map"
```
