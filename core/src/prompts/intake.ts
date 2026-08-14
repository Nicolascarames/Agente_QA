export function ambiguityCheckPrompt(text: string): string {
  return `Eres un analista de QA que va a convertir la siguiente petición en un plan de pruebas Gherkin.

Antes de escribir el plan, decide si la petición tiene información suficiente (qué funcionalidad, qué flujo, qué resultado esperado) o si es demasiado ambigua para escribir escenarios precisos.

Responde EXCLUSIVAMENTE con un objeto JSON, sin texto adicional ni bloques de código, con esta forma exacta:
{"ambiguous": boolean, "questions": string[]}

Si "ambiguous" es true, "questions" debe tener entre 1 y 4 preguntas concretas que permitan completar la información que falta. Si "ambiguous" es false, "questions" debe ser un array vacío.

Petición del usuario:
"""
${text}
"""`;
}

export function patternMatchPrompt(
  text: string,
  patterns: { name: string; description: string }[]
): string {
  const patternList = patterns.map((p) => `- ${p.name}: ${p.description}`).join("\n");

  return `Tienes esta lista de patrones de prueba conocidos:
${patternList}

Petición del usuario:
"""
${text}
"""

¿La petición encaja claramente con alguno de estos patrones? Responde EXCLUSIVAMENTE con un objeto JSON, sin texto adicional, con esta forma exacta:
{"matchedPatternName": string | null}

Usa null si ningún patrón encaja con suficiente confianza.`;
}

export function gherkinGenerationPrompt(
  text: string,
  matchedPattern: { name: string; gherkinTemplate: string } | null,
  appLanguage: "es" | "en"
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este patrón conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos de la petición:

"""
${matchedPattern.gherkinTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el plan desde cero.";

  const languageLabel = appLanguage === "en" ? "inglés" : "español";
  const languageSection = `La interfaz real de la aplicación bajo test está en ${languageLabel}. Los textos visibles que menciones o esperes (botones, mensajes, etiquetas, validaciones) deben asumirse en ese idioma — no los traduzcas al castellano aunque el resto de esta conversación esté en castellano.`;

  return `Eres un analista de QA. Escribe un plan de pruebas en formato Gherkin (Feature/Scenario/Given/When/Then, con tags como @smoke o @regression donde corresponda) para esta petición:

"""
${text}
"""

${patternSection}

${languageSection}

Responde ÚNICAMENTE con el contenido completo del archivo .feature, empezando por la línea "Feature:". No incluyas explicaciones ni bloques de código markdown.`;
}
