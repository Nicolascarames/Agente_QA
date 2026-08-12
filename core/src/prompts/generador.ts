export interface CodeGenerationNaming {
  slug: string;
  featureFileName: string;
}

export interface CodeGenerationRetry {
  previousFiles: { path: string; content: string }[];
  feedback: string;
}

export function codeGenerationPrompt(
  featureText: string,
  matchedPattern: { name: string; pageObjectTemplate: string } | null,
  naming: CodeGenerationNaming,
  retry?: CodeGenerationRetry
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este esqueleto de Page Object conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos del feature:

"""
${matchedPattern.pageObjectTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el Page Object desde cero.";

  const retrySection = retry
    ? `\n\nEl intento anterior generó este código:
"""
${retry.previousFiles.map((f) => `# FILE: ${f.path}\n${f.content}`).join("\n")}
"""

Pero no pasó la verificación de calidad. Corrige exactamente este error, manteniendo el resto del código igual siempre que sea posible:
"""
${retry.feedback}
"""`
    : "";

  return `Eres un ingeniero de QA experto en Playwright + Python + pytest-bdd + Page Object Model.

Dado este archivo Gherkin ya aprobado, ubicado en "features/${naming.featureFileName}":
"""
${featureText}
"""

${patternSection}

El proyecto ya tiene instalado el plugin "pytest-playwright": el fixture "page" (una página de navegador ya lista) está disponible automáticamente en cualquier test, no lo definas tú ni escribas ningún conftest.py.

La URL de la aplicación bajo test y las credenciales de una cuenta de prueba NUNCA se escriben como texto literal en este código: se guarda en el repositorio del usuario. Léelas siempre con "os.environ": "os.environ[\"AGENTE_QA_APP_URL\"]" para la URL base, y si el escenario prueba un login, "os.environ[\"AGENTE_QA_TEST_USERNAME\"]" / "os.environ[\"AGENTE_QA_TEST_PASSWORD\"]" para usuario y contraseña.

Genera EXACTAMENTE dos bloques de código, cada uno empezando por una línea con este formato exacto "# FILE: <ruta>", seguida del contenido completo de ese archivo. No incluyas explicaciones fuera de los bloques ni bloques de código markdown (\`\`\`).

Los dos archivos, en este orden, usando exactamente estos nombres (no inventes otros):
1. "tests/test_${naming.slug}.py" — step definitions pytest-bdd. Importa "scenarios" de "pytest_bdd" y llama "scenarios(\"../features/${naming.featureFileName}\")". Importa de "pytest_bdd" solo los decoradores "given"/"when"/"then" que realmente vayas a usar según los pasos del feature (no importes los que no uses). Usa el fixture "page" (parámetro de las funciones step) para interactuar con el navegador a través del Page Object.
2. "pages/${naming.slug}_page.py" — clase(s) Page Object en Python (Playwright sync API) para las pantallas involucradas, recibiendo "page" en su constructor.${retrySection}`;
}
