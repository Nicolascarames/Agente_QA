import { describe, it, expect } from "vitest";
import { extractLocatorChecks } from "./extractLocatorChecks.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

function files(stepDefsContent: string, pageObjectContent: string): GeneratedFile[] {
  return [
    { path: "tests/test_login.py", content: stepDefsContent },
    { path: "pages/login_page.py", content: pageObjectContent },
  ];
}

describe("extractLocatorChecks — direct get_* mapping", () => {
  it("maps a literal that flows unmodified into a get_* method to a LocatorCheck", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: fail",
      "    When introduzco el correo electrónico \"x\"",
      '    Then debo ver un mensaje de error "Correo o contraseña incorrectos"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([
      { method: "get_error_message", argument: "Correo o contraseña incorrectos" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("handles unicode parameter names (ñ, tildes) that a plain \\w regex would miss", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: fail",
      '    Then debo ver el mensaje de validación "La contraseña es obligatoria"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver el mensaje de validación "{mensaje_validacion}"'))
def verificar_mensaje_validacion(page, mensaje_validacion):
    login_page = LoginPage(page)
    login_page.get_validation_message(mensaje_validacion)
`;
    const pageObject = `class LoginPage:
    def get_validation_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([
      { method: "get_validation_message", argument: "La contraseña es obligatoria" },
    ]);
  });

  it("extracts locator checks when placeholder names themselves use unicode (ñ, tildes)", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: secure",
      '    When introduzco la contraseña "mi_contraseña_123"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('introduzco la contraseña "{contraseña}"'))
def introducir_contraseña(page, contraseña):
    login_page = LoginPage(page)
    login_page.get_password_input(contraseña)
`;
    const pageObject = `class LoginPage:
    def get_password_input(self, password):
        return self.page.get_by_placeholder(password)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([
      { method: "get_password_input", argument: "mi_contraseña_123" },
    ]);
  });

  it("produces no checks for a step whose literal flows into a plain action method (fill_*), not a get_* method", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When introduzco el correo electrónico "usuario@ejemplo.com"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('introduzco el correo electrónico "{correo}"'))
def introducir_correo(page, correo):
    login_page = LoginPage(page)
    login_page.fill_email(correo)
`;
    const pageObject = `class LoginPage:
    def fill_email(self, email):
        self.email_input.fill(email)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("returns no checks when the two expected files aren't present", () => {
    const result = extractLocatorChecks("Feature: X\n", [{ path: "weird.py", content: "" }]);
    expect(result).toEqual({ checks: [], skipped: [] });
  });
});

describe("extractLocatorChecks — Scenario Outline resolution", () => {
  it("resolves an Outline placeholder to one LocatorCheck per Examples row", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario Outline: fallos",
      '    When introduzco el correo electrónico "<correo>"',
      '    Then debo ver un mensaje de error "<mensaje_error>"',
      "",
      "    Examples:",
      "      | correo                     | mensaje_error                    |",
      "      | usuario.valido@ejemplo.com | Correo o contraseña incorrectos  |",
      "      | no.registrado@ejemplo.com  | Correo o contraseña incorrectos  |",
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([
      { method: "get_error_message", argument: "Correo o contraseña incorrectos" },
      { method: "get_error_message", argument: "Correo o contraseña incorrectos" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("resolves distinct values per row, not just a repeated one", () => {
    const featureText = [
      "Feature: Validación",
      "  Scenario Outline: validaciones",
      '    Then debo ver el mensaje de validación "<mensaje_validacion>"',
      "",
      "    Examples:",
      "      | mensaje_validacion                       |",
      "      | El correo electrónico es obligatorio     |",
      "      | La contraseña es obligatoria              |",
      "      | Formato de correo electrónico no válido   |",
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver el mensaje de validación "{mensaje_validacion}"'))
def verificar_mensaje_validacion(page, mensaje_validacion):
    login_page = LoginPage(page)
    login_page.get_validation_message(mensaje_validacion)
`;
    const pageObject = `class LoginPage:
    def get_validation_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks.map((c) => c.argument)).toEqual([
      "El correo electrónico es obligatorio",
      "La contraseña es obligatoria",
      "Formato de correo electrónico no válido",
    ]);
  });

  it("skips (with a visible reason) a placeholder-shaped literal whose column isn't in the Examples header", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario Outline: fallos",
      '    Then debo ver un mensaje de error "<mensaje_error>"',
      "",
      "    Examples:",
      "      | otra_columna |",
      "      | x            |",
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("mensaje_error");
  });

  it("does not treat a literal that merely looks like <this> as a placeholder outside a Scenario Outline", () => {
    const featureText = [
      "Feature: X",
      "  Scenario: normal",
      '    Then debo ver un mensaje de error "<sin-outline>"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar_mensaje_error(page, mensaje_error):
    login_page = LoginPage(page)
    login_page.get_error_message(mensaje_error)
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([{ method: "get_error_message", argument: "<sin-outline>" }]);
    expect(result.skipped).toEqual([]);
  });
});
