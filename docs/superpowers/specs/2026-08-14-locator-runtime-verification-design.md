# Verificación en tiempo real de locators generados — diseño

Fecha: 2026-08-14

## Problema

El guardrail de locators frágiles de hoy (`checkLocatorPatterns`, spec
`2026-08-14-generador-locator-safety-design.md`) solo detecta un patrón
textual concreto (`.or_()`) mediante análisis estático — nunca ejecuta el
código generado contra la aplicación real. Existe una clase de bug distinta
que ningún análisis estático puede pillar: un locator de una única
estrategia (`get_by_role("button", name=X)`) que es perfectamente válido
como código, pero que en la página real resuelve a más de un elemento
porque dos elementos reales comparten el mismo nombre accesible.

Caso real que motivó esto: probando `babia-nav.vercel.app` (proyecto
externo, `QA_Testing/`), Agente 2 generó:

```python
def click_button(self, button_name: str):
    self.page.get_by_role("button", name=button_name, exact=False).click()
```

Con `button_name="Log In"` (literal tomado del `.feature`), Playwright
falla en modo estricto: la página tiene dos botones reales con nombre
accesible "Log in" — el toggle del nav superior y el botón `submit` del
formulario. El `CodeChecker` actual (`ruff` + `py_compile` + el lint de
`.or_()`) no tiene forma de saberlo: nunca abre un navegador.

## Diseño

### 1. Contrato de generación — separar "construir locator" de "actuar"

`codeGenerationPrompt` gana una instrucción nueva: cualquier método de
Page Object que actúe sobre un elemento identificado por un parámetro
literal (texto/rol variable, no fijo) debe descomponerse en dos métodos:

```python
def get_button(self, button_name: str):
    return self.page.get_by_role("button", name=button_name, exact=False)

def click_button(self, button_name: str):
    self.get_button(button_name).click()
```

El método `get_*` nunca actúa (ni `.click()`, ni `.fill()`, ni envía
formularios) — solo construye y devuelve el `Locator`. Los locators FIJOS
(sin parámetro, definidos una vez en `__init__` como atributos —
`self.email_input`, `self.password_input`) no cambian: siguen como están
hoy.

### 2. Extracción de valores literales del `.feature`

Función pura nueva, sin navegador, testeable con fixtures de texto:
recibe `featureText` (ya disponible en `runGenerador`/`generateCode` como
input) y el contenido del step-definitions file generado (`test_*.py`,
también ya disponible tras la generación), y produce una lista de
comprobaciones:

```ts
interface LocatorCheck {
  method: string;    // "get_button"
  argument: string;  // "Log In"
}
```

Mecanismo: para cada literal entre comillas en un step del `.feature`
(`pulso el botón "Log In"` → `"Log In"`), cruzar contra el step-definitions
file para encontrar qué método de la Page Object recibe ese valor como
argumento en tiempo de ejecución (el step definition liga el parámetro de
`parsers.parse(...)` al argumento posicional de la llamada al método de la
Page Object — mismo nombre de variable en ambos lados, por convención del
propio prompt de generación). Este cruce (parsear el `.py` generado con
una expresión regular acotada, no un parser Python completo) es la pieza
de mayor riesgo de implementación de todo este diseño — ver "Riesgos
técnicos" más abajo.

### 3. Harness de verificación — script Python generado on-the-fly

Nuevo componente en `core`, mismo patrón de interfaz que `SiteExplorer`/
`CodeChecker` (una interfaz + `Fake*` para tests + `real*` con proceso
real):

```ts
export interface LocatorVerificationResult {
  ok: boolean;
  errors?: string; // mismo formato que CodeCheckResult.errors, va a retry.feedback
}

export interface LocatorVerifier {
  verify(
    files: GeneratedFile[],
    checks: LocatorCheck[],
    baseUrl: string,
    credentials: ExplorationCredentials | undefined
  ): Promise<LocatorVerificationResult>;
}
```

`createRealLocatorVerifier` (modelado sobre `createRealTestRunner`,
`core/src/testRun/realTestRunner.ts`):

1. Preflight: mismo chequeo que ya hace `realTestRunner`
   (`python -c "import pytest, pytest_bdd, pytest_playwright, pytest_html"`)
   — si falta, mismo tipo de error (`MissingTestToolError`), bloqueando.
   Este chequeo se traslada también a Agente 2 (hoy solo lo exige
   Agente 3).
2. Escribe los `files` generados (aún no aceptados, viven solo en memoria
   en el bucle de reintento de `runGenerador`) a un directorio temporal.
3. Sintetiza un script Python de un solo uso (no un test de pytest — no
   hace falta su maquinaria de fixtures/reporting) que: abre
   `playwright.sync_api.sync_playwright()`, `chromium.launch(headless=True)`
   (siempre headless, independiente de `headedMode` del proyecto — esto es
   una comprobación interna, no la sesión que el usuario quiere ver),
   navega a `baseUrl`, importa la Page Object generada, la instancia, y
   para cada `LocatorCheck` llama a `get_<método>(<argumento>).count()`.
   Nunca llama a un método de acción (`click_*`/`fill_*`/etc.).
4. `spawn` el script con `python`, con las mismas variables de entorno que
   ya usa `testEnvVars` (`AGENTE_QA_APP_URL`, credenciales de test si
   `credentials` está presente).
5. El script imprime un resultado estructurado (JSON por línea, un
   objeto por `LocatorCheck`: `{method, argument, count, matches: [...]}`
   — `matches` solo relleno cuando `count !== 1`, con una descripción
   breve de cada elemento real que matcheó vía `.all()` +
   `element.evaluate("el => el.outerHTML")`, truncado).
6. `createRealLocatorVerifier` parsea esa salida; si algún `count !== 1`,
   construye el mensaje de `errors` (ver "Ejemplo" abajo) y devuelve
   `{ ok: false, errors }`.

### 4. Integración con el bucle de reintento de `runGenerador`

Nuevo paso dentro del bucle `for (attempt = 1; attempt <= MAX_ATTEMPTS...)`
de `runGenerador.ts`, DESPUÉS de que `checker.check(files)` pase (no tiene
sentido gastar un navegador real en código que ni siquiera compila):

```ts
const checkResult = await checker.check(files);
if (!checkResult.ok) {
  // como hoy: retry con checkResult.errors
  continue;
}

const locatorChecks = extractLocatorChecks(featureText, files);
const verification = await verifier.verify(files, locatorChecks, baseUrl, credentials);
if (!verification.ok) {
  retry = { previousFiles: files, feedback: verification.errors };
  continue;
}

break; // ambos pasaron
```

Mismo presupuesto `MAX_ATTEMPTS = 4` compartido — sin bucle separado. Al
ser de solo lectura (nunca actúa sobre la página), es seguro reintentarlo
en cada uno de los 4 intentos sin acumular efectos reales (a diferencia de
ejecutar el escenario Gherkin completo, que sí los tendría — enfoque
descartado en el chat por este motivo).

`runGenerador` gana un parámetro nuevo en su `RunGeneradorOptions`:
`verifier: LocatorVerifier`, cableado en `cli/src/commands/generate.ts`
igual que `checker`/`explorer` hoy.

### 5. Prerequisito

El stack completo de pytest (`pytest`, `pytest-bdd`, `pytest-playwright`,
`pytest-html`) pasa a exigirse también al generar (Agente 2), no solo al
ejecutar (Agente 3) — mismo patrón de bloqueo con mensaje claro que ya
usa `ruff`/Python hoy en `CodeChecker`.

## Ejemplo completo (caso real, babia-nav)

**Intento 1 — generación**: LLM genera `get_button`/`click_button` con
`get_by_role("button", name=button_name, exact=False)`.

**Intento 1 — verificación**: `extractLocatorChecks` encuentra
`{method: "get_button", argument: "Log In"}` (aparece en 4 escenarios del
`.feature`). El harness navega a `https://babia-nav.vercel.app/`, llama
`login_page.get_button("Log In").count()` → `2`.

**Intento 1 — feedback**:
```
El locator get_button("Log In") resolvió a 2 elementos reales:
1) <button type="button" class="rounded-[9px]...">Log in</button>
2) <button type="submit" class="flex h-14...">Log in</button>
Hazlo más específico — por ejemplo con el atributo type="submit" para
distinguir el botón de envío del formulario del botón de navegación.
```

**Intento 2 — regeneración**: LLM recibe el feedback + código del intento
1 (mismo mecanismo que ya usa hoy para errores de `ruff`), corrige el
locator para filtrar por `type="submit"`.

**Intento 2 — verificación**: `count() == 1` → pasa. Sigue a
`checker.check()` normal y, si pasa, se escriben los ficheros.

## Riesgos técnicos (sin resolver del todo en este spec)

- **Cruce literal→método** (sección 2): parsear el step-definitions file
  generado por el LLM con una expresión regular acotada es la pieza más
  frágil del diseño — el LLM podría nombrar variables de forma
  inconsistente entre el step y la llamada a la Page Object, rompiendo el
  cruce. Puede necesitar una instrucción de prompt adicional (nombre de
  variable idéntico entre el parámetro del step y el argumento pasado al
  método `get_*`/acción) para que la extracción sea fiable. Merece un
  spike corto antes de comprometerse al plan completo.
- **Coste de tiempo**: cada intento de generación que llega a esta fase
  añade un lanzamiento real de Chromium + navegación real — más lento que
  hoy. Con hasta 4 intentos, el peor caso es notablemente más lento que la
  generación actual.
- **Elementos que solo aparecen tras una acción previa** (p. ej. un botón
  que solo existe después de rellenar un campo, o tras un primer click):
  el harness solo puede verificar locators alcanzables desde el estado
  inicial tras `goto()` — no simula la secuencia completa del escenario.
  Locators de pantallas posteriores (tras login, tras submit) quedan sin
  verificar con este diseño. Puede requerir una versión futura que use la
  evidencia ya capturada por el Site Explorer (que sí navega paso a paso)
  para saber en qué "pantalla" verificar cada literal.

## Fuera de alcance

- Ejecutar el escenario Gherkin completo como dry-run (descartado en el
  chat por los efectos reales que dispararía — logins repetidos, emails
  de recuperación de contraseña, posibles bloqueos de cuenta reales en
  cada uno de los 4 intentos).
- Verificar locators de pantallas alcanzables solo tras una acción previa
  (login, submit) — ver "Riesgos técnicos".
- Cambiar `headedMode` para esta verificación — siempre headless,
  independiente de la preferencia del proyecto.
- Tocar `CodeChecker` existente — `LocatorVerifier` es un componente
  nuevo y separado (necesita `baseUrl`/credenciales, que `CodeChecker` no
  recibe hoy; fusionarlo ahí obligaría a cambiar esa interfaz para todos
  sus consumidores).
