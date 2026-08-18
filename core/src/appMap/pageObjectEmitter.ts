import { pythonLiteral } from "./pythonLiteral.js";
import { toSelfPageExpression } from "./pythonExpression.js";
import type { AppMap, LocatorEntry, Screen } from "./schema.js";
import { hasPasswordField, PASSWORD_NAME } from "./credentialFields.js";

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
 * Every method name a screen's emitted Page Object exposes: `goto` — with a
 * `(param: str, ...)` signature when it replays a `reachedBy` path whose
 * submit isn't a login, bare when the route has no variable segment, absent
 * otherwise — followed by get_ / fill_ / click_ / select_ per locator, in the
 * same order `emitPageObject` writes them. The code-generation prompt lists
 * these so the model can only call methods that really exist on the class it
 * is forbidden from writing itself.
 */
export function pageObjectMethodNames(screen: Screen, map: AppMap): string[] {
  const templated = screen.urlTemplate.includes(":");
  let gotoMethod: string[] = [];
  if (screen.reachedBy) {
    const { params } = reachedByGoto(screen, map);
    gotoMethod = [params.length > 0 ? `goto(${params.map((p) => `${p}: str`).join(", ")})` : "goto"];
  } else if (!templated) {
    gotoMethod = ["goto"];
  }
  const locatorMethodNames = screen.locators.flatMap(pageObjectMethodNamesForLocator);
  return [...gotoMethod, ...locatorMethodNames];
}

/**
 * El cuerpo de `goto()` para una vista sin URL propia: instancia el Page
 * Object de la pantalla direccionable más cercana y reproduce, en orden, cada
 * paso del camino que la alcanzó. Un envío de login se rellena con las
 * variables de entorno de siempre y no añade parámetros a `goto()` — la
 * misma convención que ya usan los tests generados. Un envío que NO es login
 * no tiene ningún dato de qué escribir: sus campos se convierten en
 * parámetros de `goto()`, en el mismo orden que declara el formulario.
 */
function reachedByGoto(
  screen: Screen,
  map: AppMap
): { params: string[]; body: string } {
  const reachedBy = screen.reachedBy!;
  const entry = map.screens.find((s) => s.id === reachedBy.entryScreenId);
  if (!entry) throw new Error(`La pantalla de entrada "${reachedBy.entryScreenId}" no existe en el mapa.`);
  const entryModule = `${entry.id.replace(/-/g, "_").replace(/~/g, "_")}_page`;

  const lines: string[] = [`entry = ${entry.className}(self.page)`, "entry.goto()"];
  const params: string[] = [];

  for (const step of reachedBy.path) {
    if (step.action === "click") {
      lines.push(`entry.click_${step.locator}()`);
      continue;
    }
    const action = entry.writeActions.find((a) => a.locator === step.locator);
    if (!action) throw new Error(`El paso de envío "${step.locator}" no tiene un writeAction en "${entry.id}".`);
    const isLogin = hasPasswordField(entry, action);
    for (const fieldName of action.formFields) {
      const field = entry.locators.find((l) => l.name === fieldName);
      const isPassword = field?.accessibleName !== undefined && PASSWORD_NAME.test(field.accessibleName);
      if (isLogin) {
        const envVar = isPassword ? "AGENTE_QA_TEST_PASSWORD" : "AGENTE_QA_TEST_USERNAME";
        lines.push(`entry.fill_${fieldName}(os.environ["${envVar}"])`);
      } else {
        params.push(fieldName);
        lines.push(`entry.fill_${fieldName}(${fieldName})`);
      }
    }
    lines.push(`entry.click_${step.locator}()`);
  }

  return {
    params,
    body: [`    from ${`pages.${entryModule}`} import ${entry.className}`, "", ...lines.map((l) => `    ${l}`)].join("\n"),
  };
}

/**
 * Mechanical template, no LLM: every locator expression is copied verbatim
 * from the map, where it was validated against a real browser. That is what
 * makes an invented locator structurally impossible.
 */
export function emitPageObject(screen: Screen, map: AppMap): { path: string; content: string } {
  const body = screen.locators.map(locatorMethods).join("\n\n");

  const templated = screen.urlTemplate.includes(":");
  let imports = "";
  let goto: string;

  if (screen.reachedBy) {
    const { params, body: gotoBody } = reachedByGoto(screen, map);
    const paramList = params.length > 0 ? `, ${params.map((p) => `${p}: str`).join(", ")}` : "";
    goto = `    def goto(self${paramList}) -> None:\n${gotoBody}`;
  } else if (templated) {
    // A route template with a variable segment (`/item/:id`) has no single URL to
    // navigate to: a generated `goto()` would request the literal `/item/:id` and
    // fail against a working application. The test picks the concrete URL itself.
    goto = `    # Sin goto(): la ruta tiene segmentos variables (${screen.urlTemplate}).
    # Navega desde el test a la URL concreta que quieras probar.`;
  } else {
    imports = "import os\n\n";
    goto = `    def goto(self) -> None:
        base = os.environ["AGENTE_QA_APP_URL"].rstrip("/")
        self.page.goto(base + self.URL_TEMPLATE)`;
  }

  // Un goto() que reproduce un camino con un envío de login lee credenciales
  // de os.environ igual que el goto() de base — necesita el mismo import.
  if (screen.reachedBy && goto.includes("os.environ")) imports = "import os\n\n";

  const writesRealData = screen.reachedBy?.path.some((step) => step.action === "submit") ?? false;
  const writeWarning = writesRealData
    ? "# ATENCIÓN: goto() de esta pantalla envía un formulario real cada vez que se llama —\n# cada ejecución del test escribe datos nuevos en la aplicación bajo prueba.\n"
    : "";

  const content = `# GENERADO por agente-qa desde .agente-qa/map/map.json — NO EDITAR A MANO
# Las correcciones manuales van en .agente-qa/map/overrides.json
# Pantalla: ${screen.id}  ·  ruta: ${screen.urlTemplate}
${writeWarning}${imports}from playwright.sync_api import Locator, Page


class ${screen.className}:
    URL_TEMPLATE = ${pythonLiteral(screen.urlTemplate)}

    def __init__(self, page: Page):
        self.page = page

${goto}

${body}
`;
  return { path: `pages/${screen.id.replace(/-/g, "_").replace(/~/g, "_")}_page.py`, content };
}
