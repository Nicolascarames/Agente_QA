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
