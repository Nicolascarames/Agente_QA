import { promises as fs } from "node:fs";
import path from "node:path";
import { AppMapSchema, type AppMap } from "./schema.js";

export function appMapDir(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "map");
}

export function appMapPath(projectRoot: string): string {
  return path.join(appMapDir(projectRoot), "map.json");
}

export async function saveAppMap(projectRoot: string, map: AppMap): Promise<string> {
  const dir = appMapDir(projectRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const target = appMapPath(projectRoot);
  await fs.writeFile(target, JSON.stringify(map, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(target, 0o600);
  return target;
}

export async function loadAppMap(projectRoot: string): Promise<AppMap | null> {
  const target = appMapPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf-8");
  } catch {
    return null;
  }
  const parsed = AppMapSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `El fichero map.json de ${target} no tiene el formato esperado. Vuelve a mapear la aplicación con "agente-qa map".`
    );
  }
  return parsed.data;
}
