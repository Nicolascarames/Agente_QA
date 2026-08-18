import { describe, it, expect } from "vitest";
import { FakeCrawler } from "./testUtils.js";
import type { AppMap } from "./schema.js";

const map: AppMap = {
  schemaVersion: 2, appUrl: "https://example.test/", createdAt: "t",
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
