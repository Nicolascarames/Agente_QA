import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertSafeRelativePath } from "../util/assertSafeRelativePath.js";
import { checkLocatorPatterns } from "./locatorLint.js";
import type { CodeChecker, CodeFile, CodeCheckResult } from "./codeChecker.js";

export class MissingCodeToolError extends Error {
  constructor(tool: string) {
    super(
      `No se encontró "${tool}" en el sistema. Instala Python y ruff ("pip install ruff") para poder generar tests Playwright.`
    );
    this.name = "MissingCodeToolError";
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runOrThrowMissing(
  command: string,
  args: string[],
  cwd: string,
  toolName: string
): Promise<RunResult> {
  try {
    return await runCommand(command, args, cwd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingCodeToolError(toolName);
    }
    throw err;
  }
}

export function createRealCodeChecker(options?: {
  pythonCommand?: string;
  ruffCommand?: string;
}): CodeChecker {
  const pythonCommand = options?.pythonCommand ?? "python";
  const ruffCommand = options?.ruffCommand ?? "ruff";

  return {
    async check(files: CodeFile[]): Promise<CodeCheckResult> {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-codecheck-"));
      try {
        const absolutePaths: string[] = [];
        for (const file of files) {
          assertSafeRelativePath(tmpDir, file.path);
          const target = path.join(tmpDir, file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.content, "utf-8");
          absolutePaths.push(target);
        }

        const errors: string[] = [];

        const compile = await runOrThrowMissing(
          pythonCommand,
          ["-m", "py_compile", ...absolutePaths],
          tmpDir,
          "python"
        );
        if (compile.code !== 0) {
          errors.push(compile.stderr || compile.stdout);
        }

        const lint = await runOrThrowMissing(ruffCommand, ["check", tmpDir], tmpDir, "ruff");
        if (lint.code !== 0) {
          errors.push(lint.stdout || lint.stderr);
        }

        const locatorResult = checkLocatorPatterns(files);
        if (!locatorResult.ok && locatorResult.errors) {
          errors.push(locatorResult.errors);
        }

        return errors.length === 0 ? { ok: true } : { ok: false, errors: errors.join("\n\n") };
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

export const realCodeChecker: CodeChecker = createRealCodeChecker();
