import type { ScreenEvidence } from "../siteExplorer/siteExplorer.js";

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
  appLanguage: "es" | "en",
  evidence: ScreenEvidence[]
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este patrón conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos de la petición:

"""
${matchedPattern.gherkinTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el plan desde cero.";

  const languageLabel = appLanguage === "en" ? "inglés" : "español";
  const languageSection = `La interfaz real de la aplicación bajo test está en ${languageLabel}. Esto rige SOLO cómo redactas la prosa de los pasos (nombres de acciones, elementos, descripciones sin comillas) — no los traduzcas al castellano aunque el resto de esta conversación esté en castellano. NO uses esto como fuente de qué texto esperar entre comillas: la aplicación puede ser bilingüe (por ejemplo, login en un idioma y panel interno en otro) y un único valor global no puede acertar siempre. Para cualquier texto entre comillas, la única fuente de verdad es la evidencia real de abajo.`;

  const evidenceSection =
    evidence.length > 0
      ? `Esto es lo que se ha comprobado de verdad en la aplicación real:

${evidence
  .map((screen) => `### ${screen.stepText}\nURL real: ${screen.url}\n"""\n${screen.ariaSnapshot}\n"""`)
  .join("\n\n")}

REGLA OBLIGATORIA sobre los textos esperados: cualquier texto que escribas entre comillas en un paso (títulos, mensajes de error, mensajes de validación, nombres de botones) debe aparecer LITERALMENTE en alguna de esas capturas. Si el texto que necesitas no aparece en ninguna, no lo inventes: escribe el paso sin literal (por ejemplo "veo un mensaje de error" en vez de "veo el mensaje de error "...""). Un literal inventado hace fallar el test generado y bloquea la generación de código más adelante.`
      : "No se pudo capturar evidencia real de la aplicación: evita escribir textos literales entre comillas que no puedas garantizar, y prefiere pasos sin literal.";

  return `Eres un analista de QA. Escribe un plan de pruebas en formato Gherkin (Feature/Scenario/Given/When/Then, con tags como @smoke o @regression donde corresponda) para esta petición:

"""
${text}
"""

${patternSection}

${languageSection}

${evidenceSection}

Para los escenarios que inician sesión con una cuenta válida, NO escribas el correo ni la contraseña como texto literal: escribe un paso sin datos, por ejemplo "Cuando introduzco las credenciales de la cuenta de prueba". El código generado leerá esas credenciales de la configuración del proyecto. Las credenciales inválidas (para probar el error de login) sí se escriben literales: no son secretos y forman parte del escenario.

Responde ÚNICAMENTE con el contenido completo del archivo .feature, empezando por la línea "Feature:". No incluyas explicaciones ni bloques de código markdown.`;
}
