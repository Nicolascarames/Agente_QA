import type { AppMap, Screen, Transition } from "../appMap/schema.js";

/**
 * A text is tainted if it contains ANY probe value the crawler itself typed
 * — not just when it equals one exactly. `captureScreen` pushes the same
 * accessible-name string into both `texts` and `LocatorEntry.accessibleName`,
 * and for the "valid" submit pass the probe values are the user's real
 * credentials, not synthetic placeholders. A screen that echoes a submitted
 * value into a longer string ("Cerrar sesión (usuario@empresa.com)") must be
 * caught too, so this is a substring check, not `===`. Applied uniformly to
 * every field that reaches the prompt string below — `texts` alone is not
 * enough, since the same tainted string can also reach the model through a
 * button/link's `accessibleName` (`acciones`) or a locator's slugged name
 * (`transiciones`).
 */
function isTainted(text: string, probeValues: string[]): boolean {
  return probeValues.some((probe) => probe.length > 0 && text.includes(probe));
}

/**
 * `t.toScreenId` is set by the crawler to a route TEMPLATE (e.g. `/user/:id`),
 * never to a screen id — each screen's real `id` is a separately slugged,
 * deduplicated identifier (e.g. `user_id`). Printing the template directly
 * shows the model a value that matches no screen id in this same prompt, and
 * a candidate that copies it into `screenId` silently fails to resolve later.
 * Resolve it here, by looking up the destination screen by its `urlTemplate`.
 */
function resolveTransitionTarget(transition: Transition, screens: Screen[]): string {
  if (transition.toScreenId === null) return "(externo)";
  const destination = screens.find((screen) => screen.urlTemplate === transition.toScreenId);
  return destination ? destination.id : `(sin resolver: ${transition.toScreenId})`;
}

export function scenarioCandidatesPrompt(map: AppMap): string {
  const screens = map.screens
    .map((screen) => {
      const probeValues = screen.probeValues;
      const texts = screen.texts.filter((text) => !isTainted(text, probeValues));
      const acciones = screen.locators
        .filter((l) => l.kind === "button" || l.kind === "link")
        .map((l) => l.accessibleName)
        .filter((name): name is string => name !== undefined && !isTainted(name, probeValues));
      const transitions = screen.transitions
        .filter((t) => !isTainted(t.locator, probeValues))
        .map((t) => `      ${t.locator} -> ${resolveTransitionTarget(t, map.screens)}`)
        .join("\n");
      return [
        `  - id: ${screen.id}  (ruta ${screen.urlTemplate})`,
        `    textos: ${JSON.stringify(texts)}`,
        `    acciones: ${JSON.stringify(acciones)}`,
        transitions.length > 0 ? `    transiciones:\n${transitions}` : "",
      ].filter((line) => line.length > 0).join("\n");
    })
    .join("\n");

  return `Eres un ingeniero de QA. Este es el mapa completo de una aplicación web, obtenido
recorriéndola con un navegador real:

${screens}

Propón los escenarios que merezca la pena automatizar como test. Céntrate en flujos
completos que ya estén demostrados por las transiciones del mapa; no inventes pantallas ni
textos que no aparezcan arriba.

Responde SOLO con un array JSON, sin texto alrededor, con esta forma exacta:
[{"id": "kebab-case", "title": "En inglés", "screenId": "id de la pantalla donde empieza",
  "involvedScreens": ["ids"], "rationale": "por qué merece la pena, en castellano"}]`;
}
