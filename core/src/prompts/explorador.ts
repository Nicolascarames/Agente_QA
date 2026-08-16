import type { AppMap } from "../appMap/schema.js";

export function scenarioCandidatesPrompt(map: AppMap): string {
  const screens = map.screens
    .map((screen) => {
      const texts = screen.texts.filter((text) => !screen.probeValues.includes(text));
      const transitions = screen.transitions.map((t) => `      ${t.locator} -> ${t.toScreenId ?? "(externo)"}`).join("\n");
      return [
        `  - id: ${screen.id}  (ruta ${screen.urlTemplate})`,
        `    textos: ${JSON.stringify(texts)}`,
        `    acciones: ${JSON.stringify(screen.locators.filter((l) => l.kind === "button" || l.kind === "link").map((l) => l.accessibleName))}`,
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
