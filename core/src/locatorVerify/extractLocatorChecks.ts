import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { LocatorCheck } from "./locatorVerifier.js";

export interface LocatorExtractionResult {
  checks: LocatorCheck[];
  skipped: string[];
}

interface FeatureStep {
  text: string;
  outlineExamples: Record<string, string>[] | null;
}

function parseFeatureSteps(featureText: string): FeatureStep[] {
  const steps: FeatureStep[] = [];
  for (const rawLine of featureText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(?:Given|When|Then|And|But)\s+(.*)$/);
    if (match) {
      steps.push({ text: match[1], outlineExamples: null });
    }
  }
  return steps;
}

interface ParsedStepDef {
  template: string;
  isDynamic: boolean;
  body: string;
}

const STEP_DEF_PATTERN =
  /@(?:given|when|then)\(\s*(?:parsers\.parse\(\s*(['"])([\s\S]*?)\1\s*\)|(['"])([\s\S]*?)\3)\s*\)\s*\r?\ndef\s+[\p{L}\p{N}_]+\([^)]*\):\s*\r?\n((?:[ \t]+.*\r?\n?)*)/gu;

function parseStepDefs(stepDefsSrc: string): ParsedStepDef[] {
  const defs: ParsedStepDef[] = [];
  for (const m of stepDefsSrc.matchAll(STEP_DEF_PATTERN)) {
    const [, , parseTemplate, , plainTemplate, body] = m;
    const template = parseTemplate ?? plainTemplate;
    defs.push({ template, isDynamic: parseTemplate !== undefined, body });
  }
  return defs;
}

function templateToRegex(template: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let pattern = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Parameter names can contain unicode letters (Spanish feature text: "contraseña",
  // "categoría") — a plain \w class silently fails to match them.
  pattern = pattern.replace(/\\\{([\p{L}\p{N}_]+)\\\}/gu, (_, name: string) => {
    paramNames.push(name);
    return "(.*?)";
  });
  return { regex: new RegExp(`^${pattern}$`, "u"), paramNames };
}

function findMethodCallForParam(body: string, paramName: string): string | null {
  for (const call of body.matchAll(/[\p{L}\p{N}_]+\.([\p{L}\p{N}_]+)\(([^)]*)\)/gu)) {
    const [, method, argsStr] = call;
    const args = argsStr.split(",").map((a) => a.trim());
    if (args.includes(paramName)) return method;
  }
  return null;
}

export function extractLocatorChecks(featureText: string, files: GeneratedFile[]): LocatorExtractionResult {
  const stepDefsFile = files.find((f) => f.path.startsWith("tests/"));
  const pageObjectFile = files.find((f) => f.path.startsWith("pages/"));
  const checks: LocatorCheck[] = [];
  const skipped: string[] = [];

  if (!stepDefsFile || !pageObjectFile) {
    return { checks, skipped };
  }

  const steps = parseFeatureSteps(featureText);
  const dynamicStepDefs = parseStepDefs(stepDefsFile.content).filter((d) => d.isDynamic);

  for (const step of steps) {
    let matchedDef: ParsedStepDef | null = null;
    let params: Record<string, string> = {};

    for (const def of dynamicStepDefs) {
      const { regex, paramNames } = templateToRegex(def.template);
      const match = step.text.match(regex);
      if (match) {
        matchedDef = def;
        paramNames.forEach((name, i) => (params[name] = match[i + 1]));
        break;
      }
    }
    if (!matchedDef) continue;

    for (const [paramName, rawValue] of Object.entries(params)) {
      const calledMethod = findMethodCallForParam(matchedDef.body, paramName);
      if (!calledMethod || !calledMethod.startsWith("get_")) continue;

      checks.push({ method: calledMethod, argument: rawValue });
    }
  }

  return { checks, skipped };
}
