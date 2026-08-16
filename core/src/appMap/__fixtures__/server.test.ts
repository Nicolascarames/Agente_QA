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
      for (const route of ["/reset.html", "/dashboard.html", "/list.html", "/loop-a.html"]) {
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
