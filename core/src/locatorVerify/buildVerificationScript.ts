import type { GeneratedFile } from "../agents/generador/codeGenerator.js";
import type { LocatorCheck } from "./locatorVerifier.js";

export function buildVerificationScript(files: GeneratedFile[], checks: LocatorCheck[], urls: string[]): string {
  const pageObjectFile = files.find((f) => f.path.startsWith("pages/"));
  const pageObjectPath = pageObjectFile ? pageObjectFile.path : "";

  return `import importlib.util
import inspect
import json

from playwright.sync_api import sync_playwright

URLS = ${JSON.stringify(urls, null, 2)}
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
    results = [
        {"method": check["method"], "argument": check["argument"], "count": 0, "matches": []}
        for check in CHECKS
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        classes = load_page_object_classes(PAGE_OBJECT_PATH)
        instances = []
        for cls in classes:
            try:
                instances.append(cls(page))
            except Exception:
                pass

        for url in URLS:
            try:
                # networkidle as a goto condition hangs for the full 30s default on
                # apps with a persistent connection (websockets, chat widgets,
                # analytics). Load first, then give the hydration a short window.
                page.goto(url, wait_until="load")
            except Exception:
                # A url that fails to load (timeout, an SPA route that 404s
                # on direct navigation, a stale post-login url) must not
                # abort the whole run: the other urls may still resolve
                # every check, and aborting here would zero out results
                # that already succeeded on an earlier url.
                continue
            try:
                page.wait_for_load_state("networkidle", timeout=3000)
            except Exception:
                pass

            for index, check in enumerate(CHECKS):
                method_name = check["method"]
                argument = check["argument"]
                target = None
                for instance in instances:
                    if hasattr(instance, method_name):
                        target = getattr(instance, method_name)
                        break
                if target is None:
                    if results[index]["count"] == 0:
                        results[index]["error"] = (
                            f"no se encontro el metodo {method_name} en ningun Page Object generado"
                        )
                    continue

                try:
                    locator = target(argument)
                    count = locator.count()
                    # A successful resolution on this url means the check is
                    # verifiable here, so drop any error recorded on an
                    # earlier url — a check that failed on screen 1 but
                    # resolves on screen 2 must not be reported as a
                    # failure (same "any captured screen" rule as count).
                    results[index].pop("error", None)
                    if count > results[index]["count"]:
                        results[index]["count"] = count
                        matches = []
                        if count != 1:
                            for element in locator.all()[:5]:
                                try:
                                    matches.append(element.evaluate("el => el.outerHTML")[:200])
                                except Exception:
                                    matches.append("<no se pudo leer outerHTML>")
                        results[index]["matches"] = matches
                except Exception as e:
                    if results[index]["count"] == 0:
                        results[index]["error"] = f"error al verificar el locator: {e}"

        browser.close()

    for entry in results:
        print(json.dumps(entry))


if __name__ == "__main__":
    main()
`;
}
