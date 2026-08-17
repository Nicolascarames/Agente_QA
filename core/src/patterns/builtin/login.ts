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
};
