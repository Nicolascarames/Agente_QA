# Agente 1 — Explorador: mapa completo de la aplicación bajo test

Fecha: 2026-08-15
Estado: aprobado, pendiente de plan de implementación

## 1. Problema

El pipeline actual genera los localizadores a base de adivinarlos. Cada agente ve un trozo
minúsculo de la aplicación — dos o tres pantallas capturadas justo antes de generar — y el
LLM rellena el resto por convención.

La corrida del 15-ago-2026 contra `https://babia-nav.vercel.app/`
(`tests/results/latest.xml`) lo demuestra con 3 tests, 1 verde y 2 rojos, donde la
aplicación se comportó correctamente en los dos fallos:

```
E  waiting for get_by_role("alert")
E  - text: Authentication failed. Please try again.   <- el mensaje SÍ salió, sin role=alert

E  waiting for get_by_text("Forgot password?")
E  - heading "Reset password" [level=1]               <- tras el clic la pantalla ya es otra
```

El primero es un localizador inventado: la evidencia contenía el texto real y el modelo
eligió un rol que la aplicación no usa. El segundo afirma sobre el elemento que acaba de
pulsar en vez de sobre el destino, porque nadie había visitado nunca la pantalla de
destino.

Ninguna de las dos defensas existentes los vio, y no por un fallo de implementación sino
por diseño:

- `checkExpectedLiterals` solo comprueba textos que vengan del `.feature`. El paso decía
  `veo un mensaje de error de credenciales inválidas`, sin comillas: no hay literal que
  comprobar.
- `extractLocatorChecks` descarta explícitamente los pasos sin parámetros
  (`filter((d) => d.kind !== "plain")`, `extractLocatorChecks.ts:199`). Los localizadores
  fijos del constructor del Page Object — que es justo donde el modelo pone sus
  invenciones desde que el Intake dejó de escribir literales — no generan ninguna
  comprobación.

El tercer test, el verde, tampoco prueba nada: afirma
`to_have_url(AGENTE_QA_APP_URL.rstrip("/") + "/")` y `appUrl` ya es
`https://babia-nav.vercel.app/`, o sea la misma URL en la que estaba antes de pulsar
nada.

La conclusión es estructural: **mientras el sistema descubra la aplicación de forma
ad-hoc y a última hora, el LLM seguirá teniendo huecos que rellenar, y los rellenará
inventando.** La solución no es una comprobación más sobre el código generado, sino
quitarle al LLM el trabajo de descubrir.

## 2. Decisión

Se añade un agente que recorre la aplicación entera **antes que cualquier otro** y produce
un mapa persistente: rutas, todos los textos, todos los localizadores ya validados en el
navegador, y qué hace cada clic. Ese mapa pasa a ser la única fuente de verdad del
pipeline. Los Page Objects se generan de él con una plantilla mecánica, sin LLM, de modo
que un localizador inventado deja de ser posible por construcción.

## 3. Renumeración de los agentes

| Nuevo | Antes | Rol | Carpeta |
|---|---|---|---|
| Agente 1 | — | Explorador / Mapeador | `core/src/agents/explorador/` |
| Agente 2 | Agente 1 | Intake (plan Gherkin) | `core/src/agents/intake/` |
| Agente 3 | Agente 2 | Generador (código) | `core/src/agents/generador/` |
| Agente 4 | Agente 3 | Ejecutor | `core/src/agents/ejecutor/` |
| Agente 5 | Agente 4 | Reportes | `core/src/agents/reportes/` |

Los números solo viven en prosa: README, etiquetas del menú del CLI y documentación.
Ningún identificador de código cambia de nombre — las carpetas ya van por rol.

Las specs anteriores **no se reescriben** (regla del `CLAUDE.md`): conservan su numeración
original. Esta tabla es la única equivalencia válida a partir de esta fecha.

## 4. Agente 1 — Explorador

### 4.1 Preflight

Comprueba `appUrl` en `config.json`, credenciales de test en `.env` y navegadores de
Playwright instalados. Si falta cualquiera, para con un mensaje accionable — nunca
arranca un crawl que sabe que va a fallar a mitad.

### 4.2 Captura de pantalla

De cada pantalla visitada anota:

- URL real y plantilla de URL (ver 4.3).
- Título y huella (ver 4.3).
- **Todos** los textos visibles, sin filtrar.
- Todos los elementos interactivos: campos, botones, enlaces, pestañas, desplegables.

Cada texto y cada elemento se convierte en localizador candidato y **se valida en el acto
contra el navegador**: solo entra en el mapa si resuelve a exactamente 1 elemento.

Cuando un candidato resuelve a 2 o más, **no se descarta directamente: primero se intenta
desambiguar** acotándolo al contenedor con significado más próximo, en este orden:

1. Región de referencia (`main`, `form`, `nav`, `header`, `footer`, `dialog`):
   `page.get_by_role("main").get_by_role("button", name="Log in")`.
2. Encabezado de sección más cercano.
3. Si ninguna de las dos deja el conteo en 1, se registra en `ambiguous` con su conteo y
   el motivo, queda fuera del Page Object y se avisa por consola.

Este paso no es opcional: en la propia aplicación de referencia, "Log in" aparece dos veces
(botón de cabecera y botón del formulario), y una regla que descartara todo duplicado
dejaría fuera del mapa el elemento principal de la pantalla. Lo que nunca se usa para
desambiguar es la posición (`.first`, `.last`, `.nth()`): sobrevive a cualquier reordenación
de la interfaz sin fallar, que es la peor forma de fallar.

Los modales, desplegables y acordeones se abren para leer su contenido; cerrarlos y
reabrirlos no cuenta como pantalla nueva si la huella no cambia.

### 4.3 Identidad de pantalla y de elemento

**Plantilla de URL**: los segmentos variables se colapsan. `/usuario/123` y `/usuario/456`
son la misma pantalla `/usuario/:id`. Un segmento se considera variable si es numérico, un
UUID, o si dos URLs hermanas difieren solo en él.

**Huella de pantalla** (`signature`): hash del árbol de accesibilidad normalizado — se
conservan roles y nombres accesibles, se eliminan números, fechas, importes e
identificadores. Dos pantallas con la misma huella son la misma pantalla con otros datos.
Es el mecanismo que detecta la paginación: pulsar "Next" lleva a una huella idéntica.

**Pantalla frente a estado**: si una acción no cambia de ruta y solo añade o quita
contenido — un mensaje de error bajo el formulario, una validación de campo obligatorio, un
panel que se despliega — **no es una pantalla nueva**. Es un estado de la misma pantalla:
sus textos y localizadores se fusionan en la misma entrada del mapa, y el estado se anota
en `states` con qué acción lo provoca. Una pantalla nueva exige cambio de plantilla de URL,
o un cambio de huella tan grande que el contenido anterior ya no está.

Sin esta distinción, un Page Object por ruta —que es lo que se busca— se rompería en
pedazos: la pantalla de login tendría una entrada por cada combinación de mensajes de error
posible, y el detector de bucles vería pantallas nuevas donde solo hay estados.

**Identidad de elemento**: `(id de pantalla, rol, nombre accesible, posición en el árbol)`.
El crawler **nunca pulsa dos veces el mismo elemento**. La posición se incluye porque dos
botones "Editar" en filas distintas de una tabla son elementos distintos con el mismo
nombre accesible.

### 4.4 Cola de exploración

Recorrido en anchura desde la raíz. Se toma un elemento navegable no visitado, se pulsa y
se observa dónde cae:

- Huella nueva → pantalla nueva: entra en el mapa y se encola.
- Huella conocida → solo se registra la transición; no se profundiza.

El crawl termina cuando la cola se vacía. **No hay tope duro por defecto**: el mecanismo
principal de terminación es no repetirse.

### 4.5 Detección de bucles y límites de seguridad

Cuando `loopSuspicionThreshold` pantallas consecutivas comparten huella (paginación,
listados infinitos, carruseles), el crawler **para y pregunta al usuario si continúa por
esa rama**. La respuesta se aplica a esa rama concreta, no a todo el crawl.

Además, `config.json` gana límites configurables que actúan solo como red de seguridad,
con valores deliberadamente amplios:

```json
"crawl": {
  "maxScreens": 500,
  "maxDepth": 25,
  "maxDurationMinutes": 60,
  "loopSuspicionThreshold": 3,
  "excludeRoutes": []
}
```

Al alcanzar cualquiera de ellos, el crawl se detiene, el mapa se marca como incompleto y
la consola dice qué límite se alcanzó y qué quedó sin explorar. `excludeRoutes` acepta
patrones con comodín para excluir zonas que el usuario no quiera mapear.

Solo se recorre el host de `appUrl`. Los enlaces externos se anotan como transición y no
se siguen.

### 4.6 Dos pasadas

**Primera pasada — navegación.** No se envía ningún formulario salvo el login. Todo botón
de envío se registra en `writeActions` con su etiqueta y los campos del formulario al que
pertenece, pero no se pulsa.

**Aprobación.** Vaciada la cola, el crawler presenta la lista de acciones de escritura
encontradas y el usuario marca cuáles puede ejecutar. No existe ningún flag para
saltarse este paso.

**Segunda pasada — escritura aprobada.** Solo las marcadas. Las pantallas que aparezcan
como consecuencia (confirmaciones, mensajes de éxito, pantallas de resultado) entran en el
mapa con el mismo tratamiento que las demás.

Cada acción de escritura aprobada se ejecuta **dos veces, con datos distintos**, porque los
dos resultados son pantallas diferentes y ambas hacen falta:

- **Datos válidos** — credenciales de `.env` si el formulario es de acceso; si no, valores
  que respeten el tipo de cada campo. Captura la pantalla de éxito.
- **Datos inválidos** — email de dominio `.invalid`, campos obligatorios vacíos. Captura
  los mensajes de error y las validaciones.

Sin la segunda variante, el mapa no contendría `"Authentication failed. Please try again."`
— ese texto no existe en la aplicación hasta que alguien envía el formulario con
credenciales malas, y es exactamente el literal que faltaba en el fallo que motiva esta
spec. Es la sonda negativa que hoy vive dentro del Site Explorer, generalizada a cualquier
formulario en vez de estar cableada al patrón `login`, y sujeta a la misma aprobación del
usuario que el resto de las escrituras.

Los valores que el crawler teclea se registran aparte, en `probeValues`, y **se excluyen de
`texts`**: son entrada nuestra, no copy de la aplicación. Esto cierra de raíz la filtración
que hoy lleva constantes internas del tipo `agente-qa-probe-does-not-exist@example.invalid`
hasta el `.feature` del usuario.

### 4.7 Autenticación

Si el crawler detecta un formulario de login y hay credenciales en `.env`, entra de
verdad; el resto del crawl transcurre autenticado y cada pantalla registra
`requiresAuth: true`. Si el login falla, el crawl continúa con la parte pública y el mapa
queda marcado `authenticated: false`.

El botón de cerrar sesión se trata como acción de escritura, no como navegación: pulsarlo
mataría la sesión a mitad del crawl.

### 4.8 Papel del LLM

El recorrido es Playwright determinista: navegar, pulsar, validar, comparar huellas. No
hace falta un modelo para eso, y meterlo dispararía el coste a una llamada por clic.

El LLM interviene en tres puntos y solo tres:

1. Nombrar las pantallas (`id` y nombre de clase del Page Object) de forma legible.
2. Redactar los escenarios candidatos sobre el mapa ya cerrado, en una sola llamada.
3. Resolver un atasco: elemento que no responde, pantalla inesperada, colisión de nombres.

Los nombres de los localizadores se derivan mecánicamente del nombre accesible; el LLM
solo interviene si el slug resultante está vacío o colisiona dentro de la misma pantalla.

## 5. Artefactos

### 5.1 `.agente-qa/map/map.json`

```json
{
  "schemaVersion": 1,
  "appUrl": "https://babia-nav.vercel.app/",
  "createdAt": "2026-08-15T22:00:00.000Z",
  "complete": true,
  "authenticated": true,
  "screens": [
    {
      "id": "login",
      "name": "Log in",
      "className": "LoginPage",
      "urlTemplate": "/",
      "signature": "sha256:…",
      "requiresAuth": false,
      "texts": ["BabIA", "Welcome back", "Log in to continue to your studio.", "Email",
                "Password", "Forgot password?", "Authentication failed. Please try again."],
      "probeValues": ["agente-qa-probe@example.invalid", "agente-qa-invalid-password"],
      "locators": [
        {
          "name": "email_input",
          "kind": "input",
          "accessibleName": "Email",
          "python": "page.get_by_role(\"textbox\", name=\"Email\")",
          "count": 1,
          "verifiedAt": "2026-08-15T22:00:03.000Z"
        },
        {
          "name": "log_in_button",
          "kind": "button",
          "accessibleName": "Log in",
          "python": "page.get_by_role(\"main\").get_by_role(\"button\", name=\"Log in\")",
          "count": 1,
          "disambiguatedBy": "region:main",
          "verifiedAt": "2026-08-15T22:00:04.000Z"
        },
        {
          "name": "text_authentication_failed",
          "kind": "text",
          "python": "page.get_by_text(\"Authentication failed. Please try again.\")",
          "count": 1,
          "stateId": "invalid-credentials",
          "verifiedAt": "2026-08-15T22:04:11.000Z"
        }
      ],
      "states": [
        { "id": "invalid-credentials",
          "reachedBy": { "action": "submit", "locator": "log_in_button", "data": "invalid" },
          "addsTexts": ["Authentication failed. Please try again."] }
      ],
      "ambiguous": [
        { "candidate": "page.get_by_text(\"Email\")", "count": 2,
          "reason": "etiqueta del campo y opción del selector social; ni main ni form lo dejan en 1" }
      ],
      "transitions": [
        { "locator": "forgot_password_button", "action": "click",
          "toScreenId": "reset-password", "urlChanged": true }
      ],
      "writeActions": [
        { "locator": "log_in_button", "label": "Log in", "kind": "submit",
          "formFields": ["email_input", "password_input"] }
      ]
    }
  ],
  "scenarios": [
    { "id": "login-invalid", "title": "Log in fails with invalid credentials",
      "screenId": "login", "involvedScreens": ["login"],
      "rationale": "el formulario muestra un mensaje de error propio" }
  ],
  "stats": { "screens": 7, "locators": 94, "ambiguous": 6, "durationMs": 184000 }
}
```

Un localizador entra en `locators` **solo** con `count: 1`. `ambiguous` existe para que el
usuario vea qué se descartó y por qué, no para consumirse.

### 5.2 `.agente-qa/map/overrides.json`

Correcciones manuales del usuario, en fichero aparte:

```json
{
  "schemaVersion": 1,
  "locators": [
    { "screenId": "login", "name": "error_message",
      "python": "page.get_by_text(\"Authentication failed. Please try again.\")",
      "note": "corregido a mano el 2026-08-15" }
  ]
}
```

Al volver a mapear, `map.json` se regenera entero y los overrides se reaplican encima. Sin
esta separación, cada crawl borraría el trabajo manual del usuario. Un override que apunte
a una pantalla o un nombre que ya no existen en el mapa nuevo se conserva en el fichero
pero se avisa por consola como huérfano.

### 5.3 Page Objects deterministas

Se genera un fichero por pantalla en `<testsDir>/pages/`, con plantilla mecánica y
cabecera que prohíbe editarlos a mano (las correcciones van a `overrides.json`):

```python
# GENERADO por agente-qa desde .agente-qa/map/map.json — NO EDITAR A MANO
# Pantalla: login  ·  ruta: /
import os

from playwright.sync_api import Locator, Page


class LoginPage:
    URL_TEMPLATE = "/"

    def __init__(self, page: Page):
        self.page = page

    def goto(self) -> None:
        self.page.goto(os.environ["AGENTE_QA_APP_URL"].rstrip("/") + self.URL_TEMPLATE)

    def get_email_input(self) -> Locator:
        return self.page.get_by_role("textbox", name="Email")

    def fill_email_input(self, value: str) -> None:
        self.get_email_input().fill(value)

    def get_log_in_button(self) -> Locator:
        # desambiguado por región: "Log in" también aparece en la cabecera
        return self.page.get_by_role("main").get_by_role("button", name="Log in")

    def click_log_in_button(self) -> None:
        self.get_log_in_button().click()

    def get_text_authentication_failed(self) -> Locator:
        return self.page.get_by_text("Authentication failed. Please try again.")
```

Cada localizador validado produce un `get_*`; los interactivos añaden además su `fill_*`,
`click_*` o `select_*` según el tipo. Los nombres salen mecánicos a propósito
(`email_input`, no `campoCorreoDelFormularioDeAcceso`): son derivados del nombre accesible
real, no de la imaginación de un modelo.

### 5.4 Versionado

`map.json`, `overrides.json` y `<testsDir>/pages/*.py` se versionan en el git del proyecto
bajo test. El equipo comparte el mapa, los cambios de interfaz se ven en el diff, y quien
clone el repo puede generar tests sin volver a mapear.

`init` y `Configuración` dejan de ofrecer `<testsDir>/pages` como candidato a `.gitignore`.

## 6. Contrato Gherkin

Los `.feature` pasan a redactarse **en inglés**, con literales exactos copiados del mapa y
la pantalla declarada por escenario:

```gherkin
# agente-qa:map=1
Feature: Log in

  @regression @screen:login
  Scenario: Log in fails with invalid credentials
    Given I am on the "Log in" screen
    When I fill "Email" with "nope@example.com"
    And I fill "Password" with "wrong-password"
    And I click "Log in"
    Then I see "Authentication failed. Please try again."
```

Dos reglas y su porqué:

- **Literal exacto entre comillas.** El literal deja de ser decoración y pasa a ser la
  clave de búsqueda contra el mapa. `Then I see "Authentication failed. Please try again."`
  no deja nada que inventar; `veo un mensaje de error` sí, y de ahí salió el fallo 1.
- **Pantalla declarada** (`@screen:<id>`). Un mismo texto ("Email") aparece en varias
  pantallas; sin declarar cuál, el generador tendría que elegir, y elegir es exactamente
  donde hoy se equivoca.

El idioma queda **fijado en inglés**, no deducido de `appLanguage`. Hoy la prosa se deduce
del idioma de la aplicación y sale distinta en cada corrida: con `appLanguage: "en"` la
corrida del 15-ago produjo prosa en castellano y la anterior prosa en inglés.

Consecuencia honesta: `appLanguage` **se queda sin ningún consumidor**. Existía para dos
cosas y pierde las dos — la redacción pasa a ser inglés fijo, y qué texto esperar lo dice
el mapa, que es evidencia real y no una suposición global sobre el idioma de la aplicación.
Se retira del prompt de ambos agentes en esta rama; se conserva el campo en
`ProjectConfigSchema` para no romper los `config.json` existentes, marcado como obsoleto y
candidato a retirada cuando toque el próximo cambio de configuración.

Vocabulario preferente de pasos, que es el que el mapa puede resolver sin ambigüedad:

```
Given I am on the "<pantalla>" screen
When  I fill "<localizador>" with "<valor>"
When  I click "<localizador>"
When  I select "<opción>" in "<localizador>"
Then  I see "<texto>"
Then  I do not see "<texto>"
Then  I am on the "<pantalla>" screen
```

## 7. Agente 2 — Intake

1. Exige mapa. Si no existe, se detiene y ofrece lanzar el Agente 1. No genera a ciegas.
2. Ofrece los escenarios candidatos del mapa para que el usuario marque cuáles convertir en
   test, o acepta una petición en texto libre como hasta ahora.
3. Si la petición es ambigua, pregunta antes de asumir (sin cambios respecto a hoy).
4. Redacta el Gherkin según el contrato de la sección 6, con el mapa de la pantalla
   correspondiente en el prompt.
5. **Antes de presentarlo**, comprueba que cada literal entrecomillado existe en la
   pantalla declarada del mapa, por comparación exacta. Si alguno no existe, rehace el plan
   en vez de enseñarlo. Esta comprobación es la sucesora de `checkExpectedLiterals` y se
   mueve aquí desde el Generador: es donde el fichero se puede corregir.
6. Aprobación del usuario y escritura del `.feature`.

## 8. Agente 3 — Generador

1. Lee el `.feature` y su cabecera de mapa.
2. **Chequeo de frescura**: revalida en el navegador únicamente los localizadores que ese
   escenario va a usar — no el mapa entero, sería lento sin ganancia. Si alguno ya no
   aparece o pasó a resolver a 2 o más elementos, se detiene y ofrece dos salidas:
   volver a mapear, o que el usuario dé el localizador correcto, que se guarda en
   `overrides.json`.
3. Genera **solo** `tests/*.py`. Los Page Objects vienen del mapa y no se tocan.
4. Regla nueva verificada por lint: un step definition no puede usar `page` directamente.
   Todo localizador sale del Page Object, o sea del mapa. Cierra la puerta por la que hoy
   entra la invención.
5. `ruff` + `py_compile` + lint de locators frágiles, con el bucle de hasta 4 intentos ya
   existente — que a partir de ahora solo sirve para errores de compilación, porque los
   localizadores ya no pueden fallar por invención.

## 9. Agentes 4 y 5

Ejecutor y Reportes no cambian de comportamiento. Solo cambian de número y pasan a emitir
por el canal de eventos de la sección 10.

## 10. Canal de eventos

`core` sigue sin escribir en consola. Se sustituyen los callbacks sueltos de hoy
(`onExplorationStep`, `onVerificationStep`) por un único canal tipado, inyectado como
dependencia:

```ts
export type AgentId = "explorador" | "intake" | "generador" | "ejecutor" | "reportes";
export type EventStatus = "start" | "ok" | "fail" | "warn" | "info";

export interface AgentEvent {
  agent: AgentId;
  status: EventStatus;
  depth: number;          // nivel de sangría
  message: string;
  detail?: string;
  durationMs?: number;
}

export type EmitEvent = (event: AgentEvent) => void;
```

El canal es **solo de salida**. Las preguntas al usuario siguen cruzando por los callbacks
de cada agente, que son bidireccionales por naturaleza.

El CLI decide la presentación: `✓` verde para `ok`, `✗` rojo para `fail`, `⚠` para `warn`,
sangría por `depth` y duración cuando la haya. Nivel detallado por defecto — el usuario
pidió ver cada paso — con modo silencioso disponible. La superficie de plugin de Claude
Code podrá pintar los mismos eventos a su manera sin tocar `core`.

Salida esperada durante un mapeo:

```
Agente 1 · Mapeo de la aplicación
  ✓ Navegador abierto (chromium, headless)
  ✓ https://babia-nav.vercel.app/  ·  pantalla 1  ·  0.9s
    ✓ Login con las credenciales de .env
    ✓ 14 textos anotados · 9 localizadores validados
    ✗ "Log in" → 2 elementos coinciden, se descarta como ambiguo
  ✓ Clic en "Forgot password?" → nueva pantalla /reset
    ✓ 6 textos anotados · 4 localizadores validados
  ⚠ "Next" repetido 3 veces con estructura idéntica
```

## 11. Qué se retira

- `core/src/siteExplorer/` completo: bucle agéntico (`explorerAction.ts`), camino por
  hints y caché de evidencia con TTL de 30 minutos. Con ellos desaparecen dos problemas
  conocidos y sin corregir: `networkidle` sin protección de timeout, y verificación contra
  la pantalla final en el camino agéntico.
- La sonda negativa **como pieza cableada al patrón `login`**. Su idea no se pierde: se
  generaliza a cualquier formulario aprobado en la segunda pasada (§4.6), y sus valores
  dejan de contaminar el `.feature` del usuario al quedar registrados en `probeValues` y
  fuera de `texts`.
- `extractLocatorChecks` y `buildVerificationScript` en su forma actual: cruzar el
  `.feature` con el código generado para deducir qué comprobar ya no hace falta, porque el
  `.feature` declara pantalla y literal. El motor de `realLocatorVerifier` (navegador
  headless que cuenta elementos) se conserva y se reconvierte en el chequeo de frescura de
  la sección 8.
- `Pattern.navigationHints` y `Pattern.pageObjectTemplate`: el mapa sabe dónde está todo y
  los Page Objects salen de él. Los patrones se quedan solo con `gherkinTemplate`.

## 12. Seguridad

El mapa se versiona en git, así que un secreto que entre en él acaba en el repositorio del
usuario. Dos redes independientes:

1. **Redacción en el único punto de captura de pantalla.** Al teclear la contraseña, el
   árbol de accesibilidad la muestra en claro — se ve literalmente en el fallo de la
   corrida del 15-ago (`text: password_incorrecta`). La redacción se aplica donde se
   construye el registro de pantalla, no en cada consumidor: es exactamente la lección del
   hallazgo crítico de la rama del Site Explorer, donde una redacción hecha para un
   consumidor LLM no protegía a un segundo consumidor del mismo dato.
2. **Barrido antes de escribir `map.json`.** Ningún texto del mapa puede coincidir con un
   valor del `.env`. Si coincide, se sustituye.

Se verifica por mutación: revertir la redacción debe hacer fallar un test con la contraseña
real visible.

Advertencias al usuario, en README y en consola al arrancar el crawl: mapear con una cuenta
de pruebas, nunca con una real — el crawl autenticado captura lo que esa cuenta ve, y eso
se commitea. `crawl.excludeRoutes` permite dejar zonas fuera.

La segunda pasada muta datos por definición: solo ejecuta lo aprobado, en cada corrida, sin
posibilidad de saltarse la aprobación.

## 13. Manejo de errores

| Situación | Comportamiento |
|---|---|
| No hay mapa | Agentes 2 y 3 se detienen y ofrecen lanzar el Agente 1 |
| Crawl interrumpido o límite alcanzado | Se escribe el mapa parcial con `complete: false`; los agentes siguientes avisan y continúan si la pantalla que necesitan está |
| Login fallido durante el crawl | Continúa con la parte pública, `authenticated: false` |
| Localizador ambiguo | Se intenta desambiguar por región (§4.2); si no se consigue, queda en `ambiguous`, fuera del Page Object, con aviso por consola |
| Acción de escritura aprobada que falla | Se anota el fallo en el mapa y el crawl continúa: un formulario roto es información útil, no motivo para abortar |
| Localizador obsoleto en el chequeo de frescura | Parada con dos salidas: volver a mapear, o corregir a mano vía `overrides.json` |
| Override huérfano tras un remapeo | Se conserva en el fichero y se avisa |

## 14. Pruebas

Todo lo puro se testea sin navegador: normalización de URL a plantilla, huella de pantalla,
fusión de estados dentro de una misma pantalla, detección de bucles, deduplicación de
elementos, plantilla de Page Object, reaplicación de overrides, exclusión de `probeValues`
de `texts`, lint de literales contra el mapa y lint de `page` en step definitions.

El crawler real sigue el patrón de inyección ya establecido en el proyecto
(`CodeChecker`/`TestRunner`/`SiteExplorer`): interfaz, implementación falsa para tests, e
implementación real con navegador cuyos tests quedan gated si no hay navegadores
instalados.

**Pieza nueva necesaria**: un sitio de prueba mínimo dentro del repo, servido en local
durante los tests, con una forma por mecanismo que hay que probar:

- Login real → autenticación y pantallas con `requiresAuth`.
- Envío con datos inválidos que produce un mensaje de error → estados frente a pantallas, y
  captura del literal que solo existe tras la escritura.
- Botón con el mismo nombre accesible en cabecera y en `main` → desambiguación por región.
- Texto duplicado que ninguna región deja en 1 → descarte por ambigüedad.
- Paginación → detector de bucles.
- Ruta parametrizada → plantilla de URL.

Sin él, probar el crawler depende de una web externa que puede cambiar cualquier día y
romper la suite por motivos ajenos al proyecto.

## 15. README

Gana una sección nueva con el paso a paso de los 5 agentes, en prosa explicativa: qué hace
cada uno, en qué orden, y qué produce. Se añaden también los prerequisitos del Agente 1
(navegador instalado, cuenta de pruebas) y la advertencia de seguridad de la sección 12.

## 16. Fuera de alcance

- Aplicaciones con captcha o 2FA.
- Varios dominios: solo el host de `appUrl`; los enlaces externos se anotan sin seguirse.
- Comparar el mapa antiguo con el nuevo para informar de qué cambió en la aplicación.
- Paralelismo: un navegador, una pestaña.
- La superficie de plugin de Claude Code (Plan 2) no se toca.

## 17. Puntos abiertos, deliberadamente no decididos aquí

- **Step definitions deterministas.** Si el vocabulario de la sección 6 se demuestra
  suficiente en la práctica, `tests/*.py` también podría generarse sin LLM, igual que los
  Page Objects. No se decide en esta spec: primero hay que ver cuántos escenarios reales
  caben en el vocabulario fijo. Candidato a spec futura.
- **Migración de proyectos existentes.** `QA_Testing` tiene Page Objects escritos por el
  LLM que el primer mapeo sobrescribirá. Corte limpio, sin migración automática — mismo
  criterio que la spec de configuración por proyecto del 12-ago.
- **Bump de versión antes de publicar.** Esta rama vuelve a romper firmas públicas
  (`RunIntakeOptions`, `RunGeneradorOptions`, callbacks) y retira exports de `core`. No
  bloquea el merge; sí bloquea el próximo `npm publish`.
