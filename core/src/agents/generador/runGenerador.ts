import { promises as fs } from "node:fs";
import path from "node:path";
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { CodeChecker } from "../../codeCheck/codeChecker.js";
import type { SiteExplorer, ExplorationCredentials } from "../../siteExplorer/siteExplorer.js";
import { saveProjectPattern } from "../../patterns/registry.js";
import { parseFeatureHeader } from "./parseFeatureHeader.js";
import { generateCode, type GeneratedFile } from "./codeGenerator.js";
import { testFileExists, testFilePath, writeTestFiles } from "./writeTestFiles.js";

function toPythonModuleSlug(rawSlug: string): string {
  const sanitized = rawSlug.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

const MAX_ATTEMPTS = 4; // 1 initial generation + up to 3 corrections

export interface GeneratorCallbacks {
  offerSavePattern(featureText: string): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
  onExplorationStep(message: string): void;
}

export interface RunGeneradorOptions {
  featureFilePath: string;
  llm: LLMProvider;
  patterns: Pattern[];
  checker: CodeChecker;
  explorer: SiteExplorer;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  credentials: ExplorationCredentials | undefined;
  callbacks: GeneratorCallbacks;
}

export async function runGenerador(options: RunGeneradorOptions): Promise<{ writtenPaths: string[] }> {
  const {
    featureFilePath,
    llm,
    patterns,
    checker,
    explorer,
    projectRoot,
    testsDir,
    baseUrl,
    credentials,
    callbacks,
  } = options;

  const featureText = await fs.readFile(featureFilePath, "utf-8");
  const matchedPatternName = parseFeatureHeader(featureText);
  const matchedPattern = matchedPatternName
    ? (patterns.find((p) => p.name === matchedPatternName) ?? null)
    : null;

  const featureFileName = path.basename(featureFilePath);
  const naming = { slug: toPythonModuleSlug(featureFileName.replace(/\.feature$/, "")), featureFileName };

  const exploration = await explorer.explore(
    { featureText, matchedPattern, baseUrl, credentials, headed: true },
    callbacks.onExplorationStep
  );
  if (!exploration.ok) {
    throw new Error(`No se pudo verificar la aplicación real antes de generar el código: ${exploration.error}`);
  }
  const evidence = exploration.screens;

  let retry: { previousFiles: GeneratedFile[]; feedback: string } | undefined;
  let files: GeneratedFile[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    files = await generateCode(featureText, llm, matchedPattern, naming, evidence, retry);
    const result = await checker.check(files);
    if (result.ok) break;

    const errors = result.errors ?? "Error desconocido de verificación de código.";
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

  if (!matchedPattern) {
    const pageObjectFile = files.find((f) => f.path.startsWith("pages/"));
    const saveDecision = await callbacks.offerSavePattern(featureText);
    if (saveDecision.save && saveDecision.name && saveDecision.description) {
      await saveProjectPattern(projectRoot, {
        name: saveDecision.name,
        description: saveDecision.description,
        gherkinTemplate: featureText,
        pageObjectTemplate: pageObjectFile?.content ?? "",
      });
    }
  }

  return { writtenPaths };
}
