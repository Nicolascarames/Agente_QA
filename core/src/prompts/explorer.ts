export function explorerActionPrompt(
  featureText: string,
  currentUrl: string,
  ariaSnapshot: string,
  hasCredentials: boolean
): string {
  const credentialsNote = hasCredentials
    ? 'Hay credenciales de una cuenta de prueba disponibles: puedes pedir rellenarlas con la acción "fill_credential" (nunca escribas el valor real, solo indica qué campo: "username" o "password").'
    : "No hay credenciales de prueba configuradas: no pidas rellenar ningún campo de usuario/contraseña.";

  return `Eres un explorador de interfaces web. Tu objetivo es completar, en la aplicación real, el flujo descrito por este escenario Gherkin:
"""
${featureText}
"""

Estás en la URL: ${currentUrl}

Esto es lo que hay en la pantalla ahora mismo (snapshot de accesibilidad: rol y nombre accesible de cada elemento visible):
"""
${ariaSnapshot}
"""

${credentialsNote}

Responde ÚNICAMENTE con un objeto JSON (sin explicación, sin bloques de código markdown) con una de estas formas exactas:
- {"action": "goto", "target": "<ruta o URL a la que navegar>"}
- {"action": "click", "role": "button" | "link" | "menuitem" | "tab" | "checkbox", "name": "<nombre accesible exacto visto en el snapshot>"}
- {"action": "fill_credential", "labelText": "<label o nombre accesible exacto del campo>", "field": "username" | "password"}
- {"action": "done"} — cuando la pantalla actual ya representa el estado final del escenario
- {"action": "fail", "reason": "<por qué no se puede continuar>"} — cuando la pantalla actual no permite seguir`;
}
