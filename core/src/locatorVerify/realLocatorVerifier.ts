import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertSafeRelativePath } from "../util/assertSafeRelativePath.js";
import { buildVerificationScript } from "./buildVerificationScript.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { LocatorCheck, LocatorVerifier, LocatorVerificationResult } from "./locatorVerifier.js";
import type { ExplorationCredentials } from "../siteExplorer/siteExplorer.js";

export class MissingLocatorVerifierToolError extends Error {
  constructor(detail: string) {
    super(
      `No se pudo verificar los locators generados: ${detail}. Instala las dependencias con "pip install pytest pytest-bdd pytest-playwright pytest-html" y luego "playwright install".`
    );
    this.name = "MissingLocatorVerifierToolError";
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCapture(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
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

interface VerificationEntry {
  method: string;
  argument: string;
  count?: number;
  matches?: string[];
  error?: string;
}

function formatFailure(entry: VerificationEntry): string {
  if (entry.error) {
    return `El locator ${entry.method}(${JSON.stringify(entry.argument)}) no se pudo verificar: ${entry.error}`;
  }
  const matchesText = (entry.matches ?? []).map((html, i) => `${i + 1}) ${html}`).join("\n");
  return `El locator ${entry.method}(${JSON.stringify(entry.argument)}) resolvió a ${entry.count} elementos reales:\n${matchesText}\nHazlo más específico para que resuelva exactamente a 1 elemento.`;
}

export function createRealLocatorVerifier(options?: { pythonCommand?: string }): LocatorVerifier {
  const pythonCommand = options?.pythonCommand ?? "python";

  return {
    async verify(
      files: GeneratedFile[],
      checks: LocatorCheck[],
      baseUrl: string,
      credentials: ExplorationCredentials | undefined
    ): Promise<LocatorVerificationResult> {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENTE_QA_APP_URL: baseUrl,
        ...(credentials
          ? { AGENTE_QA_TEST_USERNAME: credentials.username, AGENTE_QA_TEST_PASSWORD: credentials.password }
          : {}),
      };

      let preflight: RunResult;
      try {
        preflight = await runCapture(
          pythonCommand,
          ["-c", "import pytest, pytest_bdd, pytest_playwright, pytest_html"],
          process.cwd(),
          env
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new MissingLocatorVerifierToolError(`no se encontró "${pythonCommand}" en el sistema`);
        }
        throw err;
      }
      if (preflight.code !== 0) {
        throw new MissingLocatorVerifierToolError(
          `faltan dependencias Python (pytest, pytest-bdd, pytest-playwright o pytest-html)\n${preflight.stderr || preflight.stdout}`
        );
      }

      if (checks.length === 0) return { ok: true };

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-locatorverify-"));
      try {
        for (const file of files) {
          assertSafeRelativePath(tmpDir, file.path);
          const target = path.join(tmpDir, file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.content, "utf-8");
        }

        const script = buildVerificationScript(files, checks, baseUrl);
        const scriptPath = path.join(tmpDir, "_verify_locators.py");
        await fs.writeFile(scriptPath, script, "utf-8");

        const result = await runCapture(pythonCommand, [scriptPath], tmpDir, env);

        const failures: string[] = [];
        const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
        let parsedCount = 0;
        for (const line of lines) {
          let entry: VerificationEntry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          parsedCount++;
          if (entry.error || entry.count !== 1) {
            failures.push(formatFailure(entry));
          }
        }

        if (parsedCount < checks.length) {
          failures.push(
            `El script de verificación de locators solo devolvió resultados para ${parsedCount} de ${checks.length} locators esperados (posible fallo o cierre inesperado del proceso).\n${result.stderr || result.stdout || ""}`.trim()
          );
        }

        return failures.length === 0 ? { ok: true } : { ok: false, errors: failures.join("\n\n") };
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

export const realLocatorVerifier: LocatorVerifier = createRealLocatorVerifier();
