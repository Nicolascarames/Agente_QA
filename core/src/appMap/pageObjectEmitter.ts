import type { LocatorEntry, Screen } from "./schema.js";

const FILLABLE: LocatorEntry["kind"][] = ["input"];
const CLICKABLE: LocatorEntry["kind"][] = ["button", "link"];

function locatorMethods(locator: LocatorEntry): string {
  const stateNote = locator.stateId ? `        # solo visible en el estado: ${locator.stateId}\n` : "";
  const lines = [
    `    def get_${locator.name}(self) -> Locator:`,
    stateNote.trimEnd(),
    `        return self.${locator.python}`,
  ].filter((line) => line.length > 0);

  if (FILLABLE.includes(locator.kind)) {
    lines.push(
      "",
      `    def fill_${locator.name}(self, value: str) -> None:`,
      `        self.get_${locator.name}().fill(value)`
    );
  }
  if (CLICKABLE.includes(locator.kind)) {
    lines.push(
      "",
      `    def click_${locator.name}(self) -> None:`,
      `        self.get_${locator.name}().click()`
    );
  }
  if (locator.kind === "select") {
    lines.push(
      "",
      `    def select_${locator.name}(self, value: str) -> None:`,
      `        self.get_${locator.name}().select_option(value)`
    );
  }
  return lines.join("\n");
}

/**
 * Mechanical template, no LLM: every locator expression is copied verbatim
 * from the map, where it was validated against a real browser. That is what
 * makes an invented locator structurally impossible.
 */
export function emitPageObject(screen: Screen): { path: string; content: string } {
  const body = screen.locators.map(locatorMethods).join("\n\n");
  const content = `# GENERADO por agente-qa desde .agente-qa/map/map.json — NO EDITAR A MANO
# Las correcciones manuales van en .agente-qa/map/overrides.json
# Pantalla: ${screen.id}  ·  ruta: ${screen.urlTemplate}
import os

from playwright.sync_api import Locator, Page


class ${screen.className}:
    URL_TEMPLATE = "${screen.urlTemplate}"

    def __init__(self, page: Page):
        self.page = page

    def goto(self) -> None:
        base = os.environ["AGENTE_QA_APP_URL"].rstrip("/")
        self.page.goto(base + self.URL_TEMPLATE)

${body}
`;
  return { path: `pages/${screen.id.replace(/-/g, "_")}_page.py`, content };
}
