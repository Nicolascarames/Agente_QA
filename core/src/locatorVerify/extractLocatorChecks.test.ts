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
      '    Then debo ver un mensaje de error "<mensaje_error>"',
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

    expect(result.checks).toEqual([{ method: "get_error_message", argument: "<mensaje_error>" }]);
    expect(result.skipped).toEqual([]);
  });

  it("skips a placeholder in a Scenario Outline with an empty Examples table (header but no data rows)", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario Outline: fallos",
      '    Then debo ver un mensaje de error "<mensaje_error>"',
      "",
      "    Examples:",
      "      | mensaje_error |",
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
});

describe("extractLocatorChecks — action-method delegation and untraceable params", () => {
  it("resolves an action method that delegates to a paired get_* method with the same bare parameter", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When pulso el botón "Log In"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('pulso el botón "{button_name}"'))
def pulsar_boton(page, button_name):
    login_page = LoginPage(page)
    login_page.click_button(button_name)
`;
    const pageObject = `class LoginPage:
    def get_button(self, button_name):
        return self.page.get_by_role("button", name=button_name, exact=False)

    def click_button(self, button_name):
        self.get_button(button_name).click()
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([{ method: "get_button", argument: "Log In" }]);
    expect(result.skipped).toEqual([]);
  });

  it("does not flag a plain action method that never delegates to any get_* as a gap", () => {
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

  it("surfaces a visible skip reason (not a silent drop) when the step parameter is transformed before being passed on", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When pulso el botón "Log In"',
      "",
    ].join("\n");

    // Realistic, unremarkable LLM output: normalizes whitespace before use —
    // nothing exotic, but it breaks the bare-identifier convention the
    // cross-reference relies on.
    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('pulso el botón "{button_name}"'))
def pulsar_boton(page, button_name):
    login_page = LoginPage(page)
    nombre_normalizado = button_name.strip()
    login_page.click_button(nombre_normalizado)
`;
    const pageObject = `class LoginPage:
    def get_button(self, button_name):
        return self.page.get_by_role("button", name=button_name, exact=False)

    def click_button(self, button_name):
        self.get_button(button_name).click()
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("button_name");
  });

  it("surfaces a visible skip reason (not a silent drop) when the Page Object's action method delegates to a get_* call, but the delegated get_* is invoked with a DIFFERENT parameter name than the step-def's own parameter", () => {
    // This is exactly the shape of the spec's own headline example
    // (click_button/get_button): the Page Object's action method names its
    // own parameter independently of the step-def's parameter name — nothing
    // ties them together syntactically, so the cross-reference must surface
    // the gap rather than silently treating it like a plain fill_* action.
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When pulso el botón "Log In"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('pulso el botón "{nombre_boton}"'))
def pulsar_boton(page, nombre_boton):
    login_page = LoginPage(page)
    login_page.click_button(nombre_boton)
`;
    // click_button's OWN parameter is named button_name, not nombre_boton —
    // the delegated self.get_button(button_name) call never mentions
    // "nombre_boton" verbatim, even though this is a legitimate delegation.
    const pageObject = `class LoginPage:
    def get_button(self, button_name):
        return self.page.get_by_role("button", name=button_name, exact=False)

    def click_button(self, button_name):
        self.get_button(button_name).click()
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("click_button");
    expect(result.skipped[0]).toContain("nombre_boton");
  });
});

describe("extractLocatorChecks — page fixture calls are not Page Object methods", () => {
  it("does not treat expect(page.get_by_text(...)) in an assertion step as a Page Object get_* call to verify", () => {
    // Playwright's own SDK uses the identical get_by_* naming convention this
    // project's convention uses for Page Object locator methods. A plain
    // assertion step calling the raw `page` fixture directly must not be
    // mistaken for a Page Object method — the real verification harness has
    // no such method on any generated class.
    const featureText = [
      "Feature: Login",
      "  Scenario: fail",
      '    Then debo ver un mensaje de error "Credenciales incorrectas"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, then
from playwright.sync_api import expect

@then(parsers.parse('debo ver un mensaje de error "{mensaje_error}"'))
def verificar(page, mensaje_error):
    expect(page.get_by_text(mensaje_error)).to_be_visible()
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, message):
        return self.page.get_by_text(message)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("still resolves a legitimate call through a receiver that merely contains the substring 'page' (e.g. login_page), not just exact 'page'", () => {
    const featureText = [
      "Feature: Login",
      "  Scenario: ok",
      '    When pulso el botón "Log In"',
      "",
    ].join("\n");

    const stepDefs = `from pytest_bdd import parsers, when

@when(parsers.parse('pulso el botón "{button_name}"'))
def pulsar_boton(page, button_name):
    login_page = LoginPage(page)
    login_page.get_button(button_name)
`;
    const pageObject = `class LoginPage:
    def get_button(self, button_name):
        return self.page.get_by_role("button", name=button_name, exact=False)
`;

    const result = extractLocatorChecks(featureText, files(stepDefs, pageObject));

    expect(result.checks).toEqual([{ method: "get_button", argument: "Log In" }]);
    expect(result.skipped).toEqual([]);
  });
});

describe("extractLocatorChecks — parsers.re step definitions", () => {
  it("extracts checks from a parsers.re step definition", () => {
    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.re(r'veo el mensaje de error "(?P<mensaje_error>[^"]*)"'))
def veo_el_mensaje(login_page, mensaje_error):
    expect(login_page.get_error_message(mensaje_error)).to_be_visible()
`;
    const pageObject = `class LoginPage:
    def get_error_message(self, mensaje_error):
        return self.page.get_by_text(mensaje_error)
`;
    const feature = `Feature: Login
  Scenario: error
    Then veo el mensaje de error "Credenciales inválidas"
`;
    const result = extractLocatorChecks(feature, [
      { path: "tests/test_login.py", content: stepDefs },
      { path: "pages/login_page.py", content: pageObject },
    ]);
    expect(result.checks).toEqual([
      { method: "get_error_message", argument: "Credenciales inválidas" },
    ]);
  });

  it("resolves Scenario Outline rows with empty cells through a parsers.re step", () => {
    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.re(r'veo el mensaje de validación "(?P<mensaje>[^"]*)"'))
def veo_validacion(login_page, mensaje):
    expect(login_page.get_validation_message(mensaje)).to_be_visible()
`;
    const pageObject = `class LoginPage:
    def get_validation_message(self, mensaje):
        return self.page.get_by_text(mensaje)
`;
    const feature = `Feature: Login
  Scenario Outline: validación
    Then veo el mensaje de validación "<mensaje>"

    Examples:
      | mensaje            |
      | Email obligatorio  |
      |                    |
`;
    const result = extractLocatorChecks(feature, [
      { path: "tests/test_login.py", content: stepDefs },
      { path: "pages/login_page.py", content: pageObject },
    ]);
    expect(result.checks).toEqual([
      { method: "get_validation_message", argument: "Email obligatorio" },
      { method: "get_validation_message", argument: "" },
    ]);
  });

  it("rejects a parsers.re step-def whose regex is invalid in JavaScript, without throwing", () => {
    // (?P=name) is Python's backreference syntax — our rewrite only handles
    // the (?P<name>...) opening syntax, so this is left untouched and fails
    // to compile as a JS RegExp.
    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.re(r'veo el color "(?P<color>[^"]*)" repetido (?P=color)'))
def veo_el_color(login_page, color):
    expect(login_page.get_color_message(color)).to_be_visible()
`;
    const pageObject = `class LoginPage:
    def get_color_message(self, color):
        return self.page.get_by_text(color)
`;
    const feature = `Feature: Colores
  Scenario: repetido
    Then veo el color "rojo" repetido rojo
`;
    const generatedFiles = [
      { path: "tests/test_login.py", content: stepDefs },
      { path: "pages/login_page.py", content: pageObject },
    ];

    expect(() => extractLocatorChecks(feature, generatedFiles)).not.toThrow();

    const result = extractLocatorChecks(feature, generatedFiles);
    expect(result.checks).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("veo el color");
  });

  it("rejects a parsers.re step-def with a bare capturing group alongside a named one, instead of returning a misaligned argument", () => {
    // (rojo|azul) is a bare capturing group an LLM might write instead of the
    // non-capturing (?:rojo|azul). If the group count weren't checked, the
    // named group "mensaje" would wrongly capture match[1] ("rojo") instead
    // of match[2] (the real message) — a plausible-looking but wrong check.
    const stepDefs = `from pytest_bdd import parsers, then

@then(parsers.re(r'el color es (rojo|azul) y el mensaje es "(?P<mensaje>[^"]*)"'))
def veo_color_y_mensaje(login_page, mensaje):
    expect(login_page.get_message(mensaje)).to_be_visible()
`;
    const pageObject = `class LoginPage:
    def get_message(self, mensaje):
        return self.page.get_by_text(mensaje)
`;
    const feature = `Feature: Colores
  Scenario: color y mensaje
    Then el color es rojo y el mensaje es "Operación completada"
`;
    const result = extractLocatorChecks(feature, [
      { path: "tests/test_login.py", content: stepDefs },
      { path: "pages/login_page.py", content: pageObject },
    ]);
    expect(result.checks).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("el color es");
  });

  it("extracts two named groups from a parsers.re step in the correct order", () => {
    const stepDefs = `from pytest_bdd import parsers, given

@given(parsers.re(r'inicio sesión con usuario "(?P<usuario>[^"]*)" y contraseña "(?P<contraseña>[^"]*)"'))
def inicio_sesion(login_page, usuario, contraseña):
    login_page.get_usuario_label(usuario)
    login_page.get_contraseña_label(contraseña)
`;
    const pageObject = `class LoginPage:
    def get_usuario_label(self, usuario):
        return self.page.get_by_text(usuario)

    def get_contraseña_label(self, contraseña):
        return self.page.get_by_text(contraseña)
`;
    const feature = `Feature: Login
  Scenario: doble
    Given inicio sesión con usuario "ana" y contraseña "1234"
`;
    const result = extractLocatorChecks(feature, [
      { path: "tests/test_login.py", content: stepDefs },
      { path: "pages/login_page.py", content: pageObject },
    ]);
    expect(result.checks).toEqual([
      { method: "get_usuario_label", argument: "ana" },
      { method: "get_contraseña_label", argument: "1234" },
    ]);
    expect(result.skipped).toEqual([]);
  });
});
