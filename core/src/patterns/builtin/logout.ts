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
  pageObjectTemplate: `class LogoutFlow:
    def __init__(self, page):
        self.page = page
        self.user_menu_button = page.get_by_role("button", name="Menú de usuario")
        self.logout_option = page.get_by_role("menuitem", name="Cerrar sesión")

    def logout(self):
        self.user_menu_button.click()
        self.logout_option.click()
`,
};
