import type { Pattern } from "../../schemas/pattern.js";

export const passwordResetPattern: Pattern = {
  name: "password-reset",
  description: "Recuperación de contraseña olvidada por email",
  gherkinTemplate: `Feature: Recuperación de contraseña
  Como usuario que olvidó su contraseña
  Quiero solicitar un enlace de recuperación
  Para poder volver a acceder a mi cuenta

  @smoke
  Scenario: Solicitar recuperación con un email registrado
    Given estoy en la página de "contraseña olvidada"
    When introduzco el email de una cuenta existente
    And pulso el botón de enviar
    Then veo confirmación de que se ha enviado un email de recuperación
`,
  pageObjectTemplate: `class PasswordResetPage:
    def __init__(self, page):
        self.page = page
        self.email_input = page.get_by_label("Email")
        self.submit_button = page.get_by_role("button", name="Enviar")
        self.confirmation_message = page.get_by_text("Te hemos enviado un email")

    def goto(self, base_url: str):
        self.page.goto(f"{base_url}/password-reset")

    def request_reset(self, email: str):
        self.email_input.fill(email)
        self.submit_button.click()
`,
  navigationHints: {
    routeCandidates: ["/password-reset", "/forgot-password", "/reset-password"],
    requiresLogin: false,
  },
};
