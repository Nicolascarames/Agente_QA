export { slugify } from "./util/slugify.js";

export type { AgentId, EventStatus, AgentEvent, EmitEvent } from "./events/agentEvent.js";
export { noopEmit } from "./events/agentEvent.js";

export {
  ProjectConfigSchema,
  projectConfigPath,
  saveProjectConfig,
  loadProjectConfig,
  requireAppUrl,
  testEnvVars,
} from "./config/projectConfig.js";
export type { ProjectConfig } from "./config/projectConfig.js";

export {
  ProviderNameSchema,
  ProjectEnvSchema,
  projectEnvPath,
  ensureProjectEnvTemplate,
  loadProjectEnv,
  requireLlmConfig,
} from "./config/projectEnv.js";
export type { ProviderName, ProjectEnv, LlmCredentials } from "./config/projectEnv.js";

export {
  projectGitignorePath,
  readProjectGitignoreEntries,
  appendProjectGitignoreEntries,
} from "./config/projectGitignore.js";

export type { Message, LLMProvider } from "./llm/provider.js";
export { LLMResponseParseError, parseJsonResponse } from "./llm/parseJson.js";
export { LLMRequestError } from "./llm/errors.js";
export { FakeLLMProvider } from "./llm/testUtils.js";
export { createProvider } from "./llm/factory.js";

export { PatternSchema, NavigationHintsSchema } from "./schemas/pattern.js";
export type { Pattern, NavigationHints } from "./schemas/pattern.js";
export type { GherkinPlan } from "./schemas/gherkinPlan.js";

export {
  loadBuiltinPatterns,
  loadProjectPatterns,
  loadAllPatterns,
  saveProjectPattern,
} from "./patterns/registry.js";
export { matchPattern } from "./patterns/matcher.js";

export { checkAmbiguity } from "./agents/intake/ambiguityChecker.js";
export { generateGherkin } from "./agents/intake/gherkinGenerator.js";
export { writeFeatureFile } from "./agents/intake/writeFeatureFile.js";
export { runIntake } from "./agents/intake/runIntake.js";
export type { IntakeCallbacks, RunIntakeOptions } from "./agents/intake/runIntake.js";

export { parseFeatureHeader } from "./agents/generador/parseFeatureHeader.js";
export { generateCode } from "./agents/generador/codeGenerator.js";
export type { GeneratedFile } from "./agents/generador/codeGenerator.js";
export type { CodeGenerationEvidence } from "./prompts/generador.js";
export { writeTestFiles, testFileExists, testFilePath } from "./agents/generador/writeTestFiles.js";
export { listFeatureFiles } from "./agents/generador/listFeatureFiles.js";
export { runGenerador } from "./agents/generador/runGenerador.js";
export type { GeneratorCallbacks, RunGeneradorOptions } from "./agents/generador/runGenerador.js";

export type {
  ScreenEvidence,
  ExplorationInput,
  ExplorationResult,
  ExplorationCredentials,
  ExplorationStepCallback,
  SiteExplorer,
} from "./siteExplorer/siteExplorer.js";
export { FakeSiteExplorer } from "./siteExplorer/testUtils.js";
export { createRealSiteExplorer, MissingExplorerToolError } from "./siteExplorer/realSiteExplorer.js";

export type { CodeFile, CodeCheckResult, CodeChecker } from "./codeCheck/codeChecker.js";
export { FakeCodeChecker } from "./codeCheck/testUtils.js";
export { createRealCodeChecker, realCodeChecker, MissingCodeToolError } from "./codeCheck/realCodeChecker.js";

export type { LocatorCheck, LocatorVerificationResult, LocatorVerifier } from "./locatorVerify/locatorVerifier.js";
export { FakeLocatorVerifier } from "./locatorVerify/testUtils.js";
export { extractLocatorChecks } from "./locatorVerify/extractLocatorChecks.js";
export type { LocatorExtractionResult } from "./locatorVerify/extractLocatorChecks.js";
export { buildVerificationScript } from "./locatorVerify/buildVerificationScript.js";
export {
  createRealLocatorVerifier,
  realLocatorVerifier,
  MissingLocatorVerifierToolError,
} from "./locatorVerify/realLocatorVerifier.js";

export { listAvailableTags } from "./agents/ejecutor/listAvailableTags.js";
export { runEjecutor } from "./agents/ejecutor/runEjecutor.js";
export type { ExecutorCallbacks, EjecutorResult, CaptureMode } from "./agents/ejecutor/runEjecutor.js";

export type { TestRunOptions, TestRunResult, TestRunner } from "./testRun/testRunner.js";
export { FakeTestRunner } from "./testRun/testUtils.js";
export { createRealTestRunner, realTestRunner, MissingTestToolError } from "./testRun/realTestRunner.js";

export { parseJunitResults } from "./agents/reportes/parseJunitResults.js";
export type { JunitResults, JunitTestCase } from "./agents/reportes/parseJunitResults.js";
export { generateSummaryMarkdown } from "./agents/reportes/generateSummaryMarkdown.js";
export { runReportes } from "./agents/reportes/runReportes.js";
export type { ReportesCallbacks, ReportesResult } from "./agents/reportes/runReportes.js";

export { AppMapSchema, OverridesFileSchema } from "./appMap/schema.js";
export type {
  AppMap, Screen, LocatorEntry, ScreenState, Transition, WriteAction,
  AmbiguousCandidate, ScenarioCandidate, OverridesFile, LocatorOverride,
} from "./appMap/schema.js";

export { appMapDir, appMapPath, saveAppMap, loadAppMap } from "./appMap/mapStore.js";

export { overridesPath, loadOverrides, saveOverride, applyOverrides } from "./appMap/overrides.js";

export type {
  CrawlCredentials, CrawlLimits, CrawlCallbacks, CrawlInput, CrawlResult, Crawler,
} from "./appMap/crawler.js";
export { MissingCrawlerToolError } from "./appMap/crawler.js";
export { FakeCrawler } from "./appMap/testUtils.js";

export { runExplorador } from "./agents/explorador/runExplorador.js";
export type { ExploradorCallbacks, RunExploradorOptions, ExploradorResult } from "./agents/explorador/runExplorador.js";
export { generateScenarioCandidates } from "./agents/explorador/scenarioCandidates.js";
export { createRealCrawler } from "./appMap/realCrawler.js";
export { emitPageObject } from "./appMap/pageObjectEmitter.js";
export { redactMap, redactText, REDACTED } from "./appMap/redact.js";
