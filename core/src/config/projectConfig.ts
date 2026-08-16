import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProjectEnv } from "./projectEnv.js";
import type { CrawlLimits } from "../appMap/crawler.js";

export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
  headedMode: z.boolean().default(false),
  appUrl: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.username === "" && url.password === "";
        } catch {
          return true; // URL inválida: ya la rechaza el .url() de arriba.
        }
      },
      {
        message:
          'La URL no puede incluir usuario/contraseña (ej. "https://usuario:clave@host"). config.json se sube a git: guarda las credenciales de test en .agente-qa/.env, no en la URL.',
      }
    ),
  appLanguage: z.enum(["es", "en"]).default("es"),
  routes: z.record(z.string(), z.string()).default({}),
  crawl: z
    .object({
      maxScreens: z.number().int().min(1).default(500),
      maxDepth: z.number().int().min(1).default(25),
      maxDurationMinutes: z.number().int().min(1).default(60),
      loopSuspicionThreshold: z.number().int().min(2).default(3),
      excludeRoutes: z.array(z.string()).default([]),
    })
    // zod v4's `.default()` substitutes this value verbatim when the key is missing —
    // it does not re-parse it through the object shape above, so the per-field
    // `.default(...)` calls would never fire on `{}`. Spelling the whole default out
    // here keeps `ProjectConfigSchema.parse({})` returning the same limits as the
    // per-field defaults describe, instead of an empty `crawl: {}`.
    .default({ maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [] }),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// `CrawlLimits` (hand-written TypeScript, appMap/crawler.ts) and the `crawl` block above
// describe the same contract in two files. This guard makes them fail to compile the
// moment a field is added to one and not the other, instead of drifting apart in silence.
type ConfigCrawl = z.infer<typeof ProjectConfigSchema>["crawl"];
type Conformance = [CrawlLimits] extends [ConfigCrawl]
  ? [ConfigCrawl] extends [CrawlLimits]
    ? true
    : never
  : never;
const _crawlLimitsMatchConfig: Conformance = true;
void _crawlLimitsMatchConfig;

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "config.json");
}

export async function saveProjectConfig(
  projectRoot: string,
  config: z.input<typeof ProjectConfigSchema>
): Promise<void> {
  const parsed = ProjectConfigSchema.parse(config);
  const filePath = projectConfigPath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig | null> {
  const filePath = projectConfigPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const result = ProjectConfigSchema.safeParse(JSON.parse(raw));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(config)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `El archivo ${filePath} es de una versión antigua o tiene valores inválidos:\n${details}\n` +
        `Ejecuta 'agente-qa init' (o la opción "Configuración" del menú) para completarlo.`
    );
  }
  return result.data;
}

export function requireAppUrl(config: ProjectConfig): string {
  return config.appUrl;
}

export function testEnvVars(config: ProjectConfig, env: ProjectEnv): Record<string, string> {
  const vars: Record<string, string> = { AGENTE_QA_APP_URL: config.appUrl };
  if (env.testUsername) vars.AGENTE_QA_TEST_USERNAME = env.testUsername;
  if (env.testPassword) vars.AGENTE_QA_TEST_PASSWORD = env.testPassword;
  return vars;
}
