import { describe, it, expect } from "vitest";
import { PatternSchema, NavigationHintsSchema } from "./pattern.js";

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
