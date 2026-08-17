import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../llm/testUtils.js";
import { matchPattern } from "./matcher.js";
import type { Pattern } from "../schemas/pattern.js";

const patterns: Pattern[] = [
  { name: "login", description: "Inicio de sesión", gherkinTemplate: "Feature: x\n" },
  { name: "signup", description: "Registro", gherkinTemplate: "Feature: y\n" },
];

describe("matchPattern", () => {
  it("returns the matched pattern when the model names one", async () => {
    const llm = new FakeLLMProvider(['{"matchedPatternName": "login"}']);
    const result = await matchPattern("Quiero probar que se puede iniciar sesión", patterns, llm);
    expect(result?.name).toBe("login");
  });

  it("returns null when the model says no pattern matches", async () => {
    const llm = new FakeLLMProvider(['{"matchedPatternName": null}']);
    const result = await matchPattern("Quiero probar el carrito de la compra", patterns, llm);
    expect(result).toBeNull();
  });

  it("returns null without calling the model when there are no patterns", async () => {
    const llm = new FakeLLMProvider([]);
    const result = await matchPattern("cualquier cosa", [], llm);
    expect(result).toBeNull();
    expect(llm.receivedCalls).toHaveLength(0);
  });
});
