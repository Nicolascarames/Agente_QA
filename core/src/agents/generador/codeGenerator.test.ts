import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateCode } from "./codeGenerator.js";
import type { Pattern } from "../../schemas/pattern.js";

const featureText = "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n";
const naming = { slug: "login", featureFileName: "login.feature" };

const scriptedResponse = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, given, when, then

scenarios("../features/login.feature")


@given("a")
def a():
    pass
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page
`;

describe("generateCode", () => {
  it("parses the two # FILE: blocks into separate files", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const files = await generateCode(featureText, llm, null, naming, [], "es", {});

    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("tests/test_login.py");
    expect(files[0].content).toContain("from pytest_bdd import scenarios");
    expect(files[1].path).toBe("pages/login_page.py");
    expect(files[1].content).toContain("class LoginPage");
  });

  it("sends the feature text, pattern skeleton, and exact naming to the model when a pattern matched", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const matchedPattern: Pattern = {
      name: "login",
      description: "Inicio de sesión",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "class LoginPage:\n    pass\n",
    };
    await generateCode(featureText, llm, matchedPattern, naming, [], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain(featureText);
    expect(userMessage?.content).toContain("class LoginPage:\n    pass");
    expect(userMessage?.content).toContain("features/login.feature");
    expect(userMessage?.content).toContain("test_login.py");
    expect(userMessage?.content).toContain("login_page.py");
  });

  it("instructs the model to read the app URL and test credentials from environment variables, never literal values", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("AGENTE_QA_APP_URL");
    expect(userMessage?.content).toContain("AGENTE_QA_TEST_USERNAME");
    expect(userMessage?.content).toContain("AGENTE_QA_TEST_PASSWORD");
  });

  it("instructs the model to avoid ambiguous .or_() locator combinators", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain(".or_()");
    expect(userMessage?.content).toContain("get_by_test_id");
  });

  it("includes real captured evidence in the prompt when the explorer found any", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [
      { stepText: "pantalla de login", url: "https://example.com/login", ariaSnapshot: 'textbox "Email"' },
    ], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("https://example.com/login");
    expect(userMessage?.content).toContain('textbox "Email"');
  });

  it("tells the model no real evidence was captured when the list is empty", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("No se pudo capturar evidencia real");
  });

  it("includes the previous attempt's code and the retry feedback in the prompt when provided", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const previousFiles = [
      { path: "tests/test_login.py", content: "broken code here\n" },
      { path: "pages/login_page.py", content: "class LoginPage:\n    pass\n" },
    ];
    await generateCode(featureText, llm, null, naming, [], "es", {}, {
      previousFiles,
      feedback: "SyntaxError: unexpected token",
    });

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("SyntaxError: unexpected token");
    expect(userMessage?.content).toContain("broken code here");
  });

  it("throws a clear error when the response has no # FILE: blocks", async () => {
    const llm = new FakeLLMProvider(["esto no tiene el formato esperado"]);
    await expect(generateCode(featureText, llm, null, naming, [], "es", {})).rejects.toThrow(/# FILE:/);
  });

  it("throws a clear error when the response has the wrong number of file blocks", async () => {
    const threeFileResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
# FILE: conftest.py
import pytest
`;
    const llm = new FakeLLMProvider([threeFileResponse]);
    await expect(generateCode(featureText, llm, null, naming, [], "es", {})).rejects.toThrow(/2 esperados/);
  });

  it("tells the model the app interface is in English when appLanguage is \"en\"", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "en", {});
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("inglés");
  });

  it("tells the model the app interface is in Spanish by default", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("español");
  });

  it("includes the project's known home route when routes.home is provided", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", { home: "/dashboard" });
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("/dashboard");
  });

  it("omits the home route section entirely when routes.home isn't provided", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).not.toContain("página principal de la aplicación");
  });

  it("instructs the model to split a parametrized locator's construction (get_*) from acting on it", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("get_<algo>");
    expect(userMessage?.content).toContain("click_button");
  });

  it("instructs the model to pass the step's parsers.parse value unmodified to the paired method", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, naming, [], "es", {});

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("SIN transformar");
  });

  it("instructs the model to use parsers.re for quoted step parameters", async () => {
    const llm = new FakeLLMProvider([
      "# FILE: tests/test_x.py\nprint(1)\n# FILE: pages/x_page.py\nprint(2)\n",
    ]);
    await generateCode(
      "Feature: X\n",
      llm,
      null,
      { slug: "x", featureFileName: "x.feature" },
      [],
      "es",
      {}
    );
    const prompt = llm.lastPrompt();
    expect(prompt).toContain("parsers.re");
    expect(prompt).toContain("(?P<");
    expect(prompt).toContain("[^\"]*");
  });
});
