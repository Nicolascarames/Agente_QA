import { promises as fs } from "node:fs";
import path from "node:path";

export async function listFeatureFiles(projectRoot: string, testsDir: string): Promise<string[]> {
  const dir = path.join(projectRoot, testsDir, "features");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((f) => f.endsWith(".feature")).sort();
}
