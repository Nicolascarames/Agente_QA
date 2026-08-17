import { describe, it, expect } from "vitest";
import { PatternSchema } from "./pattern.js";

describe("PatternSchema", () => {
  it("accepts a pattern with name, description and gherkinTemplate", () => {
    const result = PatternSchema.safeParse({
      name: "checkout",
      description: "Flujo de compra",
      gherkinTemplate: "Feature: Checkout\n",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a pattern missing gherkinTemplate", () => {
    const result = PatternSchema.safeParse({
      name: "checkout",
      description: "Flujo de compra",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an object carrying the retired pageObjectTemplate field", () => {
    const result = PatternSchema.safeParse({
      name: "checkout",
      description: "Flujo de compra",
      gherkinTemplate: "Feature: Checkout\n",
      pageObjectTemplate: "class CheckoutPage:\n    pass\n",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an object carrying the retired navigationHints field", () => {
    const result = PatternSchema.safeParse({
      name: "login",
      description: "Login",
      gherkinTemplate: "Feature: Login\n",
      navigationHints: { routeCandidates: ["/login", "/"], requiresLogin: true },
    });
    expect(result.success).toBe(false);
  });
});
