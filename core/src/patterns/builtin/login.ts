import type { Pattern } from "../../schemas/pattern.js";

export const loginPattern: Pattern = {
  name: "login",
  description: "Inicio de sesión con credenciales válidas e inválidas",
  gherkinTemplate: `Feature: Inicio de sesión
  Como usuario registrado
  Quiero iniciar sesión con mis credenciales
  Para acceder a mi cuenta

  @smoke
  Scenario: Login con credenciales válidas
    Given estoy en la página de login
    When introduzco un usuario y contraseña válidos
    And pulso el botón de iniciar sesión
    Then accedo a mi área privada

  @regression
  Scenario: Login con credenciales inválidas
    Given estoy en la página de login
    When introduzco un usuario o contraseña incorrectos
    And pulso el botón de iniciar sesión
    Then veo un mensaje de error de credenciales inválidas
`,
  pageObjectTemplate: `class LoginPage:
    def __init__(self, page):
        self.page = page
        self.username_input = page.get_by_label("Usuario")
        self.password_input = page.get_by_label("Contraseña")
        self.submit_button = page.get_by_role("button", name="Iniciar sesión")
        self.error_message = page.get_by_role("alert")

    def goto(self, base_url: str):
        self.page.goto(f"{base_url}/login")

    def login(self, username: str, password: str):
        self.username_input.fill(username)
        self.password_input.fill(password)
        self.submit_button.click()
`,
  // requiresLogin: true means "the explorer must perform a real login to capture all
  // screens this pattern needs" — for login itself, that includes the post-login screen
  // (e.g. to ground "accedo a mi área privada" assertions in a real snapshot).
  navigationHints: {
    routeCandidates: ["/login", "/signin", "/sign-in", "/"],
    requiresLogin: true,
    negativeProbe: { kind: "invalid-credentials" },
  },
};
