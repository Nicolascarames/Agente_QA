import { promises as fs } from "node:fs";
import path from "node:path";
import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import type { CodeChecker } from "../../codeCheck/codeChecker.js";
import type { SiteExplorer, ExplorationCredentials } from "../../siteExplorer/siteExplorer.js";
import type { LocatorVerifier } from "../../locatorVerify/locatorVerifier.js";
import { extractLocatorChecks } from "../../locatorVerify/extractLocatorChecks.js";
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
  onVerificationStep(message: string): void;
}

export interface RunGeneradorOptions {
  featureFilePath: string;
  llm: LLMProvider;
  patterns: Pattern[];
  checker: CodeChecker;
  explorer: SiteExplorer;
  verifier: LocatorVerifier;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  appLanguage: "es" | "en";
  routes: Record<string, string>;
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
    verifier,
    projectRoot,
    testsDir,
    baseUrl,
    appLanguage,
    routes,
    credentials,
    callbacks,
  } = options;

  const featureText = await fs.readFile(featureFilePath, "utf-8");
  const matchedPatternName = parseFeatureHeader(featureText);
  const basePattern = matchedPatternName
    ? (patterns.find((p) => p.name === matchedPatternName) ?? null)
    : null;

  const projectRoute = basePattern ? routes[basePattern.name] : undefined;
  const matchedPattern: Pattern | null =
    basePattern && projectRoute && basePattern.navigationHints
      ? {
          ...basePattern,
          navigationHints: {
            requiresLogin: basePattern.navigationHints.requiresLogin,
            routeCandidates: [projectRoute, ...basePattern.navigationHints.routeCandidates],
          },
        }
      : basePattern;

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
    files = await generateCode(featureText, llm, matchedPattern, naming, evidence, appLanguage, routes, retry);

    const checkResult = await checker.check(files);
    if (!checkResult.ok) {
      const errors = checkResult.errors ?? "Error desconocido de verificación de código.";
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`El código generado no pasó la verificación tras ${MAX_ATTEMPTS} intentos. Último error:\n${errors}`);
      }
      retry = { previousFiles: files, feedback: errors };
      continue;
    }

    const { checks, skipped } = extractLocatorChecks(featureText, files);
    if (skipped.length > 0) {
      callbacks.onVerificationStep(
        `${skipped.length} literal(es) no se pudieron verificar automáticamente:\n${skipped.join("\n")}`
      );
    }
    if (checks.length === 0) break;

    callbacks.onVerificationStep(`Verificando ${checks.length} locator(s) contra la aplicación real...`);
    const verification = await verifier.verify(files, checks, baseUrl, credentials);
    if (verification.ok) break;

    const verifyErrors = verification.errors ?? "Error desconocido de verificación de locators.";
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `El código generado no pasó la verificación de locators tras ${MAX_ATTEMPTS} intentos. Último error:\n${verifyErrors}`
      );
    }
    retry = { previousFiles: files, feedback: verifyErrors };
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
