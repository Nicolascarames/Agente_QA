import { promises as fs } from "node:fs";
import path from "node:path";
import { appMapDir } from "./mapStore.js";
import { OverridesFileSchema, type AppMap, type LocatorOverride, type OverridesFile } from "./schema.js";

const EMPTY: OverridesFile = { schemaVersion: 1, locators: [] };

export function overridesPath(projectRoot: string): string {
  return path.join(appMapDir(projectRoot), "overrides.json");
}

export async function loadOverrides(projectRoot: string): Promise<OverridesFile> {
  let raw: string;
  try {
    raw = await fs.readFile(overridesPath(projectRoot), "utf-8");
  } catch {
    return EMPTY;
  }
  const parsed = OverridesFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `El fichero overrides.json de ${overridesPath(projectRoot)} no tiene el formato esperado. Corrígelo o bórralo.`
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
  const screens = map.screens.map((screen) => ({ ...screen, locators: screen.locators.map((l) => ({ ...l })) }));

  for (const override of overrides.locators) {
    const screen = screens.find((s) => s.id === override.screenId);
    const locator = screen?.locators.find((l) => l.name === override.name);
    if (!locator) {
      orphans.push(override);
      continue;
    }
    locator.python = override.python;
  }

  return { map: { ...map, screens }, orphans };
}
