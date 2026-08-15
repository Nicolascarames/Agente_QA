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

  it("key generation changes when patternName differs", () => {
    const base = evidenceCacheKey({ appUrl: "https://a.test/", patternName: "login", routes: { home: "/" } });
    const different = evidenceCacheKey({ appUrl: "https://a.test/", patternName: "signup", routes: { home: "/" } });
    expect(base).not.toBe(different);
  });

  it("key generation changes when routes differ", () => {
    const base = evidenceCacheKey({ appUrl: "https://a.test/", patternName: "login", routes: { home: "/" } });
    const different = evidenceCacheKey({ appUrl: "https://a.test/", patternName: "login", routes: { home: "/", about: "/about" } });
    expect(base).not.toBe(different);
  });
});

describe("evidence cache round-trip", () => {
  const testKey = "0123456789abcdef";

  it("returns null when nothing was cached", async () => {
    expect(await readCachedEvidence(tmpProject, testKey)).toBeNull();
  });

  it("reads back what it wrote", async () => {
    const now = new Date("2026-08-15T10:00:00Z");
    await writeCachedEvidence(tmpProject, testKey, screens, now);
    expect(await readCachedEvidence(tmpProject, testKey, now)).toEqual(screens);
  });

  it("ignores entries older than the TTL", async () => {
    const written = new Date("2026-08-15T10:00:00Z");
    const later = new Date(written.getTime() + EVIDENCE_CACHE_TTL_MS + 1);
    await writeCachedEvidence(tmpProject, testKey, screens, written);
    expect(await readCachedEvidence(tmpProject, testKey, later)).toBeNull();
  });

  it("writes inside .agente-qa/cache and gitignores the whole folder", async () => {
    await writeCachedEvidence(tmpProject, testKey, screens);
    const dir = path.join(tmpProject, ".agente-qa", "cache");
    const entries = await fs.readdir(dir);
    expect(entries).toContain(`exploration-${testKey}.json`);
    // self-contained: a project initialised before this feature existed never
    // re-runs `init`, so the ignore rule cannot live in .agente-qa/.gitignore
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf-8")).toBe("*\n");
  });

  it("returns null on a corrupted cache file instead of throwing", async () => {
    const dir = path.join(tmpProject, ".agente-qa", "cache");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `exploration-${testKey}.json`), "{not json", "utf-8");
    expect(await readCachedEvidence(tmpProject, testKey)).toBeNull();
  });

  it("returns null when cache file contains null instead of throwing", async () => {
    const dir = path.join(tmpProject, ".agente-qa", "cache");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `exploration-${testKey}.json`), "null", "utf-8");
    expect(await readCachedEvidence(tmpProject, testKey)).toBeNull();
  });

  it("returns null when cache file has non-array screens field", async () => {
    const dir = path.join(tmpProject, ".agente-qa", "cache");
    await fs.mkdir(dir, { recursive: true });
    const badPayload = { capturedAt: new Date().toISOString(), screens: "not an array" };
    await fs.writeFile(path.join(dir, `exploration-${testKey}.json`), JSON.stringify(badPayload), "utf-8");
    expect(await readCachedEvidence(tmpProject, testKey)).toBeNull();
  });
});
