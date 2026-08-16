import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateGherkin } from "./gherkinGenerator.js";
import type { AppMap, Screen } from "../../appMap/schema.js";

const loginScreen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: ["Welcome back", "Email"], probeValues: [], locators: [],
  ambiguous: [], transitions: [], writeActions: [],
  states: [{
    id: "invalid",
    reachedBy: { action: "submit", locator: "submit_button", data: "invalid" },
    addsTexts: ["Authentication failed. Please try again."],
  }],
};

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://app.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
  screens: [loginScreen],
};

const respond = (featureText: string, fileName = "login.feature"): string =>
  JSON.stringify({ fileName, featureText });

describe("generateGherkin", () => {
  it("returns the fileName and featureText the model reports", async () => {
    const llm = new FakeLLMProvider([
      respond("Feature: Login con credenciales válidas\n  Scenario: x\n    Given a\n    When b\n    Then c\n", "login-con-credenciales-validas.feature"),
    ]);
    const plan = await generateGherkin("probar login", llm, map, "login");
    expect(plan.fileName).toBe("login-con-credenciales-validas.feature");
    expect(plan.featureText).toContain("Feature: Login con credenciales válidas");
  });

  it("strips markdown code fences around the JSON response", async () => {
    const llm = new FakeLLMProvider([
      "```json\n" + respond("Feature: Checkout\n  Scenario: x\n    Given a\n") + "\n```",
    ]);
    const plan = await generateGherkin("probar checkout", llm, map, "login");
    expect(plan.featureText.startsWith("Feature: Checkout")).toBe(true);
  });

  it("rejects a response whose featureText has no 'Feature:' line at all", async () => {
    const llm = new FakeLLMProvider([respond("contenido sin cabecera Feature")]);
    await expect(generateGherkin("texto raro", llm, map, "login")).rejects.toThrow(
      /no parece un archivo Gherkin válido/
    );
  });

  it("rejects a response that is not valid JSON", async () => {
    const llm = new FakeLLMProvider(["Feature: Login\n  Scenario: x\n    Given a\n"]);
    await expect(generateGherkin("probar login", llm, map, "login")).rejects.toThrow(
      /no es JSON válido/
    );
  });

  it("accepts a featureText that starts with Gherkin tags before the Feature: line", async () => {
    const llm = new FakeLLMProvider([
      respond("@screen:login\nFeature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n"),
    ]);
    const plan = await generateGherkin("probar login", llm, map, "login");
    expect(plan.featureText.startsWith("@screen:login")).toBe(true);
  });

  it("throws when the screen named by screenId does not exist in the map", async () => {
    const llm = new FakeLLMProvider([respond("Feature: Login\n  Scenario: x\n    Given a\n")]);
    await expect(generateGherkin("probar login", llm, map, "ghost-screen")).rejects.toThrow(
      /no existe en el mapa/
    );
  });

  it("passes the screen's real texts into the prompt, forbidding invented literals", async () => {
    const llm = new FakeLLMProvider([respond("Feature: Login\n  Scenario: x\n    Given y\n")]);
    await generateGherkin("quiero probar el login", llm, map, "login");
    const prompt = llm.lastPrompt();
    expect(prompt).toContain("Welcome back");
    expect(prompt).toContain("Authentication failed. Please try again.");
    expect(prompt).toContain("ÚNICOS textos que existen de verdad");
  });

  it("tells the model to write the Gherkin in English regardless of the app's own language", async () => {
    const llm = new FakeLLMProvider([respond("Feature: Login\n  Scenario: x\n    Given y\n")]);
    await generateGherkin("quiero probar el login", llm, map, "login");
    expect(llm.lastPrompt()).toContain("INGLÉS");
  });

  it("tags every scenario request with the declared screen id", async () => {
    const llm = new FakeLLMProvider([respond("Feature: Login\n  Scenario: x\n    Given y\n")]);
    await generateGherkin("quiero probar el login", llm, map, "login");
    expect(llm.lastPrompt()).toContain("@screen:login");
  });
});
