import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { generateCode } from "./codeGenerator.js";
import type { AppMap } from "../../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 2, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back"], probeValues: [], states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [],
  }],
};

const featureText = "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n";
const naming = { slug: "login", featureFileName: "login.feature" };

const scriptedResponse = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, given, when, then

scenarios("../features/login.feature")


@given("a")
def a():
    pass
`;

describe("generateCode", () => {
  it("parses the single # FILE: block into one file", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const files = await generateCode(featureText, llm, map, "login", naming);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("tests/test_login.py");
    expect(files[0].content).toContain("from pytest_bdd import scenarios");
  });

  it("builds its prompt via codeGenerationPrompt, passing the map, screen id, and naming through unchanged", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await generateCode(featureText, llm, map, "login", naming);

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain(featureText);
    expect(userMessage?.content).toContain("LoginPage");
    expect(userMessage?.content).toContain("features/login.feature");
    expect(userMessage?.content).toContain("test_login.py");
  });

  it("passes the retry's previous files and feedback through to the prompt", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    const previousFiles = [{ path: "tests/test_login.py", content: "broken code here\n" }];
    await generateCode(featureText, llm, map, "login", naming, {
      previousFiles,
      feedback: "SyntaxError: unexpected token",
    });

    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("SyntaxError: unexpected token");
    expect(userMessage?.content).toContain("broken code here");
  });

  it("throws a clear error when the response has no # FILE: blocks", async () => {
    const llm = new FakeLLMProvider(["esto no tiene el formato esperado"]);
    await expect(generateCode(featureText, llm, map, "login", naming)).rejects.toThrow(/# FILE:/);
  });

  it("throws a clear error when the response has more than one file block", async () => {
    const twoFileResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    const llm = new FakeLLMProvider([twoFileResponse]);
    await expect(generateCode(featureText, llm, map, "login", naming)).rejects.toThrow(/único esperado/);
  });

  it("throws a clear error when the generated file's path is not under tests/", async () => {
    const badPathResponse = `# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    const llm = new FakeLLMProvider([badPathResponse]);
    await expect(generateCode(featureText, llm, map, "login", naming)).rejects.toThrow(/tests\//);
  });

  it("propagates codeGenerationPrompt's error when the screen doesn't exist in the map", async () => {
    const llm = new FakeLLMProvider([scriptedResponse]);
    await expect(generateCode(featureText, llm, map, "ghost", naming)).rejects.toThrow(/ghost/);
  });
});
