import { describe, it, expect, vi } from "vitest";
import { runMapCommand } from "./map.js";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    runExplorador: vi.fn(async (_opts: unknown) => ({ map: { stats: { screens: 2 } }, mapPath: "/tmp/map.json", writtenPaths: ["/tmp/pages/a.py"] })),
    loadConfig: vi.fn(async () => ({
      testsDir: "tests", appUrl: "https://example.test/",
      crawl: { maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [] },
    })),
    loadEnv: vi.fn(async () => ({ testUsername: "u", testPassword: "p" })),
    buildLlm: vi.fn(async () => ({ generate: vi.fn(async () => "") })),
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
