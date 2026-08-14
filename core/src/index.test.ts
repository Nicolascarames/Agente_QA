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

  it("exports the Agente 2 (generador) surface", () => {
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

  it("exports the schema's navigation hints", () => {
    expect(typeof core.NavigationHintsSchema.parse).toBe("function");
  });

  it("exports the site explorer surface", () => {
    expect(typeof core.FakeSiteExplorer).toBe("function");
    expect(typeof core.createRealSiteExplorer).toBe("function");
    expect(typeof core.MissingExplorerToolError).toBe("function");
  });

  it("exports the Agente 3 (ejecutor) surface", () => {
    expect(typeof core.listAvailableTags).toBe("function");
    expect(typeof core.runEjecutor).toBe("function");
    expect(typeof core.FakeTestRunner).toBe("function");
    expect(typeof core.createRealTestRunner).toBe("function");
    expect(typeof core.realTestRunner.run).toBe("function");
    expect(typeof core.MissingTestToolError).toBe("function");
  });

  it("exports the Agente 4 (reportes) surface", () => {
    expect(typeof core.parseJunitResults).toBe("function");
    expect(typeof core.generateSummaryMarkdown).toBe("function");
    expect(typeof core.runReportes).toBe("function");
  });

  it("exports the locator verification surface", () => {
    expect(typeof core.FakeLocatorVerifier).toBe("function");
    expect(typeof core.extractLocatorChecks).toBe("function");
    expect(typeof core.buildVerificationScript).toBe("function");
    expect(typeof core.createRealLocatorVerifier).toBe("function");
    expect(typeof core.realLocatorVerifier.verify).toBe("function");
    expect(typeof core.MissingLocatorVerifierToolError).toBe("function");
  });
});
