import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

export const ProviderNameSchema = z.enum(["anthropic", "openai", "google", "openai-compatible"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const ProjectEnvSchema = z.object({
  appUrl: z.string().url().optional(),
  testUsername: z.string().min(1).optional(),
  testPassword: z.string().min(1).optional(),
  llmProvider: ProviderNameSchema.optional(),
  llmApiKey: z.string().min(1).optional(),
  llmBaseURL: z.string().url().optional(),
  llmModel: z.string().min(1).optional(),
});
export type ProjectEnv = z.infer<typeof ProjectEnvSchema>;

export interface LlmCredentials {
  provider: ProviderName;
  apiKey: string;
  baseURL?: string;
  model?: string;
}

const ENV_VAR_KEYS: Record<keyof ProjectEnv, string> = {
  appUrl: "AGENTE_QA_APP_URL",
  testUsername: "AGENTE_QA_TEST_USERNAME",
  testPassword: "AGENTE_QA_TEST_PASSWORD",
  llmProvider: "AGENTE_QA_LLM_PROVIDER",
  llmApiKey: "AGENTE_QA_LLM_API_KEY",
  llmBaseURL: "AGENTE_QA_LLM_BASE_URL",
  llmModel: "AGENTE_QA_LLM_MODEL",
};

export function projectEnvDir(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa");
}

export function projectEnvPath(projectRoot: string): string {
  return path.join(projectEnvDir(projectRoot), ".env");
}

const ENV_TEMPLATE = `# .env de agente-qa para este proyecto.
# Este archivo NUNCA se sube a git (ver .agente-qa/.gitignore) — puedes guardar aquí
# datos sensibles (API keys, contraseñas de test) con tranquilidad.
# Rellena los valores que necesites y guarda el archivo. Las líneas que empiezan
# por "#" son solo explicación, no hace falta tocarlas.

# ── Aplicación bajo test ──────────────────────────────────────────────
# URL base de la app que vas a probar. Obligatoria para generar y ejecutar tests.
# Ejemplo: AGENTE_QA_APP_URL=https://staging.mi-app.com
AGENTE_QA_APP_URL=

# Usuario y contraseña de una cuenta de prueba, solo si vas a probar flujos de
# login. Opcional: si los dejas vacíos, no podrás generar/ejecutar escenarios
# que dependan de iniciar sesión.
# Ejemplo: AGENTE_QA_TEST_USERNAME=qa-tester@mi-app.com
AGENTE_QA_TEST_USERNAME=
# Ejemplo: AGENTE_QA_TEST_PASSWORD=Sup3rSecreta!
AGENTE_QA_TEST_PASSWORD=

# ── Proveedor LLM (genera y verifica los tests) ───────────────────────
# Uno de: anthropic | openai | google | openai-compatible
# Ejemplo: AGENTE_QA_LLM_PROVIDER=anthropic
AGENTE_QA_LLM_PROVIDER=

# Tu clave de API del proveedor elegido arriba. Obligatoria.
# Ejemplo: AGENTE_QA_LLM_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
AGENTE_QA_LLM_API_KEY=

# Solo si AGENTE_QA_LLM_PROVIDER=openai-compatible (Groq, Together, Ollama local...):
# Ejemplo: AGENTE_QA_LLM_BASE_URL=https://api.groq.com/openai/v1
AGENTE_QA_LLM_BASE_URL=
# Ejemplo: AGENTE_QA_LLM_MODEL=llama-3.3-70b-versatile
AGENTE_QA_LLM_MODEL=
`;

export async function ensureProjectEnvTemplate(
  projectRoot: string
): Promise<{ created: boolean; path: string }> {
  const dirPath = projectEnvDir(projectRoot);
  const filePath = projectEnvPath(projectRoot);

  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });

  const exists = await fs.stat(filePath).then(
    () => true,
    () => false
  );
  if (exists) {
    return { created: false, path: filePath };
  }

  await fs.writeFile(path.join(dirPath, ".gitignore"), ".env\n", "utf-8");
  await fs.writeFile(filePath, ENV_TEMPLATE, { encoding: "utf-8", mode: 0o600 });

  return { created: true, path: filePath };
}

export async function loadProjectEnv(projectRoot: string): Promise<ProjectEnv | null> {
  const filePath = projectEnvPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const parsed = parseDotenv(raw);
  const nonEmpty = (key: string): string | undefined => {
    const value = parsed[key];
    return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
  };

  const candidate = {
    appUrl: nonEmpty(ENV_VAR_KEYS.appUrl),
    testUsername: nonEmpty(ENV_VAR_KEYS.testUsername),
    testPassword: nonEmpty(ENV_VAR_KEYS.testPassword),
    llmProvider: nonEmpty(ENV_VAR_KEYS.llmProvider),
    llmApiKey: nonEmpty(ENV_VAR_KEYS.llmApiKey),
    llmBaseURL: nonEmpty(ENV_VAR_KEYS.llmBaseURL),
    llmModel: nonEmpty(ENV_VAR_KEYS.llmModel),
  };

  const result = ProjectEnvSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${ENV_VAR_KEYS[issue.path[0] as keyof ProjectEnv]}: ${issue.message}`)
      .join("\n");
    throw new Error(`El archivo ${filePath} tiene valores inválidos:\n${details}`);
  }

  return result.data;
}

export function requireLlmConfig(env: ProjectEnv, envPath: string): LlmCredentials {
  const missing: string[] = [];
  if (!env.llmProvider) missing.push(ENV_VAR_KEYS.llmProvider);
  if (!env.llmApiKey) missing.push(ENV_VAR_KEYS.llmApiKey);
  if (env.llmProvider === "openai-compatible") {
    if (!env.llmBaseURL) missing.push(ENV_VAR_KEYS.llmBaseURL);
    if (!env.llmModel) missing.push(ENV_VAR_KEYS.llmModel);
  }
  if (missing.length > 0) {
    throw new Error(`Faltan variables en ${envPath}: ${missing.join(", ")}. Rellénalas y guarda el archivo.`);
  }
  return {
    provider: env.llmProvider as ProviderName,
    apiKey: env.llmApiKey as string,
    baseURL: env.llmBaseURL,
    model: env.llmModel,
  };
}

export function testEnvVars(env: ProjectEnv): Record<string, string> {
  const vars: Record<string, string> = {};
  if (env.appUrl) vars[ENV_VAR_KEYS.appUrl] = env.appUrl;
  if (env.testUsername) vars[ENV_VAR_KEYS.testUsername] = env.testUsername;
  if (env.testPassword) vars[ENV_VAR_KEYS.testPassword] = env.testPassword;
  return vars;
}
