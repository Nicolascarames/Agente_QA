import { spawn } from "node:child_process";
import type { TestRunner, TestRunOptions, TestRunResult } from "./testRunner.js";

export class MissingTestToolError extends Error {
  constructor(detail: string) {
    super(
      `No se pudo ejecutar los tests: ${detail}. Instala las dependencias con "pip install pytest pytest-bdd pytest-playwright" y luego "playwright install".`
    );
    this.name = "MissingTestToolError";
  }
}

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCapture(command: string, args: string[], cwd: string): Promise<CaptureResult> {
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

function runStreaming(
  command: string,
  args: string[],
  cwd: string,
  onOutput: (chunk: string) => void
): Promise<{ code: number | null; combinedOutput: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let combinedOutput = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      combinedOutput += text;
      onOutput(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      combinedOutput += text;
      onOutput(text);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, combinedOutput }));
  });
}

const BROWSER_MISSING_SIGNATURE = "playwright install";
const BROWSER_SETUP_WARNING = 'Parece que faltan los navegadores de Playwright. Ejecuta "playwright install".';

export function createRealTestRunner(options?: { pythonCommand?: string }): TestRunner {
  const pythonCommand = options?.pythonCommand ?? "python";

  return {
    async run(runOptions: TestRunOptions): Promise<TestRunResult> {
      let preflight: CaptureResult;
      try {
        preflight = await runCapture(
          pythonCommand,
          ["-c", "import pytest, pytest_bdd, pytest_playwright"],
          runOptions.cwd
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new MissingTestToolError(`no se encontró "${pythonCommand}" en el sistema`);
        }
        throw err;
      }
      if (preflight.code !== 0) {
        throw new MissingTestToolError(
          `faltan dependencias Python (pytest, pytest-bdd o pytest-playwright)\n${preflight.stderr || preflight.stdout}`
        );
      }

      const args = ["-m", "pytest"];
      if (runOptions.markerExpression) {
        args.push("-m", runOptions.markerExpression);
      }
      args.push(`--screenshot=${runOptions.screenshotMode}`);
      args.push(`--video=${runOptions.videoMode}`);
      args.push(`--junitxml=${runOptions.junitXmlPath}`);

      const { code, combinedOutput } = await runStreaming(
        pythonCommand,
        args,
        runOptions.cwd,
        runOptions.onOutput
      );

      return {
        exitCode: code ?? 1,
        browserSetupWarning: combinedOutput.includes(BROWSER_MISSING_SIGNATURE)
          ? BROWSER_SETUP_WARNING
          : undefined,
      };
    },
  };
}

export const realTestRunner: TestRunner = createRealTestRunner();
