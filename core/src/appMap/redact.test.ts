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
