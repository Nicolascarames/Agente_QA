import { promises as fs } from "node:fs";
import path from "node:path";
import type { LLMProvider } from "../../llm/provider.js";
import type { CodeChecker } from "../../codeCheck/codeChecker.js";
import type { LocatorVerifier, ExplorationCredentials } from "../../locatorVerify/locatorVerifier.js";
import type { EmitEvent } from "../../events/agentEvent.js";
import { loadAppMap } from "../../appMap/mapStore.js";
import { saveOverride } from "../../appMap/overrides.js";
import { findScreen } from "../../appMap/mapQuery.js";
import { locatorsUsedBy, checkMapFreshness } from "../../locatorVerify/mapFreshness.js";
import { generateCode, type GeneratedFile } from "./codeGenerator.js";
import { testFileExists, testFilePath, writeTestFiles } from "./writeTestFiles.js";

function toPythonModuleSlug(rawSlug: string): string {
  const sanitized = rawSlug.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

const MAX_ATTEMPTS = 4; // 1 initial generation + up to 3 corrections
const SCREEN_TAG = /@screen:([\p{L}\p{N}_-]+)/u;

/** The first `@screen:` tag anywhere in the feature — the screen the scenario belongs to. */
function extractScreenTag(featureText: string): string | null {
  for (const rawLine of featureText.split(/\r?\n/)) {
    const match = rawLine.trim().match(SCREEN_TAG);
    if (match) return match[1];
  }
  return null;
}

export interface GeneratorCallbacks {
  confirmOverwrite(filePath: string): Promise<boolean>;
  onStaleLocator(
    stale: { screenId: string; name: string; count: number }[]
  ): Promise<{ action: "remap" } | { action: "override"; python: string }>;
}

export interface RunGeneradorOptions {
  featureFilePath: string;
  llm: LLMProvider;
  checker: CodeChecker;
  verifier: LocatorVerifier;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  credentials: ExplorationCredentials | undefined;
  callbacks: GeneratorCallbacks;
  emit: EmitEvent;
}

export async function runGenerador(options: RunGeneradorOptions): Promise<{ writtenPaths: string[] }> {
  const { featureFilePath, llm, checker, verifier, projectRoot, testsDir, baseUrl, credentials, callbacks, emit } =
    options;

  const map = await loadAppMap(projectRoot);
  if (!map) {
    throw new Error(
      'No hay mapa de la aplicación. Ejecuta "agente-qa map" antes de generar código: sin él, los localizadores no estarían validados contra la aplicación real.'
    );
  }

  const featureText = await fs.readFile(featureFilePath, "utf-8");

  const screenId = extractScreenTag(featureText);
  if (!screenId) {
    throw new Error(
      'El archivo .feature no incluye ninguna etiqueta "@screen:", así que no se puede saber a qué pantalla del mapa pertenece. Vuelve a generar el plan de pruebas, o ejecuta "agente-qa map" si el mapa está desactualizado.'
    );
  }
  if (!findScreen(map, screenId)) {
    throw new Error(
      `La etiqueta "@screen:${screenId}" no corresponde a ninguna pantalla del mapa. Vuelve a generar el plan de pruebas, o ejecuta "agente-qa map" si el mapa está desactualizado.`
    );
  }

  const used = locatorsUsedBy(featureText, map);
  emit({
    agent: "generador", status: "info", depth: 1,
    message: `Verificando ${used.length} localizador(es) contra la aplicación real`,
  });
  const freshness = await checkMapFreshness(used, verifier, baseUrl, credentials);
  if (!freshness.ok) {
    if (freshness.stale.length === 0) {
      throw new Error(
        'La verificación de los localizadores contra la aplicación real ha fallado sin poder identificar qué localizador falló (por ejemplo, un fallo de navegación o que la aplicación no esté disponible en la URL configurada). Comprueba que la aplicación es accesible e inténtalo de nuevo.'
      );
    }
    for (const stale of freshness.stale) {
      const decision = await callbacks.onStaleLocator([stale]);
      if (decision.action === "remap") {
        throw new Error(
          'Uno o más localizadores ya no coinciden con la aplicación real. Ejecuta "agente-qa map" para volver a mapear la aplicación antes de generar código.'
        );
      }
      await saveOverride(projectRoot, { screenId: stale.screenId, name: stale.name, python: decision.python });
    }
  } else if (freshness.warnings) {
    emit({ agent: "generador", status: "warn", depth: 1, message: freshness.warnings });
  }

  const featureFileName = path.basename(featureFilePath);
  const naming = { slug: toPythonModuleSlug(featureFileName.replace(/\.feature$/, "")), featureFileName };

  let retry: { previousFiles: GeneratedFile[]; feedback: string } | undefined;
  let files: GeneratedFile[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    emit({
      agent: "generador", status: "info", depth: 1,
      message: `Generando código (intento ${attempt} de ${MAX_ATTEMPTS})`,
    });
    files = await generateCode(featureText, llm, map, screenId, naming, retry);

    const checkResult = await checker.check(files);
    if (checkResult.ok) {
      emit({
        agent: "generador", status: "ok", depth: 1,
        message: `Código generado y verificado (intento ${attempt} de ${MAX_ATTEMPTS})`,
      });
      break;
    }

    const errors = checkResult.errors ?? "Error desconocido de verificación de código.";
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`El código generado no pasó la verificación tras ${MAX_ATTEMPTS} intentos. Último error:\n${errors}`);
    }
    retry = { previousFiles: files, feedback: errors };
  }

  for (const file of files) {
    if (await testFileExists(projectRoot, testsDir, file.path)) {
      const targetPath = testFilePath(projectRoot, testsDir, file.path);
      const overwrite = await callbacks.confirmOverwrite(targetPath);
      if (!overwrite) {
        throw new Error(`Cancelado: ya existe ${targetPath} y no se sobrescribió.`);
      }
    }
  }

  const writtenPaths = await writeTestFiles(projectRoot, testsDir, files);

  return { writtenPaths };
}
