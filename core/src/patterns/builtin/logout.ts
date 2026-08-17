import type { Pattern } from "../../schemas/pattern.js";

export const logoutPattern: Pattern = {
  name: "logout",
  description: "Cierre de sesión de un usuario autenticado",
  gherkinTemplate: `Feature: Cierre de sesión
  Como usuario autenticado
  Quiero cerrar sesión
  Para proteger mi cuenta en un dispositivo compartido

  @smoke
  Scenario: Logout desde el menú de usuario
    Given he iniciado sesión correctamente
    When abro el menú de usuario
    And pulso "Cerrar sesión"
    Then vuelvo a la pantalla de login
    And ya no puedo acceder a páginas privadas sin volver a iniciar sesión
`,
};
