export { slugify } from "./util/slugify.js";

export {
  ProjectConfigSchema,
  projectConfigPath,
  saveProjectConfig,
  loadProjectConfig,
} from "./config/projectConfig.js";
export type { ProjectConfig } from "./config/projectConfig.js";

export {
  ProviderNameSchema,
  ProjectEnvSchema,
  projectEnvPath,
  ensureProjectEnvTemplate,
  loadProjectEnv,
  requireLlmConfig,
  requireAppUrl,
  testEnvVars,
} from "./config/projectEnv.js";
export type { ProviderName, ProjectEnv, LlmCredentials } from "./config/projectEnv.js";

export type { Message, LLMProvider } from "./llm/provider.js";
export { LLMResponseParseError, parseJsonResponse } from "./llm/parseJson.js";
export { LLMRequestError } from "./llm/errors.js";
export { FakeLLMProvider } from "./llm/testUtils.js";
export { createProvider } from "./llm/factory.js";

export { PatternSchema } from "./schemas/pattern.js";
export type { Pattern } from "./schemas/pattern.js";
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
export type { IntakeCallbacks } from "./agents/intake/runIntake.js";

export { parseFeatureHeader } from "./agents/generador/parseFeatureHeader.js";
export { generateCode } from "./agents/generador/codeGenerator.js";
export type { GeneratedFile } from "./agents/generador/codeGenerator.js";
export { writeTestFiles, testFileExists, testFilePath } from "./agents/generador/writeTestFiles.js";
export { listFeatureFiles } from "./agents/generador/listFeatureFiles.js";
export { runGenerador } from "./agents/generador/runGenerador.js";
export type { GeneratorCallbacks } from "./agents/generador/runGenerador.js";

export type { CodeFile, CodeCheckResult, CodeChecker } from "./codeCheck/codeChecker.js";
export { FakeCodeChecker } from "./codeCheck/testUtils.js";
export { createRealCodeChecker, realCodeChecker, MissingCodeToolError } from "./codeCheck/realCodeChecker.js";

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
