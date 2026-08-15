import type { CodeFile, CodeCheckResult } from "./codeChecker.js";

const ENV_READ = /os\.environ/;
const LITERAL_COMPARISON = /==\s*['"]/;

const EXPLANATION =
  "Elegir una credencial comparando un valor del Gherkin con un literal hace que el .feature diga una cosa " +
  "y el test haga otra en silencio. Lee la credencial siempre de forma incondicional " +
  '(os.environ["AGENTE_QA_TEST_USERNAME"] / os.environ["AGENTE_QA_TEST_PASSWORD"]) en el método que ejecuta ' +
  "el login con la cuenta de prueba, y deja los valores literales del Gherkin para los casos con credenciales " +
  "inválidas, que sí son datos del escenario.";

// How many lines apart a literal comparison and an os.environ read can be and
// still count as the same anti-pattern. The defect this lint was first written
// from was a one-line ternary (offset 0), but a model is at least as likely to
// write the equivalent multi-line if-body form:
//   if email == "user@example.com":
//       email = os.environ["AGENTE_QA_TEST_USERNAME"]
// — comparison and read on adjacent (or near-adjacent) lines, not the same one.
const WINDOW = 3;

export function checkCredentialSubstitution(files: CodeFile[]): CodeCheckResult {
  const matches: string[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");
    const isComment = (line: string): boolean => line.trim().startsWith("#");

    lines.forEach((line, index) => {
      if (isComment(line) || !LITERAL_COMPARISON.test(line)) return;

      for (let offset = -WINDOW; offset <= WINDOW; offset++) {
        const otherIndex = index + offset;
        if (otherIndex < 0 || otherIndex >= lines.length) continue;
        const otherLine = lines[otherIndex];
        if (isComment(otherLine)) continue;
        if (ENV_READ.test(otherLine)) {
          matches.push(`${file.path}:${index + 1}: ${EXPLANATION}`);
          return;
        }
      }
    });
  }

  return matches.length === 0 ? { ok: true } : { ok: false, errors: matches.join("\n\n") };
}
