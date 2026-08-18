import type { AppMap, ScreenState } from "../appMap/schema.js";
import { findScreen, screenLiterals } from "../appMap/mapQuery.js";

/**
 * Names, in Spanish, both what the user did to reach a state and with what data —
 * a submit with invalid data and a submit with valid data are different
 * preconditions, and a Then must never assert one state's texts under the other's.
 */
function describePrecondition(
  action: ScreenState["reachedBy"]["action"],
  data: ScreenState["reachedBy"]["data"]
): string {
  const base = action === "submit" ? "al enviar el formulario" : "al hacer clic";
  if (data === "valid") return `${base} con datos válidos`;
  if (data === "invalid") return `${base} con datos inválidos`;
  return base;
}

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
    .flatMap((locator) => {
      const label = JSON.stringify(locator.accessibleName ?? locator.name);
      const states = screen.states.filter((state) => state.reachedBy.locator === locator.name);

      if (states.length === 0) {
        return [`  - ${locator.name} (${label}) → no se registró ningún cambio de contenido`];
      }

      // A locator can reach more than one state under different preconditions — e.g.
      // a login button that submits with invalid data (shows an error) or with valid
      // data (shows the next screen). Flattening those into one line would tell the
      // model that both texts appear no matter what, which is false and lets it
      // assert the error message after a valid-data scenario. Group by (action, data)
      // instead, so every line names both what the user did and with what data.
      const groups = new Map<
        string,
        { action: ScreenState["reachedBy"]["action"]; data: ScreenState["reachedBy"]["data"]; texts: string[] }
      >();
      for (const state of states) {
        const key = `${state.reachedBy.action}:${state.reachedBy.data}`;
        const group = groups.get(key);
        if (group) {
          group.texts.push(...state.addsTexts);
        } else {
          groups.set(key, { action: state.reachedBy.action, data: state.reachedBy.data, texts: [...state.addsTexts] });
        }
      }

      return Array.from(groups.values()).map((group) => {
        const texts = Array.from(new Set(group.texts)).filter((literal) => !screen.probeValues.includes(literal));
        const effect = texts.length > 0
          ? `hace aparecer: ${texts.map((t) => JSON.stringify(t)).join(", ")}`
          : "no se registró ningún cambio de contenido";
        return `  - ${locator.name} (${label}), ${describePrecondition(group.action, group.data)} → ${effect}`;
      });
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

${literals.length > 0 ? literals : "  (ninguno)"}

Campos que se pueden rellenar:

${fields.length > 0 ? fields : "  (ninguno)"}

Qué provoca cada acción — cada línea indica también la condición exacta bajo la que
ocurre (por ejemplo, solo al enviar el formulario con datos inválidos). Úsalo para que
cada Then afirme sobre el DESTINO bajo esa misma condición, no sobre el elemento que se
acaba de pulsar:

${clicks.length > 0 ? clicks : "  (ninguna)"}

Reglas, todas obligatorias:

1. Escribe el Gherkin en INGLÉS (English): la prosa de los pasos y los títulos de escenario.
2. Todo texto entre comillas debe estar copiado LETRA POR LETRA de las listas de arriba.
   No inventes ningún texto de interfaz: si no está en la lista, no existe.
3. Cada escenario lleva la etiqueta @screen:${screen.id}.
4. Un Then afirma lo que aparece DESPUÉS de la acción, y solo bajo la misma condición
   indicada en la lista (por ejemplo, no afirmes el mensaje de un envío con datos
   inválidos en un escenario que envía datos válidos). Si pulsas un elemento y la lista
   dice qué hace aparecer, afirma ese texto — nunca el nombre del elemento que pulsaste,
   porque tras la acción puede haber desaparecido.
5. Usa este vocabulario de pasos:
     Given I am on the "<pantalla>" screen
     When  I fill "<campo>" with "<valor>"
     When  I fill "<campo>" with the test username
     When  I fill "<campo>" with the test password
     When  I click "<elemento>"
     Then  I see "<texto>"
     Then  I do not see "<texto>"
6. Para las credenciales VÁLIDAS de la cuenta de prueba usa SIEMPRE
   "I fill \"<campo>\" with the test username" / "... with the test password".
   Nunca inventes un email o una contraseña que se supongan válidos: no
   existirían en la aplicación real y el escenario fallaría siempre. Para
   credenciales INVÁLIDAS usa la forma con valor entrecomillado y el literal
   que quieras: ahí el valor sí es un dato del escenario.

Responde SOLO con el JSON: {"fileName": "kebab-case.feature", "featureText": "..."}`;
}
