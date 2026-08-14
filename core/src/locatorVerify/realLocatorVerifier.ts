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

const BROWSER_MISSING_SIGNATURE = "playwright install";

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

function formatUnverified(entry: VerificationEntry): string {
  return `El locator ${entry.method}(${JSON.stringify(entry.argument)}) no se encontró en la pantalla inicial (0 elementos) — puede que solo aparezca tras una acción previa (login, envío de formulario) que este harness no simula; no se pudo verificar automáticamente.`;
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
        const warnings: string[] = [];
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
          if (entry.error) {
            failures.push(formatFailure(entry));
          } else if (entry.count === 0) {
            warnings.push(formatUnverified(entry));
          } else if (entry.count !== 1) {
            failures.push(formatFailure(entry));
          }
        }

        if (
          parsedCount === 0 &&
          `${result.stdout}${result.stderr}`.includes(BROWSER_MISSING_SIGNATURE)
        ) {
          // Zero parsed results plus this exact hint means the generated
          // script never ran the checks at all (chromium.launch() blew up
          // because the Playwright browsers aren't installed) — an
          // environment problem, not a code-quality problem the LLM can fix
          // by retrying. Attributing it correctly avoids burning all
          // MAX_ATTEMPTS retries on something outside the LLM's control.
          throw new MissingLocatorVerifierToolError(
            `no se encontraron los navegadores de Playwright (ejecuta "playwright install")\n${result.stderr || result.stdout}`.trim()
          );
        }

        if (parsedCount < checks.length) {
          failures.push(
            `El script de verificación de locators solo devolvió resultados para ${parsedCount} de ${checks.length} locators esperados (posible fallo o cierre inesperado del proceso).\n${result.stderr || result.stdout || ""}`.trim()
          );
        }

        if (failures.length > 0) return { ok: false, errors: failures.join("\n\n") };
        return warnings.length === 0 ? { ok: true } : { ok: true, warnings: warnings.join("\n\n") };
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

export const realLocatorVerifier: LocatorVerifier = createRealLocatorVerifier();
