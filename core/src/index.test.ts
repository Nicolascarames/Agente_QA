import { describe, it, expect } from "vitest";
import * as core from "./index.js";

describe("@agente-qa/core public API", () => {
  it("exports the config functions", () => {
    expect(typeof core.saveProjectConfig).toBe("function");
    expect(typeof core.loadProjectConfig).toBe("function");
    expect(typeof core.ensureProjectEnvTemplate).toBe("function");
    expect(typeof core.loadProjectEnv).toBe("function");
    expect(typeof core.requireLlmConfig).toBe("function");
    expect(typeof core.requireAppUrl).toBe("function");
    expect(typeof core.testEnvVars).toBe("function");
    expect(typeof core.projectEnvPath).toBe("function");
  });

  it("exports the project gitignore functions", () => {
    expect(typeof core.projectGitignorePath).toBe("function");
    expect(typeof core.readProjectGitignoreEntries).toBe("function");
    expect(typeof core.appendProjectGitignoreEntries).toBe("function");
  });

  it("exports the LLM provider factory and fake test double", () => {
    expect(typeof core.createProvider).toBe("function");
    expect(typeof core.FakeLLMProvider).toBe("function");
  });

  it("exports LLMRequestError", () => {
    expect(typeof core.LLMRequestError).toBe("function");
  });

  it("exports the pattern registry", () => {
    expect(typeof core.loadAllPatterns).toBe("function");
    expect(typeof core.saveProjectPattern).toBe("function");
  });

  it("exports the intake orchestrator", () => {
    expect(typeof core.runIntake).toBe("function");
  });

  it("exports the Agente 3 (generador) surface", () => {
    expect(typeof core.parseFeatureHeader).toBe("function");
    expect(typeof core.generateCode).toBe("function");
    expect(typeof core.writeTestFiles).toBe("function");
    expect(typeof core.testFileExists).toBe("function");
    expect(typeof core.testFilePath).toBe("function");
    expect(typeof core.listFeatureFiles).toBe("function");
    expect(typeof core.runGenerador).toBe("function");
    expect(typeof core.FakeCodeChecker).toBe("function");
    expect(typeof core.createRealCodeChecker).toBe("function");
    expect(typeof core.realCodeChecker.check).toBe("function");
    expect(typeof core.MissingCodeToolError).toBe("function");
  });

  it("PatternSchema rejects an object carrying navigationHints", () => {
    // Includes every field the OLD schema required (pageObjectTemplate) so the
    // only reason this can fail is the presence of navigationHints itself —
    // not an unrelated missing-field error that would reject it for free.
    const result = core.PatternSchema.safeParse({
      name: "login",
      description: "Login",
      gherkinTemplate: "Feature: Login\n",
      pageObjectTemplate: "class LoginPage:\n    pass\n",
      navigationHints: { routeCandidates: ["/login"], requiresLogin: true },
    });
    expect(result.success).toBe(false);
  });

  it("no longer exports FakeSiteExplorer", () => {
    expect((core as Record<string, unknown>).FakeSiteExplorer).toBeUndefined();
  });

  it("no longer exports createRealSiteExplorer", () => {
    expect((core as Record<string, unknown>).createRealSiteExplorer).toBeUndefined();
  });

  it("no longer exports extractLocatorChecks", () => {
    expect((core as Record<string, unknown>).extractLocatorChecks).toBeUndefined();
  });

  it("no longer exports checkExpectedLiterals", () => {
    expect((core as Record<string, unknown>).checkExpectedLiterals).toBeUndefined();
  });

  it("exports the Agente 4 (ejecutor) surface", () => {
    expect(typeof core.listAvailableTags).toBe("function");
    expect(typeof core.runEjecutor).toBe("function");
    expect(typeof core.FakeTestRunner).toBe("function");
    expect(typeof core.createRealTestRunner).toBe("function");
    expect(typeof core.realTestRunner.run).toBe("function");
    expect(typeof core.MissingTestToolError).toBe("function");
  });

  it("exports the Agente 5 (reportes) surface", () => {
    expect(typeof core.parseJunitResults).toBe("function");
    expect(typeof core.generateSummaryMarkdown).toBe("function");
    expect(typeof core.runReportes).toBe("function");
  });

  it("exports the locator verification surface", () => {
    expect(typeof core.FakeLocatorVerifier).toBe("function");
    expect(typeof core.buildVerificationScript).toBe("function");
    expect(typeof core.createRealLocatorVerifier).toBe("function");
    expect(typeof core.realLocatorVerifier.verify).toBe("function");
    expect(typeof core.MissingLocatorVerifierToolError).toBe("function");
  });
});
