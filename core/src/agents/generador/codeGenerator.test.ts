import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateCode } from "./codeGenerator.js";
import type { Pattern } from "../../schemas/pattern.js";

const featureText = "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n";

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
# FILE: conftest.py
import pytest


@pytest.fixture
def page():
    pass
`;

describe("generateCode", () => {
  it("parses the three # FILE: blocks into separate files", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const files = await generateCode(featureText, llm, null);

    expect(files).toHaveLength(3);
    expect(files[0].path).toBe("tests/test_login.py");
    expect(files[0].content).toContain("from pytest_bdd import scenarios");
    expect(files[1].path).toBe("pages/login_page.py");
    expect(files[1].content).toContain("class LoginPage");
    expect(files[2].path).toBe("conftest.py");
    expect(files[2].content).toContain("import pytest");
  });

  it("sends the feature text and pattern skeleton to the model when a pattern matched", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const matchedPattern: Pattern = {
      name: "login",
      description: "Inicio de sesión",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "class LoginPage:\n    pass\n",
    };
    await generateCode(featureText, llm, matchedPattern);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain(featureText);
    expect(userMessage?.content).toContain("class LoginPage:\n    pass");
  });

  it("includes retry feedback in the prompt when provided", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, null, "SyntaxError: unexpected token");

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("SyntaxError: unexpected token");
  });

  it("throws a clear error when the response has no # FILE: blocks", async () => {
    const llm = new FakeLLMProvider(["esto no tiene el formato esperado"]);
    await expect(generateCode(featureText, llm, null)).rejects.toThrow(/# FILE:/);
  });

  it("throws a clear error when the response has the wrong number of file blocks", async () => {
    const twoFileResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    const llm = new FakeLLMProvider([twoFileResponse]);
    await expect(generateCode(featureText, llm, null)).rejects.toThrow(/3 esperados/);
  });
});
