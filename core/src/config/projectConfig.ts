import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
  headedMode: z.boolean().default(false),
  appLanguage: z.enum(["es", "en"]).default("es"),
  routes: z.record(z.string(), z.string()).default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

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
  try {
    const raw = await fs.readFile(projectConfigPath(projectRoot), "utf-8");
    return ProjectConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
