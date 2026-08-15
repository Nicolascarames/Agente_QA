import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScreenEvidence } from "./siteExplorer.js";

export const EVIDENCE_CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheFile {
  capturedAt: string;
  screens: ScreenEvidence[];
}

export function evidenceCacheKey(input: {
  appUrl: string;
  patternName: string | null;
  routes: Record<string, string>;
}): string {
  const material = JSON.stringify({
    appUrl: input.appUrl,
    patternName: input.patternName,
    routes: Object.keys(input.routes)
      .sort()
      .map((k) => [k, input.routes[k]]),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function cacheDir(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "cache");
}

function cacheFilePath(projectRoot: string, key: string): string {
  return path.join(cacheDir(projectRoot), `exploration-${key}.json`);
}

export async function readCachedEvidence(
  projectRoot: string,
  key: string,
  now: Date = new Date()
): Promise<ScreenEvidence[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(cacheFilePath(projectRoot, key), "utf-8");
  } catch {
    return null;
  }

  let parsed: CacheFile;
  try {
    parsed = JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }

  const capturedAt = Date.parse(parsed.capturedAt ?? "");
  if (Number.isNaN(capturedAt)) return null;
  if (now.getTime() - capturedAt > EVIDENCE_CACHE_TTL_MS) return null;
  if (!Array.isArray(parsed.screens)) return null;

  return parsed.screens;
}

export async function writeCachedEvidence(
  projectRoot: string,
  key: string,
  screens: ScreenEvidence[],
  now: Date = new Date()
): Promise<void> {
  const dirPath = cacheDir(projectRoot);
  // An aria snapshot is real content of the user's app. mode at creation time
  // plus an unconditional chmod: the directory may already exist from an older
  // run created without a mode.
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
  await fs.writeFile(path.join(dirPath, ".gitignore"), "*\n", "utf-8");

  const payload: CacheFile = { capturedAt: now.toISOString(), screens };
  const filePath = cacheFilePath(projectRoot, key);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}
