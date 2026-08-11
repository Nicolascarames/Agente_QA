export function codeGenerationPrompt(
  featureText: string,
  matchedPattern: { name: string; pageObjectTemplate: string } | null,
  feedback?: string
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este esqueleto de Page Object conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos del feature:

"""
${matchedPattern.pageObjectTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el Page Object desde cero.";

  const feedbackSection = feedback
    ? `\n\nEl intento anterior no pasó la verificación de calidad. Corrige exactamente este error antes de responder de nuevo:
"""
${feedback}
"""`
    : "";

  return `Eres un ingeniero de QA experto en Playwright + Python + pytest-bdd + Page Object Model.

Dado este archivo Gherkin ya aprobado:
"""
${featureText}
"""

${patternSection}

Genera EXACTAMENTE tres bloques de código, cada uno empezando por una línea con este formato exacto "# FILE: <ruta>", seguida del contenido completo de ese archivo. No incluyas explicaciones fuera de los bloques ni bloques de código markdown (\`\`\`).

Los tres archivos, en este orden:
1. "tests/test_<nombre>.py" — step definitions pytest-bdd que importan y ejecutan el/los scenario(s) del feature con "from pytest_bdd import scenarios, given, when, then" y "scenarios(...)".
2. "pages/<nombre>_page.py" — clase(s) Page Object en Python (Playwright sync API) para las pantallas involucradas.
3. "conftest.py" — fixtures pytest necesarias (browser, page) usando "playwright.sync_api".${feedbackSection}`;
}
