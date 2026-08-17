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
});
