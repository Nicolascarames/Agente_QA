import type { AppMap } from "../appMap/schema.js";
import { findScreen } from "../appMap/mapQuery.js";
import { pageObjectMethodNames } from "../appMap/pageObjectEmitter.js";

export interface CodeGenerationNaming {
  slug: string;
  featureFileName: string;
}

export interface CodeGenerationEvidence {
  stepText: string;
  url: string;
  ariaSnapshot: string;
}

export interface CodeGenerationRetry {
  previousFiles: { path: string; content: string }[];
  feedback: string;
}

export function codeGenerationPrompt(
  featureText: string,
  map: AppMap,
  screenId: string,
  naming: CodeGenerationNaming,
  retry?: CodeGenerationRetry
): string {
  const screen = findScreen(map, screenId);
  if (!screen) throw new Error(`La pantalla "${screenId}" no existe en el mapa.`);

  // Mirrors the path convention `emitPageObject` (core/src/appMap/pageObjectEmitter.ts)
  // actually writes to: `pages/${screen.id.replace(/-/g, "_")}_page.py`.
  const moduleName = `${screen.id.replace(/-/g, "_")}_page`;
  const modulePath = `pages.${moduleName}`;

  const methods = pageObjectMethodNames(screen);
  const methodsList =
    methods.length > 0 ? methods.map((name) => `  - ${name}`).join("\n") : "  (ninguno)";

  const retrySection = retry
    ? `\n\nEl intento anterior generó este código:
"""
${retry.previousFiles.map((f) => `# FILE: ${f.path}\n${f.content}`).join("\n")}
"""

Pero no pasó la verificación de calidad. Corrige exactamente este error, manteniendo el resto del código igual siempre que sea posible:
"""
${retry.feedback}
"""`
    : "";

  return `Eres un ingeniero de QA experto en Playwright + Python + pytest-bdd.

Dado este archivo Gherkin ya aprobado, ubicado en "features/${naming.featureFileName}":
"""
${featureText}
"""

Este escenario transcurre en la pantalla "${screen.name}" del mapa de la aplicación,
recorrida con un navegador real. Su Page Object ya existe — se generó mecánicamente a
partir del mapa y cada localizador que contiene fue validado contra la aplicación real.
Se llama "${screen.className}" y está definido en "${moduleName}.py" dentro de "pages/";
impórtalo así:
"""
from ${modulePath} import ${screen.className}
"""

"pages/" se genera automáticamente a partir del mapa: NUNCA escribas ni edites ningún
archivo bajo "pages/". Tu única salida es el step definition, bajo "tests/".

Estos son los ÚNICOS métodos que "${screen.className}" expone — no puedes llamar a
ningún otro método de esa clase:

${methodsList}

Convención de cada método, según su prefijo: "get_*" devuelve un "Locator" y no actúa
sobre él; "fill_*" y "select_*" reciben un único argumento "value: str"; "click_*" y
"goto" no reciben ningún argumento.

Un step definition NUNCA construye su propio localizador ni resuelve un elemento de la
pantalla llamando directamente a un método de "page" con un selector, un rol o un texto:
nada de "page.get_by_...(...)", "page.locator(...)", "page.click(...)", "page.fill(...)",
"page.wait_for_selector(...)", "page.query_selector(...)" ni ningún otro método de "page"
que localice o interactúe con un elemento concreto de la pantalla. Todo elemento se
obtiene SIEMPRE a través de uno de los métodos de arriba. Lo único que sigue permitido
directamente sobre "page" es lo que no localiza ningún elemento: navegar ("page.goto(...)"),
leer la propia página ("page.url") y las aserciones sobre la página en sí, por ejemplo
"expect(page).to_have_url(...)".

El proyecto ya tiene instalado el plugin "pytest-playwright": el fixture "page" (una página de navegador ya lista) está disponible automáticamente en cualquier test, no lo definas tú ni escribas ningún conftest.py.

Para los parámetros de un step que van entre comillas en el Gherkin, usa SIEMPRE "parsers.re" con un grupo con nombre que admita el valor vacío, nunca la forma con llaves: esa forma exige al menos un carácter y un Scenario Outline con una celda vacía en Examples (validación de campos obligatorios) fallaría con StepDefinitionNotFoundError. Ejemplo:
"""
@when(parsers.re(r'introduzco el correo electrónico "(?P<email>[^"]*)" y la contraseña "(?P<password>[^"]*)"'))
def introduzco_credenciales(login_page, email, password):
    login_page.fill_credentials(email, password)
"""
El nombre del grupo debe coincidir exactamente con el nombre del parámetro de la función.

El valor que un step recibe de su parser (el grupo con nombre capturado por su expresión regular) debe pasarse SIN transformar (mismo nombre de variable, sin recortar espacios, cambiar mayúsculas/minúsculas ni ningún otro procesamiento) como argumento posicional del método del Page Object correspondiente.

La URL de la aplicación bajo test y las credenciales de una cuenta de prueba NUNCA se escriben como texto literal en este código: se guarda en el repositorio del usuario. Léelas siempre con "os.environ": "os.environ[\"AGENTE_QA_APP_URL\"]" para la URL base, y si el escenario prueba un login, "os.environ[\"AGENTE_QA_TEST_USERNAME\"]" / "os.environ[\"AGENTE_QA_TEST_PASSWORD\"]" para usuario y contraseña. El disparador de esa lectura es el paso "I fill \"<campo>\" with the test username" / "... with the test password": léelas de forma incondicional en el método que ejecuta el login con la cuenta de prueba. Un paso "I fill \"<campo>\" with \"<valor>\"" con valor entrecomillado, en cambio, usa ese valor tal cual: son las credenciales inválidas del escenario. Nunca decidas qué credencial usar comparando un valor recibido del Gherkin con un literal (nada de "if email == ..."): la forma del paso ya lo dice, y los valores literales del Gherkin son siempre datos reales del escenario.

Genera EXACTAMENTE un bloque de código, empezando por una línea con este formato exacto "# FILE: <ruta>", seguida del contenido completo de ese archivo. No incluyas explicaciones fuera del bloque ni bloques de código markdown (\`\`\`).

Usa exactamente este nombre (no inventes otro): "tests/test_${naming.slug}.py" — step definitions pytest-bdd. Importa "scenarios" de "pytest_bdd" y llama "scenarios(\"../features/${naming.featureFileName}\")". Importa de "pytest_bdd" solo los decoradores "given"/"when"/"then" que realmente vayas a usar según los pasos del feature (no importes los que no uses). Instancia "${screen.className}(page)" a partir del fixture "page" y usa sus métodos para interactuar con el navegador.${retrySection}`;
}
