import { promises as fs } from "node:fs";
import path from "node:path";
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { CodeChecker } from "../../codeCheck/codeChecker.js";
import { saveProjectPattern } from "../../patterns/registry.js";
import { parseFeatureHeader } from "./parseFeatureHeader.js";
import { generateCode, type GeneratedFile } from "./codeGenerator.js";
import { testFileExists, testFilePath, writeTestFiles } from "./writeTestFiles.js";

const MAX_ATTEMPTS = 4; // 1 initial generation + up to 3 corrections

export interface GeneratorCallbacks {
  offerSavePattern(featureText: string): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}

export async function runGenerador(
  featureFilePath: string,
  llm: LLMProvider,
  patterns: Pattern[],
  checker: CodeChecker,
  projectRoot: string,
  testsDir: string,
  callbacks: GeneratorCallbacks
): Promise<{ writtenPaths: string[] }> {
  const featureText = await fs.readFile(featureFilePath, "utf-8");
  const matchedPatternName = parseFeatureHeader(featureText);
  const matchedPattern = matchedPatternName
    ? (patterns.find((p) => p.name === matchedPatternName) ?? null)
    : null;

  const featureFileName = path.basename(featureFilePath);
  const naming = { slug: featureFileName.replace(/\.feature$/, ""), featureFileName };

  let retry: { previousFiles: GeneratedFile[]; feedback: string } | undefined;
  let files: GeneratedFile[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    files = await generateCode(featureText, llm, matchedPattern, naming, retry);
    const result = await checker.check(files);
    if (result.ok) break;

    const errors = result.errors ?? "Error desconocido de verificación de código.";
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`El código generado no pasó la verificación tras ${MAX_ATTEMPTS} intentos. Último error:\n${errors}`);
    }
    retry = { previousFiles: files, feedback: errors };
  }

  for (const file of files) {
    if (file.path === "conftest.py") continue;
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
