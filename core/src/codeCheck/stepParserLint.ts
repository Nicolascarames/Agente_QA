import type { CodeFile, CodeCheckResult } from "./codeChecker.js";

const PARSE_CALL = /parsers\.parse\(/;
const QUOTED_PARAM = /"\{([\p{L}\p{N}_]+)\}"/u;

const EXPLANATION =
  'parsers.parse compila "{param}" a ".+?", que exige al menos un carácter y NUNCA matchea la cadena ' +
  "vacía: un Scenario Outline con una celda vacía en Examples (el caso típico de validación de campos " +
  "obligatorios) falla con StepDefinitionNotFoundError. Usa parsers.re con un grupo con nombre que admita " +
  "el vacío, por ejemplo: " +
  `@when(parsers.re(r'introduzco el correo electrónico "(?P<email>[^"]*)"'))`;

export function checkStepParsers(files: CodeFile[]): CodeCheckResult {
  const matches: string[] = [];

  for (const file of files) {
    file.content.split("\n").forEach((line, index) => {
      if (line.trim().startsWith("#")) return;
      if (PARSE_CALL.test(line) && QUOTED_PARAM.test(line)) {
        matches.push(`${file.path}:${index + 1}: ${EXPLANATION}`);
      }
    });
  }

  return matches.length === 0 ? { ok: true } : { ok: false, errors: matches.join("\n\n") };
}
