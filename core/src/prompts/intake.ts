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
