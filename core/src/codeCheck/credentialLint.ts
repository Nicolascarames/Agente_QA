import type { CodeFile, CodeCheckResult } from "./codeChecker.js";

const ENV_READ = /os\.environ/;
const LITERAL_COMPARISON = /==\s*['"]/;

const EXPLANATION =
  "Elegir una credencial comparando un valor del Gherkin con un literal hace que el .feature diga una cosa " +
  "y el test haga otra en silencio. Lee la credencial siempre de forma incondicional " +
  '(os.environ["AGENTE_QA_TEST_USERNAME"] / os.environ["AGENTE_QA_TEST_PASSWORD"]) en el método que ejecuta ' +
  "el login con la cuenta de prueba, y deja los valores literales del Gherkin para los casos con credenciales " +
  "inválidas, que sí son datos del escenario.";

export function checkCredentialSubstitution(files: CodeFile[]): CodeCheckResult {
  const matches: string[] = [];

  for (const file of files) {
    file.content.split("\n").forEach((line, index) => {
      if (line.trim().startsWith("#")) return;
      if (ENV_READ.test(line) && LITERAL_COMPARISON.test(line)) {
        matches.push(`${file.path}:${index + 1}: ${EXPLANATION}`);
      }
    });
  }

  return matches.length === 0 ? { ok: true } : { ok: false, errors: matches.join("\n\n") };
}
