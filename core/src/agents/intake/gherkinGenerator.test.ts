import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateGherkin } from "./gherkinGenerator.js";

describe("generateGherkin", () => {
  it("derives the file name by slugifying the Feature title", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login con credenciales válidas\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const plan = await generateGherkin("probar login", llm, null);
    expect(plan.fileName).toBe("login-con-credenciales-validas.feature");
    expect(plan.featureText).toContain("Feature: Login con credenciales válidas");
  });

  it("strips markdown code fences from the model response", async () => {
    const llm = new FakeLLMProvider([
      "```gherkin\nFeature: Checkout\n  Scenario: x\n    Given a\n```",
    ]);
    const plan = await generateGherkin("probar checkout", llm, null);
    expect(plan.featureText.startsWith("Feature: Checkout")).toBe(true);
    expect(plan.featureText).not.toContain("```");
  });

  it("falls back to a generic file name when no Feature title is found", async () => {
    const llm = new FakeLLMProvider(["contenido sin cabecera Feature"]);
    const plan = await generateGherkin("texto raro", llm, null);
    expect(plan.fileName).toBe("plan-de-pruebas.feature");
  });
});
