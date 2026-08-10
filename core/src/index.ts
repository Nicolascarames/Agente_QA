export { slugify } from "./util/slugify.js";

export {
  ProviderNameSchema,
  CredentialsSchema,
  credentialsPath,
  saveCredentials,
  loadCredentials,
} from "./config/credentials.js";
export type { ProviderName, Credentials } from "./config/credentials.js";

export {
  ProjectConfigSchema,
  projectConfigPath,
  saveProjectConfig,
  loadProjectConfig,
} from "./config/projectConfig.js";
export type { ProjectConfig } from "./config/projectConfig.js";

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
