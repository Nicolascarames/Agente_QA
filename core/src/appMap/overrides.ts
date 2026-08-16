import { promises as fs } from "node:fs";
import path from "node:path";
import { appMapDir } from "./mapStore.js";
import { OverridesFileSchema, type AppMap, type LocatorOverride, type OverridesFile } from "./schema.js";

export function overridesPath(projectRoot: string): string {
  return path.join(appMapDir(projectRoot), "overrides.json");
}

export async function loadOverrides(projectRoot: string): Promise<OverridesFile> {
  const target = overridesPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf-8");
  } catch {
    return { schemaVersion: 1, locators: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `El fichero overrides.json de ${target} no es JSON válido. Corrígelo o bórralo.`
    );
  }
  const parsed = OverridesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `El fichero overrides.json de ${target} no tiene el formato esperado. Corrígelo o bórralo.`
    );
  }
  return parsed.data;
}

export async function saveOverride(projectRoot: string, override: LocatorOverride): Promise<void> {
  const current = await loadOverrides(projectRoot);
  const rest = current.locators.filter(
    (existing) => !(existing.screenId === override.screenId && existing.name === override.name)
  );
  const next: OverridesFile = { schemaVersion: 1, locators: [...rest, override] };
  const dir = appMapDir(projectRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const target = overridesPath(projectRoot);
  await fs.writeFile(target, JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(target, 0o600);
}

/**
 * A remap regenerates map.json from scratch, so manual corrections live in a
 * separate file and are reapplied on top. Without that separation every crawl
 * would silently delete the user's work.
 */
export function applyOverrides(
  map: AppMap,
  overrides: OverridesFile
): { map: AppMap; orphans: LocatorOverride[] } {
  const orphans: LocatorOverride[] = [];
  const patched: AppMap = structuredClone(map);

  for (const override of overrides.locators) {
    const screen = patched.screens.find((s) => s.id === override.screenId);
    const locator = screen?.locators.find((l) => l.name === override.name);
    if (!locator) {
      orphans.push(override);
      continue;
    }
    locator.python = override.python;
  }

  return { map: patched, orphans };
}
