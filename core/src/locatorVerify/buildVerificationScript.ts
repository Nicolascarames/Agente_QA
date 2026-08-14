import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { LocatorCheck } from "./locatorVerifier.js";

export function buildVerificationScript(files: GeneratedFile[], checks: LocatorCheck[], baseUrl: string): string {
  const pageObjectFile = files.find((f) => f.path.startsWith("pages/"));
  const pageObjectPath = pageObjectFile ? pageObjectFile.path : "";

  return `import importlib.util
import inspect
import json

from playwright.sync_api import sync_playwright

BASE_URL = ${JSON.stringify(baseUrl)}
CHECKS = ${JSON.stringify(checks, null, 2)}
PAGE_OBJECT_PATH = ${JSON.stringify(pageObjectPath)}


def load_page_object_classes(module_path):
    if not module_path:
        return []
    spec = importlib.util.spec_from_file_location("generated_page_object", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return [
        obj
        for _, obj in inspect.getmembers(module, inspect.isclass)
        if obj.__module__ == "generated_page_object"
    ]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(BASE_URL)

        classes = load_page_object_classes(PAGE_OBJECT_PATH)
        instances = [cls(page) for cls in classes]

        for check in CHECKS:
            method_name = check["method"]
            argument = check["argument"]
            target = None
            for instance in instances:
                if hasattr(instance, method_name):
                    target = getattr(instance, method_name)
                    break
            if target is None:
                print(json.dumps({
                    "method": method_name,
                    "argument": argument,
                    "error": f"no se encontro el metodo {method_name} en ningun Page Object generado",
                }))
                continue

            locator = target(argument)
            count = locator.count()
            entry = {"method": method_name, "argument": argument, "count": count}
            if count != 1:
                matches = []
                for element in locator.all()[:5]:
                    try:
                        matches.append(element.evaluate("el => el.outerHTML")[:200])
                    except Exception:
                        matches.append("<no se pudo leer outerHTML>")
                entry["matches"] = matches
            print(json.dumps(entry))

        browser.close()


if __name__ == "__main__":
    main()
`;
}
