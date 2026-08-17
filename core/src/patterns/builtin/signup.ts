import type { Pattern } from "../../schemas/pattern.js";

export const signupPattern: Pattern = {
  name: "signup",
  description: "Registro de una cuenta nueva",
  gherkinTemplate: `Feature: Registro de usuario
  Como visitante nuevo
  Quiero crear una cuenta
  Para poder usar la aplicación

  @smoke
  Scenario: Registro con datos válidos
    Given estoy en la página de registro
    When relleno el formulario con datos válidos y únicos
    And pulso el botón de crear cuenta
    Then veo confirmación de que mi cuenta se ha creado
    And puedo iniciar sesión con las credenciales recién creadas

  @regression
  Scenario: Registro con un email ya existente
    Given estoy en la página de registro
    When relleno el formulario con un email ya registrado
    And pulso el botón de crear cuenta
    Then veo un mensaje de error indicando que el email ya existe
`,
};
