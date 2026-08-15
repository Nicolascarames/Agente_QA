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
  matchedPattern: { name: string; pageObjectTemplate: string } | null,
  naming: CodeGenerationNaming,
  evidence: CodeGenerationEvidence[],
  appLanguage: "es" | "en",
  routes: Record<string, string>,
  retry?: CodeGenerationRetry
): string {
  const patternSection = matchedPattern
    ? `Usa como punto de partida este esqueleto de Page Object conocido ("${matchedPattern.name}"), adaptándolo a los detalles específicos del feature:

"""
${matchedPattern.pageObjectTemplate}
"""`
    : "No hay ningún patrón conocido aplicable: escribe el Page Object desde cero.";

  const evidenceSection =
    evidence.length > 0
      ? `Esto es lo que se ha comprobado de verdad en la aplicación real — usa estas rutas y estos nombres accesibles reales, no inventes otros:

${evidence
  .map((screen) => `### ${screen.stepText}\nURL real: ${screen.url}\n"""\n${screen.ariaSnapshot}\n"""`)
  .join("\n\n")}`
      : "No se pudo capturar evidencia real de la aplicación para este intento: usa el patrón conocido (si lo hay) o el propio feature como única guía.";

  const languageLabel = appLanguage === "en" ? "inglés" : "español";
  const languageSection = `La interfaz real de la aplicación bajo test está en ${languageLabel}. Los textos visibles que menciones o esperes (botones, mensajes, etiquetas, validaciones) deben asumirse en ese idioma — no los traduzcas al castellano aunque el resto de esta conversación esté en castellano.`;

  const homeRouteSection = routes.home
    ? `\n\nLa página principal de la aplicación (tras completar flujos como login) está en la ruta "${routes.home}"; si el escenario verifica una redirección a la página principal, usa esa ruta en vez de asumir la raíz de la URL base.`
    : "";

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

  return `Eres un ingeniero de QA experto en Playwright + Python + pytest-bdd + Page Object Model.

${languageSection}

Dado este archivo Gherkin ya aprobado, ubicado en "features/${naming.featureFileName}":
"""
${featureText}
"""

${patternSection}

${evidenceSection}${homeRouteSection}

El proyecto ya tiene instalado el plugin "pytest-playwright": el fixture "page" (una página de navegador ya lista) está disponible automáticamente en cualquier test, no lo definas tú ni escribas ningún conftest.py.

Para los locators de Playwright, usa siempre una única estrategia precisa por elemento (rol + nombre accesible exacto, o "get_by_test_id" si la evidencia lo muestra) — nunca combines varias estrategias con ".or_()": puede resolver a más de un elemento real y romper en modo estricto (ejemplo real: un botón "mostrar/ocultar contraseña" cuyo "aria-label" también contiene la palabra "contraseña"/"password" colisiona con el locator del campo).

Si un método del Page Object actúa sobre un elemento identificado por un parámetro variable (un texto o nombre accesible que cambia según el escenario, no un valor fijo), sepáralo siempre en dos métodos: uno "get_<algo>" que solo construye y devuelve el "Locator" (nunca actúa: nada de ".click()"/".fill()"/envíos de formulario), y otro (p. ej. "click_<algo>"/"fill_<algo>") que llama al primero y actúa sobre el resultado. Ejemplo:
"""
def get_button(self, button_name: str):
    return self.page.get_by_role("button", name=button_name, exact=False)

def click_button(self, button_name: str):
    self.get_button(button_name).click()
"""
Los locators FIJOS (sin parámetro, definidos una vez como atributos en el constructor, p. ej. "self.submit_button") no necesitan este patrón.

Para los parámetros de un step que van entre comillas en el Gherkin, usa SIEMPRE "parsers.re" con un grupo con nombre que admita el valor vacío, nunca la forma con llaves: esa forma exige al menos un carácter y un Scenario Outline con una celda vacía en Examples (validación de campos obligatorios) fallaría con StepDefinitionNotFoundError. Ejemplo:
"""
@when(parsers.re(r'introduzco el correo electrónico "(?P<email>[^"]*)" y la contraseña "(?P<password>[^"]*)"'))
def introduzco_credenciales(login_page, email, password):
    login_page.fill_credentials(email, password)
"""
El nombre del grupo debe coincidir exactamente con el nombre del parámetro de la función.

El valor que un step recibe de su parser (el grupo con nombre capturado por su expresión regular) debe pasarse SIN transformar (mismo nombre de variable, sin recortar espacios, cambiar mayúsculas/minúsculas ni ningún otro procesamiento) como argumento posicional del método "get_*" o de acción correspondiente: una herramienta automática cruza el archivo Gherkin con este código para verificar los locators contra la aplicación real antes de aceptarlo, y solo puede seguir el rastro de un valor si llega intacto y con el mismo nombre de variable en ambos lados.

La URL de la aplicación bajo test y las credenciales de una cuenta de prueba NUNCA se escriben como texto literal en este código: se guarda en el repositorio del usuario. Léelas siempre con "os.environ": "os.environ[\"AGENTE_QA_APP_URL\"]" para la URL base, y si el escenario prueba un login, "os.environ[\"AGENTE_QA_TEST_USERNAME\"]" / "os.environ[\"AGENTE_QA_TEST_PASSWORD\"]" para usuario y contraseña. Lee esas variables de forma incondicional en el método que ejecuta el login con la cuenta de prueba. Nunca decidas qué credencial usar comparando un valor recibido del Gherkin con un literal (nada de "if email == ..."): el paso de credenciales válidas no lleva datos, y los valores literales del Gherkin son siempre datos reales del escenario.

Genera EXACTAMENTE dos bloques de código, cada uno empezando por una línea con este formato exacto "# FILE: <ruta>", seguida del contenido completo de ese archivo. No incluyas explicaciones fuera de los bloques ni bloques de código markdown (\`\`\`).

Los dos archivos, en este orden, usando exactamente estos nombres (no inventes otros):
1. "tests/test_${naming.slug}.py" — step definitions pytest-bdd. Importa "scenarios" de "pytest_bdd" y llama "scenarios(\"../features/${naming.featureFileName}\")". Importa de "pytest_bdd" solo los decoradores "given"/"when"/"then" que realmente vayas a usar según los pasos del feature (no importes los que no uses). Usa el fixture "page" (parámetro de las funciones step) para interactuar con el navegador a través del Page Object.
2. "pages/${naming.slug}_page.py" — clase(s) Page Object en Python (Playwright sync API) para las pantallas involucradas, recibiendo "page" en su constructor.${retrySection}`;
}
