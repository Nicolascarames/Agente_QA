import { promises as fs } from "node:fs";
import path from "node:path";
import { listFeatureFiles } from "../generador/listFeatureFiles.js";

const TAG_LINE = /^\s*(@\S+\s*)+$/;

export async function listAvailableTags(projectRoot: string, testsDir: string): Promise<string[]> {
  const featureFiles = await listFeatureFiles(projectRoot, testsDir);
  const tags = new Set<string>();

  for (const fileName of featureFiles) {
    const filePath = path.join(projectRoot, testsDir, "features", fileName);
    const content = await fs.readFile(filePath, "utf-8");
    for (const line of content.split("\n")) {
      if (TAG_LINE.test(line)) {
        for (const tag of line.trim().split(/\s+/)) {
          tags.add(tag);
        }
      }
    }
  }

  return [...tags].sort();
}
