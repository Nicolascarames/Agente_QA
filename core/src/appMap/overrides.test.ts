import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOverrides, saveOverride, applyOverrides, overridesPath } from "./overrides.js";
import type { AppMap } from "./schema.js";

const map: AppMap = {
  schemaVersion: 2, appUrl: "https://example.test/", createdAt: "t",
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

  it("rejects malformed JSON with a clear message instead of a raw SyntaxError", async () => {
    await fs.mkdir(path.dirname(overridesPath(projectRoot)), { recursive: true });
    await fs.writeFile(overridesPath(projectRoot), "{ not json", "utf-8");
    await expect(loadOverrides(projectRoot)).rejects.toThrow(/overrides\.json/);
  });

  it("returns a fresh object on every call instead of a shared singleton", async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-ovr-"));
    try {
      const a = await loadOverrides(projectRoot);
      const b = await loadOverrides(otherRoot);
      expect(a).not.toBe(b);
      expect(a.locators).not.toBe(b.locators);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
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

  it("deep-clones the map so mutating nested arrays on the result doesn't affect the original", () => {
    const { map: patched } = applyOverrides(map, { schemaVersion: 1, locators: [] });
    patched.screens[0].texts.push("x");
    expect(map.screens[0].texts).toEqual([]);
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
