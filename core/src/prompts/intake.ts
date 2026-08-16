import type { AppMap } from "../appMap/schema.js";
import { findScreen, screenLiterals, textsAfterClick } from "../appMap/mapQuery.js";

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

export function gherkinGenerationPrompt(text: string, map: AppMap, screenId: string): string {
  const screen = findScreen(map, screenId);
  if (!screen) throw new Error(`La pantalla "${screenId}" no existe en el mapa.`);

  const literals = screenLiterals(map, screenId)
    .filter((literal) => !screen.probeValues.includes(literal))
    .map((literal) => `  - ${JSON.stringify(literal)}`)
    .join("\n");

  const clicks = screen.locators
    .filter((locator) => locator.kind === "button" || locator.kind === "link")
    .map((locator) => {
      // A locator that submits a form (e.g. a login button) reaches its resulting
      // state via action "submit", not "click" — textsAfterClick only covers the
      // latter. Both are things a user does BY interacting with this locator, so
      // both belong here: the model needs "log_in_button → Authentication failed"
      // just as much as "forgot_button → Reset password".
      const afterSubmit = screen.states
        .filter((state) => state.reachedBy.locator === locator.name && state.reachedBy.action === "submit")
        .flatMap((state) => state.addsTexts);
      const after = Array.from(new Set([...textsAfterClick(map, screenId, locator.name), ...afterSubmit]))
        .filter((literal) => !screen.probeValues.includes(literal));
      const effect = after.length > 0
        ? `hace aparecer: ${after.map((a) => JSON.stringify(a)).join(", ")}`
        : "no se registró ningún cambio de contenido";
      return `  - ${locator.name} (${JSON.stringify(locator.accessibleName ?? locator.name)}) → ${effect}`;
    })
    .join("\n");

  const fields = screen.locators
    .filter((locator) => locator.kind === "input" || locator.kind === "select")
    .map((locator) => `  - ${JSON.stringify(locator.accessibleName ?? locator.name)}`)
    .join("\n");

  return `Eres un ingeniero de QA. Escribe un plan de pruebas en Gherkin para esta petición:

"""
${text}
"""

Transcurre en la pantalla "${screen.name}" del mapa de la aplicación, recorrida con un
navegador real. Estos son los ÚNICOS textos que existen de verdad en esa pantalla:

${literals}

Campos que se pueden rellenar:

${fields.length > 0 ? fields : "  (ninguno)"}

Qué provoca cada acción — úsalo para que cada Then afirme sobre el DESTINO, no sobre el
elemento que se acaba de pulsar:

${clicks.length > 0 ? clicks : "  (ninguna)"}

Reglas, todas obligatorias:

1. Escribe el Gherkin en INGLÉS (English): la prosa de los pasos y los títulos de escenario.
2. Todo texto entre comillas debe estar copiado LETRA POR LETRA de las listas de arriba.
   No inventes ningún texto de interfaz: si no está en la lista, no existe.
3. Cada escenario lleva la etiqueta @screen:${screen.id}.
4. Un Then afirma lo que aparece DESPUÉS de la acción. Si pulsas un elemento y la lista
   dice qué hace aparecer, afirma ese texto — nunca el nombre del elemento que pulsaste,
   porque tras la acción puede haber desaparecido.
5. Usa este vocabulario de pasos:
     Given I am on the "<pantalla>" screen
     When  I fill "<campo>" with "<valor>"
     When  I click "<elemento>"
     Then  I see "<texto>"
     Then  I do not see "<texto>"

Responde SOLO con el JSON: {"fileName": "kebab-case.feature", "featureText": "..."}`;
}
