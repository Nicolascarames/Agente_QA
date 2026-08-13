import { describe, it, expect } from "vitest";
import { PatternSchema } from "../../schemas/pattern.js";
import { loginPattern } from "./login.js";
import { logoutPattern } from "./logout.js";
import { signupPattern } from "./signup.js";
import { passwordResetPattern } from "./passwordReset.js";

describe("built-in patterns", () => {
  const patterns = [loginPattern, logoutPattern, signupPattern, passwordResetPattern];

  it("all conform to PatternSchema", () => {
    for (const pattern of patterns) {
      expect(() => PatternSchema.parse(pattern)).not.toThrow();
    }
  });

  it("all have unique names", () => {
    const names = patterns.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all Gherkin templates start with 'Feature:'", () => {
    for (const pattern of patterns) {
      expect(pattern.gherkinTemplate.trimStart().startsWith("Feature:")).toBe(true);
    }
  });

  it("all navigationHints have at least one route candidate", () => {
    for (const pattern of patterns) {
      expect(pattern.navigationHints).toBeDefined();
      expect(pattern.navigationHints?.routeCandidates.length).toBeGreaterThan(0);
    }
  });

  it("login and logout require a real login during exploration; signup and password-reset don't", () => {
    const byName = Object.fromEntries(patterns.map((p) => [p.name, p]));
    expect(byName.login.navigationHints?.requiresLogin).toBe(true);
    expect(byName.logout.navigationHints?.requiresLogin).toBe(true);
    expect(byName.signup.navigationHints?.requiresLogin).toBe(false);
    expect(byName["password-reset"].navigationHints?.requiresLogin).toBe(false);
  });
});
