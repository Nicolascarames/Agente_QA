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
  let isOutline = false;
  let inExamples = false;
  let examplesHeader: string[] | null = null;
  let examplesRows: string[][] = [];
  let pendingOutlineSteps: FeatureStep[] = [];

  function flushOutline(): void {
    if (isOutline) {
      const header = examplesHeader;
      const rows = header
        ? examplesRows.map((row) => {
            const record: Record<string, string> = {};
            header.forEach((col, i) => (record[col] = row[i] ?? ""));
            return record;
          })
        : [];
      for (const step of pendingOutlineSteps) step.outlineExamples = rows;
    }
    isOutline = false;
    inExamples = false;
    examplesHeader = null;
    examplesRows = [];
    pendingOutlineSteps = [];
  }

  for (const rawLine of featureText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^Scenario Outline:/i.test(line)) {
      flushOutline();
      isOutline = true;
      continue;
    }
    if (/^Scenario:/i.test(line)) {
      flushOutline();
      continue;
    }
    if (/^Examples:/i.test(line)) {
      inExamples = true;
      continue;
    }
    if (inExamples && line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (!examplesHeader) examplesHeader = cells;
      else examplesRows.push(cells);
      continue;
    }
    const match = line.match(/^(?:Given|When|Then|And|But)\s+(.*)$/);
    if (match) {
      const step: FeatureStep = { text: match[1], outlineExamples: null };
      steps.push(step);
      if (isOutline) pendingOutlineSteps.push(step);
    }
  }
  flushOutline();
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
  for (const call of body.matchAll(/([\p{L}\p{N}_]+)\.([\p{L}\p{N}_]+)\(([^)]*)\)/gu)) {
    const [, receiver, method, argsStr] = call;
    if (receiver === "page") continue; // the raw pytest-playwright fixture is never a Page Object instance
    const args = argsStr.split(",").map((a) => a.trim());
    if (args.includes(paramName)) return method;
  }
  return null;
}

// A step-def commonly asserts directly on the raw `page` fixture (e.g.
// `expect(page.get_by_text(msg)).to_be_visible()`) instead of going through a
// Page Object at all — that's ordinary, unremarkable pytest-playwright usage,
// not a sign the parameter was transformed/lost. Used only to distinguish
// that recognized "nothing to verify here, and that's fine" case from a
// genuinely untraceable parameter (e.g. one run through `.strip()` first),
// which is the case still worth a visible skip.
function isParamPassedToPageFixture(body: string, paramName: string): boolean {
  for (const call of body.matchAll(/([\p{L}\p{N}_]+)\.([\p{L}\p{N}_]+)\(([^)]*)\)/gu)) {
    const [, receiver, , argsStr] = call;
    if (receiver !== "page") continue;
    const args = argsStr.split(",").map((a) => a.trim());
    if (args.includes(paramName)) return true;
  }
  return false;
}

function findDelegatedGetMethod(
  pageObjectSrc: string,
  actionMethod: string,
  paramName: string
): { method: string | null; hasAnyGetCall: boolean } {
  const defRe = new RegExp(
    `def\\s+${actionMethod}\\(self,\\s*[^)]*\\):[\\s\\S]*?(?=\\n    def\\s|\\nclass\\s|$)`
  );
  const match = pageObjectSrc.match(defRe);
  if (!match) return { method: null, hasAnyGetCall: false };
  let hasAnyGetCall = false;
  for (const call of match[0].matchAll(/self\.(get_[\p{L}\p{N}_]*)\(([^)]*)\)/gu)) {
    hasAnyGetCall = true;
    const [, getMethod, argsStr] = call;
    const args = argsStr.split(",").map((a) => a.trim());
    if (args.includes(paramName)) return { method: getMethod, hasAnyGetCall };
  }
  return { method: null, hasAnyGetCall };
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
      if (!calledMethod) {
        // A call on the raw `page` fixture (e.g. a plain Playwright assertion)
        // is a recognized, ordinary pattern — nothing to verify, silently,
        // same as a plain fill_* action. Only flag genuinely untraceable
        // params (never passed unmodified to anything) as a visible gap.
        if (!isParamPassedToPageFixture(matchedDef.body, paramName)) {
          skipped.push(
            `Paso "${step.text}": el parámetro '${paramName}' no se pasa sin transformar (mismo nombre, sin recortar ni procesar) a ningún método del Page Object — no se puede verificar automáticamente.`
          );
        }
        continue;
      }

      let targetMethod: string | null;
      if (calledMethod.startsWith("get_")) {
        targetMethod = calledMethod;
      } else {
        const delegation = findDelegatedGetMethod(pageObjectFile.content, calledMethod, paramName);
        targetMethod = delegation.method;
        if (!targetMethod && delegation.hasAnyGetCall) {
          skipped.push(
            `Paso "${step.text}": el método '${calledMethod}' delega en un get_* del Page Object, pero ninguno recibe el parámetro '${paramName}' con el mismo nombre — puede que el Page Object use otro nombre de parámetro. No se puede verificar automáticamente.`
          );
          continue;
        }
      }

      if (!targetMethod) continue; // acción normal sin locator ambiguo (p.ej. fill_email) — nada que verificar

      const placeholderMatch = rawValue.match(/^<([\p{L}\p{N}_]+)>$/u);
      if (placeholderMatch && step.outlineExamples) {
        const column = placeholderMatch[1];
        if (step.outlineExamples.length === 0 || !(column in step.outlineExamples[0])) {
          skipped.push(
            `Paso "${step.text}": la columna '${column}' no aparece en la tabla Examples de este Scenario Outline (o la tabla no tiene filas).`
          );
          continue;
        }
        for (const row of step.outlineExamples) {
          checks.push({ method: targetMethod, argument: row[column] });
        }
      } else {
        checks.push({ method: targetMethod, argument: rawValue });
      }
    }
  }

  return { checks, skipped };
}
