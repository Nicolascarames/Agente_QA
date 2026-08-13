import { promises as fs } from "node:fs";
import path from "node:path";
import type { TestRunner } from "../../testRun/testRunner.js";
import { listFeatureFiles } from "../generador/listFeatureFiles.js";
import { listAvailableTags } from "./listAvailableTags.js";

export type CaptureMode = "off" | "only-on-failure" | "always";

export interface ExecutorCallbacks {
  selectTags(availableTags: string[]): Promise<string[]>;
  selectCaptureMode(): Promise<CaptureMode>;
  onOutput(chunk: string): void;
}

export interface EjecutorResult {
  exitCode: number;
  junitXmlPath: string;
  htmlReportPath: string;
  browserSetupWarning?: string;
}

const PYTEST_MARKER_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function buildMarkerExpression(availableTags: string[], selectedTags: string[]): string | null {
  const allSelected =
    selectedTags.length === availableTags.length && availableTags.every((tag) => selectedTags.includes(tag));
  if (allSelected) return null;
  return selectedTags
    .map((tag) => {
      const stripped = tag.replace(/^@/, "");
      if (!PYTEST_MARKER_TOKEN.test(stripped)) {
        throw new Error(
          `El tag "${tag}" no se puede usar como filtro de pytest (solo se permiten letras, números y "_", empezando por letra o "_"). Selecciona otro subconjunto de tags.`
        );
      }
      return stripped;
    })
    .join(" or ");
}

function captureModeToFlags(mode: CaptureMode): {
  screenshotMode: "off" | "only-on-failure" | "on";
  videoMode: "off" | "retain-on-failure" | "on";
} {
  switch (mode) {
    case "off":
      return { screenshotMode: "off", videoMode: "off" };
    case "only-on-failure":
      return { screenshotMode: "only-on-failure", videoMode: "retain-on-failure" };
    case "always":
      return { screenshotMode: "on", videoMode: "on" };
  }
}

export async function runEjecutor(
  projectRoot: string,
  testsDir: string,
  runner: TestRunner,
  headedMode: boolean,
  callbacks: ExecutorCallbacks,
  testEnv: Record<string, string> = {}
): Promise<EjecutorResult> {
  const featureFiles = await listFeatureFiles(projectRoot, testsDir);
  if (featureFiles.length === 0) {
    throw new Error("No hay tests generados todavía. Usa 'Generar tests Playwright' primero.");
  }

  const availableTags = await listAvailableTags(projectRoot, testsDir);

  let markerExpression: string | null = null;
  if (availableTags.length > 0) {
    const selectedTags = await callbacks.selectTags(availableTags);
    markerExpression = buildMarkerExpression(availableTags, selectedTags);
  }

  const mode = await callbacks.selectCaptureMode();
  const { screenshotMode, videoMode } = captureModeToFlags(mode);

  const cwd = path.join(projectRoot, testsDir);
  const resultsDir = path.join(cwd, "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const junitXmlPath = path.join(resultsDir, "latest.xml");
  const htmlReportPath = path.join(resultsDir, "latest.html");

  const result = await runner.run({
    cwd,
    markerExpression,
    screenshotMode,
    videoMode,
    headed: headedMode,
    verboseSteps: headedMode,
    junitXmlPath,
    htmlReportPath,
    onOutput: callbacks.onOutput,
    env: testEnv,
  });

  return {
    exitCode: result.exitCode,
    junitXmlPath,
    htmlReportPath,
    browserSetupWarning: result.browserSetupWarning,
  };
}
