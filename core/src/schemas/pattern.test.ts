import { describe, it, expect } from "vitest";
import { PatternSchema, NavigationHintsSchema } from "./pattern.js";
import { loginPattern } from "../patterns/builtin/login.js";

describe("PatternSchema", () => {
  it("accepts a pattern without navigationHints (backward compatible with patterns saved before this field existed)", () => {
    const result = PatternSchema.safeParse({
      name: "checkout",
      description: "Flujo de compra",
      gherkinTemplate: "Feature: Checkout\n",
      pageObjectTemplate: "class CheckoutPage:\n    pass\n",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a pattern with navigationHints", () => {
    const result = PatternSchema.safeParse({
      name: "login",
      description: "Login",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "class LoginPage:\n    pass\n",
      navigationHints: { routeCandidates: ["/login", "/"], requiresLogin: true },
    });
    expect(result.success).toBe(true);
  });

  it("rejects navigationHints with an empty routeCandidates array", () => {
    const result = NavigationHintsSchema.safeParse({ routeCandidates: [], requiresLogin: false });
    expect(result.success).toBe(false);
  });
});

describe("PatternSchema navigationHints.negativeProbe", () => {
  it("accepts a pattern without negativeProbe (backwards compatible)", () => {
    const parsed = PatternSchema.parse({
      name: "x",
      description: "x",
      gherkinTemplate: "Feature: x\n",
      pageObjectTemplate: "",
      navigationHints: { routeCandidates: ["/"], requiresLogin: false },
    });
    expect(parsed.navigationHints?.negativeProbe).toBeUndefined();
  });

  it("accepts the invalid-credentials probe", () => {
    const parsed = PatternSchema.parse({
      name: "x",
      description: "x",
      gherkinTemplate: "Feature: x\n",
      pageObjectTemplate: "",
      navigationHints: {
        routeCandidates: ["/"],
        requiresLogin: true,
        negativeProbe: { kind: "invalid-credentials" },
      },
    });
    expect(parsed.navigationHints?.negativeProbe?.kind).toBe("invalid-credentials");
  });

  it("declares the probe on the builtin login pattern", () => {
    expect(loginPattern.navigationHints?.negativeProbe?.kind).toBe("invalid-credentials");
  });
});
