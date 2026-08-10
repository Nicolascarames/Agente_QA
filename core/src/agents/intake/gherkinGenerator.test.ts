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

  it("rejects a response with no 'Feature:' line at all as invalid Gherkin", async () => {
    const llm = new FakeLLMProvider(["contenido sin cabecera Feature"]);
    await expect(generateGherkin("texto raro", llm, null)).rejects.toThrow(
      /no parece un archivo Gherkin válido/
    );
  });

  it("rejects a response where the model prepends prose before the fenced Gherkin block", async () => {
    // Reproduction: stripCodeFences only strips a fence at position 0, so prose
    // before "```gherkin" leaves the prose in featureText and it would otherwise
    // get written to disk as-is.
    const llm = new FakeLLMProvider([
      "Aquí tienes el plan:\n\n```gherkin\nFeature: Login\n  Scenario: x\n    Given a\n```",
    ]);
    await expect(generateGherkin("probar login", llm, null)).rejects.toThrow(
      /no parece un archivo Gherkin válido/
    );
  });

  it("accepts a response that starts with Gherkin tags before the Feature: line", async () => {
    const llm = new FakeLLMProvider([
      "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const plan = await generateGherkin("probar login", llm, null);
    expect(plan.featureText.startsWith("@smoke")).toBe(true);
    expect(plan.fileName).toBe("login.feature");
  });
});
