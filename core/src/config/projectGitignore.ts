import { promises as fs } from "node:fs";
import path from "node:path";

export function projectGitignorePath(projectRoot: string): string {
  return path.join(projectRoot, ".gitignore");
}

export async function readProjectGitignoreEntries(projectRoot: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(projectGitignorePath(projectRoot), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export async function appendProjectGitignoreEntries(projectRoot: string, entries: string[]): Promise<void> {
  if (entries.length === 0) return;

  const filePath = projectGitignorePath(projectRoot);
  let existing: string;
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      existing = "";
    } else {
      throw err;
    }
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const block = `${needsLeadingNewline ? "\n" : ""}${entries.join("\n")}\n`;
  await fs.appendFile(filePath, block, "utf-8");
}
