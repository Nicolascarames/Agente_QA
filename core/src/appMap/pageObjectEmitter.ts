import { pythonLiteral } from "./pythonLiteral.js";
import { toSelfPageExpression } from "./pythonExpression.js";
import type { LocatorEntry, Screen } from "./schema.js";

const FILLABLE: LocatorEntry["kind"][] = ["input"];
const CLICKABLE: LocatorEntry["kind"][] = ["button", "link"];

type MethodPrefix = "get" | "fill" | "click" | "select";

/**
 * Which method prefixes a locator's `kind` earns — the single source for the
 * get_ / fill_ / click_ / select_ naming rules. Both `locatorMethods` (which
 * emits the Page Object's Python) and `pageObjectMethodNames` (which the
 * code-generation prompt uses to tell the model what it may call) read this,
 * so the emitted class and the prompt's promised method list cannot drift
 * apart the way they already have once in this project.
 */
function methodPrefixesFor(locator: LocatorEntry): MethodPrefix[] {
  const prefixes: MethodPrefix[] = ["get"];
  if (FILLABLE.includes(locator.kind)) prefixes.push("fill");
  if (CLICKABLE.includes(locator.kind)) prefixes.push("click");
  if (locator.kind === "select") prefixes.push("select");
  return prefixes;
}

function locatorMethods(locator: LocatorEntry): string {
  const stateNote = locator.stateId ? `        # solo visible en el estado: ${locator.stateId}\n` : "";
  const lines = [
    `    def get_${locator.name}(self) -> Locator:`,
    stateNote.trimEnd(),
    `        return ${toSelfPageExpression(locator.python)}`,
  ].filter((line) => line.length > 0);

  for (const prefix of methodPrefixesFor(locator)) {
    if (prefix === "get") continue; // already emitted above
    if (prefix === "fill") {
      lines.push(
        "",
        `    def fill_${locator.name}(self, value: str) -> None:`,
        `        self.get_${locator.name}().fill(value)`
      );
    } else if (prefix === "click") {
      lines.push(
        "",
        `    def click_${locator.name}(self) -> None:`,
        `        self.get_${locator.name}().click()`
      );
    } else if (prefix === "select") {
      lines.push(
        "",
        `    def select_${locator.name}(self, value: str) -> None:`,
        `        self.get_${locator.name}().select_option(value)`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Every Page Object method name ONE locator earns — `get_<name>` always, plus
 * `fill_<name>` / `click_<name>` / `select_<name>` per its `kind`, in the same
 * order `emitPageObject` writes them. The single place anything outside this
 * module (the CLI's ambiguity prompt, in particular) may ask "what can I call
 * on this locator" without re-deriving the kind→prefix rule itself.
 */
export function pageObjectMethodNamesForLocator(locator: LocatorEntry): string[] {
  return methodPrefixesFor(locator).map((prefix) => `${prefix}_${locator.name}`);
}

/**
 * Every method name a screen's emitted Page Object exposes: `goto` (only when
 * the route has no variable segment) followed by get_ / fill_ / click_ / select_
 * per locator, in the same order `emitPageObject` writes them. The
 * code-generation prompt lists these so the model can only call methods that
 * really exist on the class it is forbidden from writing itself.
 */
export function pageObjectMethodNames(screen: Screen): string[] {
  const templated = screen.urlTemplate.includes(":");
  const gotoMethod = templated ? [] : ["goto"];
  const locatorMethodNames = screen.locators.flatMap(pageObjectMethodNamesForLocator);
  return [...gotoMethod, ...locatorMethodNames];
}

/**
 * Mechanical template, no LLM: every locator expression is copied verbatim
 * from the map, where it was validated against a real browser. That is what
 * makes an invented locator structurally impossible.
 */
export function emitPageObject(screen: Screen): { path: string; content: string } {
  const body = screen.locators.map(locatorMethods).join("\n\n");

  // A route template with a variable segment (`/item/:id`) has no single URL to
  // navigate to: a generated `goto()` would request the literal `/item/:id` and
  // fail against a working application. The test picks the concrete URL itself.
  const templated = screen.urlTemplate.includes(":");
  const imports = templated ? "" : "import os\n\n";
  const goto = templated
    ? `    # Sin goto(): la ruta tiene segmentos variables (${screen.urlTemplate}).
    # Navega desde el test a la URL concreta que quieras probar.`
    : `    def goto(self) -> None:
        base = os.environ["AGENTE_QA_APP_URL"].rstrip("/")
        self.page.goto(base + self.URL_TEMPLATE)`;

  const content = `# GENERADO por agente-qa desde .agente-qa/map/map.json — NO EDITAR A MANO
# Las correcciones manuales van en .agente-qa/map/overrides.json
# Pantalla: ${screen.id}  ·  ruta: ${screen.urlTemplate}
${imports}from playwright.sync_api import Locator, Page


class ${screen.className}:
    URL_TEMPLATE = ${pythonLiteral(screen.urlTemplate)}

    def __init__(self, page: Page):
        self.page = page

${goto}

${body}
`;
  return { path: `pages/${screen.id.replace(/-/g, "_")}_page.py`, content };
}
