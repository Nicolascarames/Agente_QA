import type { Screen, WriteAction } from "./schema.js";

export const PASSWORD_NAME = /password|contrasena|contraseña|clave/i;

/** Mismo criterio que `realCrawler.ts` usa al decidir qué valor de prueba darle a un campo. */
export function looksLikeEmailField(fieldName: string): boolean {
  return /email|correo|user|usuario/i.test(fieldName);
}

/**
 * Si alguno de los campos de este envío parece una contraseña. Es el único
 * criterio del proyecto para "esto es un login": ni el propio Explorador ni
 * el emisor de Page Objects (que no puede importar Playwright) tienen otra
 * señal — un envío de credenciales siempre pide contraseña, y ningún otro
 * formulario de la aplicación debería hacerlo.
 */
export function hasPasswordField(screen: Screen, action: WriteAction): boolean {
  return action.formFields.some((fieldName) => {
    const field = screen.locators.find((l) => l.name === fieldName);
    return field?.accessibleName !== undefined && PASSWORD_NAME.test(field.accessibleName);
  });
}
