import { promises as fs } from "node:fs";
import path from "node:path";
import type { GeneratedFile } from "./codeGenerator.js";

export function testFilePath(projectRoot: string, testsDir: string, relativePath: string): string {
  return path.join(projectRoot, testsDir, relativePath);
}

export async function testFileExists(
  projectRoot: string,
  testsDir: string,
  relativePath: string
): Promise<boolean> {
  try {
    await fs.access(testFilePath(projectRoot, testsDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function writeTestFiles(
  projectRoot: string,
  testsDir: string,
  files: GeneratedFile[]
): Promise<string[]> {
  const written: string[] = [];

  for (const file of files) {
    const isSharedConftest = file.path === "conftest.py";
    if (isSharedConftest && (await testFileExists(projectRoot, testsDir, file.path))) {
      continue;
    }

    const targetPath = testFilePath(projectRoot, testsDir, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf-8");
    written.push(targetPath);
  }

  return written;
}
