import { describe, it, expect } from "vitest";
import { applyProjectRoute } from "./applyProjectRoute.js";
import type { Pattern } from "../schemas/pattern.js";

const base: Pattern = {
  name: "login",
  description: "login",
  gherkinTemplate: "Feature: x\n",
  pageObjectTemplate: "",
  navigationHints: { routeCandidates: ["/login"], requiresLogin: true },
};

describe("applyProjectRoute", () => {
  it("prepends the configured route to the candidates", () => {
    const result = applyProjectRoute(base, { login: "/entrar" });
    expect(result?.navigationHints?.routeCandidates).toEqual(["/entrar", "/login"]);
  });

  it("returns the pattern untouched when it has no navigationHints", () => {
    const noHints: Pattern = { ...base, navigationHints: undefined };
    expect(applyProjectRoute(noHints, { login: "/entrar" })).toBe(noHints);
  });

  it("returns the pattern untouched when no route is configured", () => {
    expect(applyProjectRoute(base, {})).toBe(base);
  });

  it("returns null for a null pattern", () => {
    expect(applyProjectRoute(null, { login: "/entrar" })).toBeNull();
  });
});
