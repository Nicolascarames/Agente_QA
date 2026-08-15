import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateGherkin } from "./gherkinGenerator.js";

describe("generateGherkin", () => {
  it("derives the file name by slugifying the Feature title", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login con credenciales válidas\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const plan = await generateGherkin("probar login", llm, null, "es", []);
    expect(plan.fileName).toBe("login-con-credenciales-validas.feature");
    expect(plan.featureText).toContain("Feature: Login con credenciales válidas");
  });

  it("strips markdown code fences from the model response", async () => {
    const llm = new FakeLLMProvider([
      "```gherkin\nFeature: Checkout\n  Scenario: x\n    Given a\n```",
    ]);
    const plan = await generateGherkin("probar checkout", llm, null, "es", []);
    expect(plan.featureText.startsWith("Feature: Checkout")).toBe(true);
    expect(plan.featureText).not.toContain("```");
  });

  it("rejects a response with no 'Feature:' line at all as invalid Gherkin", async () => {
    const llm = new FakeLLMProvider(["contenido sin cabecera Feature"]);
    await expect(generateGherkin("texto raro", llm, null, "es", [])).rejects.toThrow(
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
    await expect(generateGherkin("probar login", llm, null, "es", [])).rejects.toThrow(
      /no parece un archivo Gherkin válido/
    );
  });

  it("accepts a response that starts with Gherkin tags before the Feature: line", async () => {
    const llm = new FakeLLMProvider([
      "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const plan = await generateGherkin("probar login", llm, null, "es", []);
    expect(plan.featureText.startsWith("@smoke")).toBe(true);
    expect(plan.fileName).toBe("login.feature");
  });

  it("sets matchedPatternName to the matched pattern's name", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const matchedPattern = {
      name: "login",
      description: "Inicio de sesión",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "",
    };
    const plan = await generateGherkin("probar login", llm, matchedPattern, "es", []);
    expect(plan.matchedPatternName).toBe("login");
  });

  it("sets matchedPatternName to null when no pattern matched", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Checkout\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const plan = await generateGherkin("probar checkout", llm, null, "es", []);
    expect(plan.matchedPatternName).toBeNull();
  });

  it("tells the model the app interface is in English when appLanguage is \"en\"", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    await generateGherkin("probar login", llm, null, "en", []);
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("inglés");
  });

  it("tells the model the app interface is in Spanish when appLanguage is \"es\"", async () => {
    const llm = new FakeLLMProvider([
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    await generateGherkin("probar login", llm, null, "es", []);
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("español");
  });

  it("passes the captured screens into the prompt and forbids inventing literals", async () => {
    const llm = new FakeLLMProvider(["Feature: Login\n  Scenario: x\n    Given y\n"]);
    await generateGherkin("quiero probar el login", llm, null, "es", [
      {
        stepText: "pantalla en /login",
        url: "https://app.test/login",
        ariaSnapshot: '- heading "Welcome back" [level=1]\n- text: Authentication failed. Please try again.',
      },
    ]);
    const prompt = llm.lastPrompt();
    expect(prompt).toContain("Authentication failed. Please try again.");
    expect(prompt).toContain("https://app.test/login");
    expect(prompt).toContain("no lo inventes");
  });

  it("says so explicitly when there is no evidence", async () => {
    const llm = new FakeLLMProvider(["Feature: Login\n  Scenario: x\n    Given y\n"]);
    await generateGherkin("quiero probar el login", llm, null, "es", []);
    expect(llm.lastPrompt()).toContain("No se pudo capturar evidencia");
  });
});
