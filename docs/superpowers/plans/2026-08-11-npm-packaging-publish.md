# npm Packaging and First Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the packaging findings parked since Plan 1's final review (`files` field, build/test separation, internal dependency range) and harden `credentials.json`'s file permissions, so both `@agente-qa/core` and `agente-qa` are ready for their first real `npm publish`.

**Architecture:** Two independent config/code changes — package manifest + build-tsconfig cleanup in both workspaces (Task 1), and `credentials.ts` permission hardening (Task 2) — followed by a mandatory `seguridad-seo` audit and the manual publish steps, both outside the coded task loop (see the section after Task 2).

**Tech Stack:** TypeScript (strict, ESM/NodeNext), npm workspaces, Node `fs.chmod`.

## Global Constraints

- TypeScript strict mode across `core` and `cli`; no `any` in production code.
- Node.js >= 22.
- Package names are final and already confirmed: `@agente-qa/core` and `agente-qa`. Version for this first publish: `0.1.0` (already set in both `package.json`).
- The general `tsconfig.json` in each workspace (used by `npx tsc -p <pkg>/tsconfig.json --noEmit`, the typecheck command used throughout this project) must NOT change — test files stay typechecked exactly as today. Only a NEW, separate `tsconfig.build.json` per workspace excludes test files, and only the `"build"` npm script switches to it.
- `credentials.json` permission hardening must apply on every `saveCredentials` call, not just on first creation — an existing file from before this change (e.g. a user upgrading from an older version) must also get tightened permissions the next time they save credentials (e.g. via `agente-qa init`), not just brand-new files.
- Windows has no POSIX permission bits; `fs.chmod` there is best-effort and must never throw or block the write — permission tests are gated to POSIX only (`describe.skipIf(process.platform === "win32")`), same convention this project already uses for other environment-dependent tests (`ruff`/Python gating).
- No task in this plan performs the actual `npm login`/`npm publish` — that happens manually, after the `seguridad-seo` audit, outside the subagent-driven-development task loop (see the section after Task 2).

Spec reference: `docs/superpowers/specs/2026-08-11-npm-packaging-publish-design.md` (read this first — it has the full reasoning for every decision below; this plan only re-states what's needed to implement).

---

## File Structure

```
core/
  package.json                 # MODIFY: add "files", switch build script
  tsconfig.build.json           # NEW: build-only tsconfig, excludes *.test.ts
  src/config/
    credentials.ts               # MODIFY: chmod dir 0700, file 0600
    credentials.test.ts           # MODIFY: add POSIX-gated permission tests
cli/
  package.json                 # MODIFY: add "files", switch build script, fix @agente-qa/core range
  tsconfig.build.json           # NEW: build-only tsconfig, excludes *.test.ts
```

---

## Task 1: Package manifest cleanup + build/test tsconfig split

**Files:**
- Modify: `core/package.json`
- Create: `core/tsconfig.build.json`
- Modify: `cli/package.json`
- Create: `cli/tsconfig.build.json`

**Interfaces:**
- Consumes: existing `core/tsconfig.json` and `cli/tsconfig.json` (unchanged, both `"extends": "../tsconfig.base.json"`)
- Produces: `npm run build` (root, which runs `build` in both workspaces) emits `dist/` with no `*.test.js`/`*.test.d.ts` files in either package; `npx tsc -p core/tsconfig.json --noEmit` / `npx tsc -p cli/tsconfig.json --noEmit` behavior is completely unchanged (still typechecks test files)

This task has no unit test — it's build configuration. Verification is a real, concrete before/after shell check (the closest thing to RED/GREEN available for this kind of change), not a vitest test.

- [ ] **Step 1: Establish the RED baseline — confirm test files currently leak into `dist/`**

Run, from the repo root (`c:\GitHub\Agente_QA`):
```bash
rm -rf core/dist cli/dist
npm run build
find core/dist cli/dist -name "*.test.js" -o -name "*.test.d.ts"
```
Expected: the `find` command lists several `*.test.js`/`*.test.d.ts` files (e.g. `core/dist/config/credentials.test.js`, `core/dist/agents/reportes/parseJunitResults.test.js`, etc.) — this confirms the problem described in the spec is real, using the CURRENT (unfixed) build scripts.

- [ ] **Step 2: Implement the package.json and tsconfig.build.json changes**

`core/package.json` (full file):
```json
{
  "name": "@agente-qa/core",
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^4.0.36",
    "@ai-sdk/google": "^4.0.39",
    "@ai-sdk/openai": "^4.0.36",
    "ai": "^7.0.58",
    "fast-xml-parser": "^5.10.1",
    "zod": "^4.4.3"
  }
}
```

`core/tsconfig.build.json` (new file):
```json
{
  "extends": "./tsconfig.json",
  "exclude": ["**/*.test.ts"]
}
```

`cli/package.json` (full file):
```json
{
  "name": "agente-qa",
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "bin": {
    "agente-qa": "./dist/bin/agente-qa.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "@agente-qa/core": "^0.1.0",
    "@inquirer/prompts": "^8.5.2",
    "commander": "^15.0.0"
  }
}
```

`cli/tsconfig.build.json` (new file):
```json
{
  "extends": "./tsconfig.json",
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 3: Confirm GREEN — rebuild and verify test files no longer leak into `dist/`**

Run:
```bash
rm -rf core/dist cli/dist
npm run build
find core/dist cli/dist -name "*.test.js" -o -name "*.test.d.ts"
```
Expected: the `find` command produces NO output (no matches) — `dist/` in both packages now contains only production code, no compiled test files.

Also confirm the general typecheck command (used everywhere else in this project) is completely unaffected — it must still typecheck test files, since `tsconfig.json` itself was never touched:
```bash
npx tsc -p core/tsconfig.json --noEmit
npx tsc -p cli/tsconfig.json --noEmit
```
Expected: both exit 0 (clean), exactly as before this change.

- [ ] **Step 4: Run the full test suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: PASS, same pass/skip counts as before this task (this task touches no runtime source files, only build configuration — the suite itself must be unaffected).

- [ ] **Step 5: Commit**

```bash
git add core/package.json core/tsconfig.build.json cli/package.json cli/tsconfig.build.json
git commit -m "build: add files field, split build/test tsconfig, fix internal dependency range"
```

---

## Task 2: Harden `credentials.json` file permissions

**Files:**
- Modify: `core/src/config/credentials.ts`
- Modify: `core/src/config/credentials.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `saveCredentials(creds: Credentials, homeDir: string): Promise<void>` (unchanged signature) now leaves `~/.agente-qa/` at mode `0700` and `~/.agente-qa/credentials.json` at mode `0600` after every call, on POSIX systems

- [ ] **Step 1: Write the failing tests**

Replace `core/src/config/credentials.test.ts` in full:

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

  it("rejects and does not write the file when apiKey is empty", async () => {
    await expect(saveCredentials({ provider: "anthropic", apiKey: "" }, tmpHome)).rejects.toThrow();
    const exists = await fs.stat(credentialsPath(tmpHome)).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  describe.skipIf(process.platform === "win32")("file permissions (POSIX only)", () => {
    it("writes credentials.json with mode 0600 (owner read/write only)", async () => {
      await saveCredentials({ provider: "anthropic", apiKey: "sk-test-789" }, tmpHome);
      const stats = await fs.stat(credentialsPath(tmpHome));
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("creates the .agente-qa directory with mode 0700 (owner only)", async () => {
      await saveCredentials({ provider: "anthropic", apiKey: "sk-test-789" }, tmpHome);
      const dirStats = await fs.stat(path.join(tmpHome, ".agente-qa"));
      expect(dirStats.mode & 0o777).toBe(0o700);
    });

    it("tightens permissions on a pre-existing file/dir from before this change, not just on first creation", async () => {
      const dirPath = path.join(tmpHome, ".agente-qa");
      const filePath = credentialsPath(tmpHome);
      await fs.mkdir(dirPath, { recursive: true, mode: 0o755 });
      await fs.writeFile(filePath, JSON.stringify({ provider: "anthropic", apiKey: "old-key" }), {
        mode: 0o644,
      });

      await saveCredentials({ provider: "anthropic", apiKey: "new-key" }, tmpHome);

      const dirStats = await fs.stat(dirPath);
      const fileStats = await fs.stat(filePath);
      expect(dirStats.mode & 0o777).toBe(0o700);
      expect(fileStats.mode & 0o777).toBe(0o600);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run core/src/config/credentials.test.ts`
Expected: FAIL — the 3 new permission tests fail (`stats.mode & 0o777` is not `0o600`/`0o700`, since `saveCredentials` doesn't set any mode yet). The other 4 pre-existing tests still pass unchanged.

- [ ] **Step 3: Implement**

`core/src/config/credentials.ts` (full file):
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
  CredentialsSchema.parse(creds);
  const filePath = credentialsPath(homeDir);
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(creds, null, 2), "utf-8");
  // chmod explicitly, not just via the mode option on mkdir/writeFile, so an existing
  // directory/file from before this change also gets tightened on the next save —
  // the mode option only applies at creation time and is a no-op on an existing path.
  await fs.chmod(dirPath, 0o700);
  await fs.chmod(filePath, 0o600);
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/src/config/credentials.test.ts`
Expected: PASS (7 tests on POSIX, 4 tests + 3 skipped on Windows — check for `↓ skipped` vs `✓` in the output on Windows).

Then run the full suite once to catch any cross-file regressions:
Run: `npx vitest run`
Expected: PASS (all tests, same skip pattern as before this task plus the 3 new ones, skipped only on Windows).

And typecheck both packages:
Run: `npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add core/src/config/credentials.ts core/src/config/credentials.test.ts
git commit -m "fix(core): harden credentials.json to mode 0600 and its directory to 0700"
```

---

## After the tasks: mandatory audit + manual publish (outside the task loop)

**These are not subagent-driven-development tasks — no fresh implementer, no per-step review loop. They're sequential, mostly-manual steps the controller (or the user directly) performs after Task 2's review is clean and the whole-branch final review passes.**

1. **Run the `seguridad-seo` skill and resolve every finding it reports.** Per `CLAUDE.md`: no npm publish happens until this audit is clean. This step touched credential handling (Task 2), which is exactly the trigger condition for this skill.
2. **Full verification sweep** (same "hecho" bar as every other plan in this project):
   ```bash
   npx vitest run
   npx tsc -p core/tsconfig.json --noEmit
   npx tsc -p cli/tsconfig.json --noEmit
   npm run build
   ```
   All four must succeed.
3. **The user runs `npm login`** in their own terminal (browser OAuth flow) — this is not something to run on the user's behalf without them present, since it's an interactive account-authorization flow.
4. **Confirm with the user before each of the following**, one at a time — both are public, effectively-irreversible actions (same bar as a `git push` to `origin/main`):
   - `npm publish --workspace=core --access public` — must happen first, `cli` depends on `@agente-qa/core@0.1.0` existing in the registry.
   - `npm publish --workspace=cli --access public` — only after step above succeeds and `@agente-qa/core@0.1.0` is confirmed live on the registry (`npm view @agente-qa/core version`).
5. If either publish fails (name race, scope/org not authorized, or anything else), report the real npm error message to the user and stop — do not retry with a different name or force anything without asking.

This section intentionally has no task checkboxes or subagent dispatch — it's a short manual runbook for whoever closes out this plan.
