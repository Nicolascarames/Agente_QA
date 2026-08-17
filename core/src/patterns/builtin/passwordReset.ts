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
};
