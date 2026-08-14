import type { CodeFile, CodeCheckResult } from "./codeChecker.js";

const LOCATOR_OR_PATTERN = /\.or_\(/;

const EXPLANATION =
  '".or_()" combina varias estrategias de locator y puede resolver a más de un elemento real ' +
  '(ejemplo real: un botón "mostrar/ocultar contraseña" con aria-label que también contiene la palabra ' +
  '"password" colisiona con el locator del campo). Usa una única estrategia de locator precisa para este ' +
  'elemento (rol + nombre accesible exacto, get_by_test_id si la evidencia lo muestra, o un selector de ' +
  "atributo/CSS específico) en vez de combinar varias con .or_().";

export function checkLocatorPatterns(files: CodeFile[]): CodeCheckResult {
  const matches: string[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, index) => {
      if (line.trim().startsWith("#")) return;
      if (LOCATOR_OR_PATTERN.test(line)) {
        matches.push(`${file.path}:${index + 1}: ${EXPLANATION}`);
      }
    });
  }

  return matches.length === 0 ? { ok: true } : { ok: false, errors: matches.join("\n\n") };
}
