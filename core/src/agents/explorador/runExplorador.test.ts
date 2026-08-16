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

  it("leaves a declined Page Object untouched, reports it as skipped, and still saves the map", async () => {
    const target = path.join(projectRoot, "tests", "pages", "login_page.py");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "# hand-edited, do not overwrite\n", "utf-8");

    const events: string[] = [];
    const result = await runExplorador(options({
      callbacks: { ...options().callbacks, confirmOverwrite: async () => false },
      emit: (event) => events.push(`${event.status}:${event.message}`),
    }));

    const content = await fs.readFile(target, "utf-8");
    expect(content).toBe("# hand-edited, do not overwrite\n");
    expect(result.skippedPaths).toContain(target);
    expect(result.writtenPaths).not.toContain(target);
    expect(events.some((e) => e.startsWith("warn:") && e.includes(target))).toBe(true);
    await expect(loadAppMap(projectRoot)).resolves.not.toBeNull();
  });
});
