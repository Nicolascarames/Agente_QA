# Agente_QA

Sistema agéntico de automatización de QA: convierte una descripción de pruebas en lenguaje natural (texto plano en v1; GitHub Issues/Jira quedan como fuentes futuras) en un plan de pruebas Gherkin, genera los tests automatizados en Python + Playwright (Page Object Model), los ejecuta y produce reportes.

## Arquitectura

Pipeline de 5 agentes especializados —todos implementados—, con lógica compartida (prompts, contratos de datos entre agentes, el mapa de la aplicación, generadores de Gherkin/Playwright) reutilizada por dos formas de uso:

1. **Agente Explorador** — recorre la aplicación con un navegador real, la mapea pantalla a pantalla (textos, localizadores, escenarios candidatos) y escribe `.agente-qa/map/map.json` más un Page Object Python por pantalla — mecánicamente, sin pasar por el LLM. Debe ejecutarse el primero: los agentes siguientes leen el mapa en vez de explorar nada por su cuenta.
2. **Agente de intake** — recibe el texto (o un escenario candidato que el propio mapa propuso al explorar) y diseña el plan de pruebas en Gherkin, siempre en inglés, con cada texto citado copiado carácter a carácter del mapa. Requiere tu aprobación explícita del plan antes de seguir.
3. **Agente generador** — convierte el Gherkin aprobado en el step definition Python correspondiente (pytest-bdd), revalidando antes contra la aplicación real que los localizadores del mapa que el escenario usa siguen siendo únicos, con autochequeo de compilación/lint antes de escribir nada al proyecto. Nunca escribe un Page Object: los localizadores ya los dejó el Agente Explorador.
4. **Agente ejecutor** — selecciona (por tags Gherkin) y lanza los tests generados con `pytest`; pregunta capturas/vídeo en cada ejecución (nativo de `pytest-playwright`, solo en fallo por defecto).
5. **Agente de reportes** — lee el `junit-xml` que deja el agente ejecutor, confirma la ruta del reporte extendido (`pytest-html`, generado por el propio agente ejecutor) y genera un resumen en Markdown (conteos, duración, listado de fallos), con nivel de detalle a elegir en cada generación.

Todos los agentes informan de su progreso a través de un canal de eventos tipado que el CLI imprime en pantalla al vuelo (inicio/fin de cada paso, avisos, duración), no solo al terminar.

Ambas formas de uso comparten el mismo motor (prompts, contratos de datos, el mapa de la aplicación, generadores) y arrancan siempre con una presentación y un menú de opciones, tanto en la instalación como al usar los agentes. Detalle completo del diseño: [`docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md`](docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md) (pipeline general) y [`docs/superpowers/specs/2026-08-15-agente-1-app-map-design.md`](docs/superpowers/specs/2026-08-15-agente-1-app-map-design.md) (mapa de la aplicación y Agente Explorador).

### Dos formas de instalar y usar

| | Plugin de Claude Code | CLI standalone (npm) |
|---|---|---|
| Requiere | Claude Code + suscripción Pro/Max/Team/Enterprise (o API key) | Node.js, sin dependencia de Claude Code (+ los navegadores de Playwright para Node desde "Mapear aplicación"; y Python, `ruff`, `pytest`/`pytest-bdd`/`pytest-playwright`/`pytest-html` desde "Generar tests Playwright" — estos últimos también para "Ejecutar tests") |
| Modelo LLM | Solo Claude | Anthropic, OpenAI, Google, o cualquier proveedor compatible con la API de OpenAI (Groq, Together, Ollama local...) vía API key propia |
| Coste | Incluido en tu suscripción Claude | Pago por uso de API del proveedor elegido |
| Dónde corre | Dentro de una sesión Claude Code | Terminal, standalone, también en CI |

> A partir de "Mapear aplicación" (Agente 1), la CLI standalone necesita los **navegadores de Playwright para Node** (`npx playwright install chromium`, una sola vez tras instalar `agente-qa`) — es el propio `agente-qa` el que controla un navegador real para recorrer la aplicación y escribir el mapa y los Page Objects. No hace falta nada de esto para "Crear plan de pruebas" (Agente 2): lee el mapa ya escrito, no explora nada por su cuenta.
>
> A partir de "Generar tests Playwright" (Agente 3), la CLI standalone necesita además **Python 3, `ruff`, y `pytest`/`pytest-bdd`/`pytest-playwright`/`pytest-html`** en el `PATH` — `ruff`+`py_compile` verifican que el código generado compila y pasa lint, y el stack de pytest se usa para lanzar un navegador real (headless) que revalida que cada localizador del mapa que el escenario usa sigue resolviendo a exactamente un elemento en la aplicación real, antes de aceptar el código.
>
> A partir de "Ejecutar tests" (Agente 4), la CLI standalone reutiliza el mismo stack de pytest para ejecutar los tests generados de verdad, capturar screenshots/vídeo solo en fallo, y generar el reporte extendido que "Ver/generar reportes" (Agente 5) confirma después. No hace falta nada adicional para "Ver/generar reportes" en sí — solo lee ficheros que Agente 4 ya dejó escritos.

### Instalar Python y las dependencias de test

Hace falta desde "Generar tests Playwright" en adelante (Agente 1, mapear aplicación, y Agente 2, crear plan de pruebas, no lo necesitan) — Agente 3 ya lanza un navegador real headless para revalidar los localizadores del mapa antes de aceptar el código, no solo Agente 4 al ejecutar los tests.

**1. Python 3** (si no lo tienes ya — compruébalo con `python --version` o `python3 --version`):

- **Windows**: instala desde [python.org/downloads](https://www.python.org/downloads/) (marca "Add python.exe to PATH" en el instalador) o `winget install Python.Python.3.13`.
- **macOS**: `brew install python3`.
- **Linux (Debian/Ubuntu)**: `sudo apt install python3 python3-pip`.

**2. Dependencias Python**, una vez tengas Python y `pip` en el `PATH`:

```
pip install ruff pytest pytest-bdd pytest-playwright pytest-html
playwright install
```

- `ruff` — lo usa Agente 3 (Generar tests) para verificar lint/compilación antes de escribir nada al proyecto.
- `pytest`, `pytest-bdd`, `pytest-playwright`, `pytest-html` — Agente 3 (Generar tests) los usa para lanzar un navegador headless que revalida cada localizador del mapa contra la aplicación real; Agente 4 (Ejecutar tests) reutiliza el mismo stack para correr los tests generados y producir el reporte extendido.
- `playwright install` descarga los navegadores (Chromium/Firefox/WebKit) que usa ese paso de verificación y los tests generados (Python `pytest-playwright`) — sin esto, `pytest-playwright` falla al lanzar el primer test aunque el paquete esté instalado.

`agente-qa` en sí (no los tests que genera) también controla un navegador real, pero durante "Mapear aplicación" (Agente 1) — para recorrer la aplicación de verdad y escribir el mapa y los Page Objects, antes de que exista ningún test. Es un Playwright para Node, aparte del anterior (que es Playwright para Python, instalado con `pip`). Una sola vez, tras instalar `agente-qa`:

```
npx playwright install chromium
```

Verifica que todo quedó en el `PATH`: `ruff --version` y `pytest --version` deben responder sin error.

## Los cinco agentes, paso a paso

El orden importa: a partir del segundo, cada agente depende de lo que el anterior dejó escrito en disco. La primera vez hay que pasar por los cinco en orden; después, solo hace falta volver a uno cuando lo que produjo haya quedado desactualizado (por ejemplo, si la aplicación cambió, vuelve a mapear).

### Agente 1 — Explorador (`agente-qa map`)

- **Necesita**: la URL de la aplicación (de `config.json`) y, si vas a mapear pantallas que requieren login, las credenciales de una cuenta de pruebas en `.agente-qa/.env`.
- **Produce**: `.agente-qa/map/map.json` (pantallas, textos, localizadores y escenarios candidatos que el propio recorrido sugiere) y un Page Object Python por pantalla (`pages/*.py`, dentro del `testsDir` del proyecto), escrito mecánicamente a partir del mapa — sin pasar por el LLM.
- **Debe ejecutarse el primero.** Los agentes 2 y 3 leen el mapa en vez de explorar nada por su cuenta, y se niegan a arrancar si no lo encuentran — el error que lanzan nombra `agente-qa map` como el comando a ejecutar.
- **Seguridad**: usa SIEMPRE una cuenta de pruebas, nunca una cuenta real — el recorrido autenticado navega la aplicación y, solo con tu confirmación explícita acción por acción, puede llegar a enviar formularios; captura lo que esa cuenta ve. El mapa y los Page Objects que genera **se comitean al repositorio del proyecto** (no están en `.gitignore`), así que no deben acabar conteniendo nada que no quieras en git — de ahí también que el mapa redacte automáticamente cualquier secreto que reconozca de tu `.env`.

### Agente 2 — Intake (menú "Crear plan de pruebas desde un texto", dentro de `agente-qa chat`)

- **Necesita**: el mapa que dejó Agente 1, y tu descripción en texto — o, si el mapa propuso escenarios candidatos durante el recorrido, puedes elegir uno de esos en vez de escribir el tuyo.
- **Produce**: un `.feature` en Gherkin, siempre en **inglés** (la prosa de los pasos y los títulos de escenario, sea cual sea el idioma real de la interfaz de la aplicación — la antigua opción "idioma de la interfaz" de la configuración ya no influye en esto; se mantiene en el esquema solo para que los `config.json` ya existentes sigan cargando), con cada texto citado copiado carácter a carácter del mapa. Si el modelo propone un texto que la aplicación real no tiene, Intake lo detecta y regenera el plan en vez de dejarlo pasar.
- Pide tu aprobación explícita del plan antes de escribirlo a disco.

### Agente 3 — Generador (menú "Generar tests Playwright desde un plan aprobado", dentro de `agente-qa chat`)

- **Necesita**: el `.feature` aprobado por Agente 2 y el mapa de Agente 1. Antes de generar nada, revalida contra la aplicación real (con un navegador headless) que los localizadores que ese escenario usa siguen resolviendo a exactamente un elemento; si alguno ha dejado de serlo, te ofrece dos salidas: volver a mapear con `agente-qa map`, o escribir tú mismo la expresión Playwright correcta para ese localizador.
- **Produce**: únicamente el step definition Python (`pytest-bdd`) del escenario, bajo `tests/`. **Nunca** un Page Object — los localizadores ya viven en los `pages/*.py` que dejó Agente 1, y un lint dedicado rechaza cualquier step que intente construirse su propio localizador en vez de llamar a un método del Page Object.
- Autochequeo de compilación/lint (`ruff` + `py_compile`) antes de escribir nada al proyecto, con reintentos si falla.

### Agente 4 — Ejecutor (menú "Ejecutar tests", dentro de `agente-qa chat`)

- **Necesita**: tests ya generados por Agente 3 bajo el `testsDir` del proyecto.
- Selecciona (por tags Gherkin) y lanza los tests con `pytest`; pregunta capturas de pantalla y vídeo en cada ejecución (nativo de `pytest-playwright`, solo en fallo por defecto).
- **Produce**: el `junit-xml` y el reporte extendido (`pytest-html`) que confirma Agente 5.

### Agente 5 — Reportes (menú "Ver/generar reportes", dentro de `agente-qa chat`)

- **Necesita**: el `junit-xml` que dejó Agente 4.
- **Produce**: un resumen en Markdown (conteos, duración, listado de fallos), con nivel de detalle a elegir en cada generación, y confirma la ruta del reporte HTML extendido que ya dejó Agente 4.

Todos los agentes informan de su progreso a través de un canal de eventos tipado que el CLI imprime en pantalla al vuelo — inicio y fin de cada paso, avisos, duración — no solo al terminar.

## Instalación — Plugin de Claude Code

**No disponible todavía.** El plugin de Claude Code está en fase de diseño, sin implementación — estará disponible en una próxima versión. Por ahora, la única forma de usar Agente_QA es la CLI standalone (npm) de abajo.

Cuando se publique, la instalación será así (nombre del marketplace aún sin decidir):

```
/plugin marketplace add <marketplace-agente-qa>
/plugin install agente-qa@<marketplace>
```

Requerirá tener [Claude Code](https://code.claude.com) instalado y una sesión iniciada con tu cuenta (Pro, Max, Team o Enterprise) — sin API key propia. Para explorar páginas y recuperar localizadores usará el [MCP de Playwright](https://github.com/microsoft/playwright-mcp) en vez de un navegador Node propio (detalle: [`docs/superpowers/specs/2026-08-14-plugin-playwright-mcp-design.md`](docs/superpowers/specs/2026-08-14-plugin-playwright-mcp-design.md)).

## Instalación — CLI standalone (npm)

Instálalo dentro del propio repositorio cuya app vas a probar — coincide con
dónde `init` crea `.agente-qa/` (config + `.env`), todo queda junto al
proyecto, nada global:

```
npm install agente-qa
npx agente-qa init
npx agente-qa map
npx agente-qa chat
```

Esto crea (o reutiliza) `node_modules/` y `package-lock.json` en el
directorio donde lo ejecutes. Si ese repo no es ya un proyecto Node.js (no
tiene `package.json`), ejecuta primero `npm init -y`, o usa la alternativa
global de abajo. Si el repo no tenía `node_modules/` en su `.gitignore`,
añádelo antes de comitear nada.

Para lanzarlo sin `npx` cada vez, añade un script a tu `package.json`:

```json
{
  "scripts": {
    "qa": "agente-qa chat"
  }
}
```

y luego `npm run qa`.

### Alternativa: instalación global

Si prefieres tener `agente-qa` disponible en cualquier carpeta sin
instalarlo por proyecto:

```
npm install -g agente-qa
agente-qa init
agente-qa map
agente-qa chat
```

Funciona igual — `init` sigue creando `.agente-qa/` dentro del repo donde lo
ejecutes; la única diferencia es dónde vive el propio paquete `agente-qa`.

`init` pregunta en qué carpeta del proyecto guardar los tests, la URL de la aplicación que vas a probar, en qué idioma está su interfaz (español por defecto, o inglés — este dato ya no lo consume ningún agente; se sigue guardando solo para no romper la carga de `config.json` de proyectos existentes) y las rutas conocidas del proyecto (página principal, login, y cualquier otra que quieras añadir) — todo se guarda en `<proyecto>/.agente-qa/config.json` (sí va a git, no son datos sensibles). Además crea (si no existe ya) una plantilla `.env` en `<proyecto>/.agente-qa/.env` — fuera de git (`.agente-qa/.gitignore` ya la excluye) — donde rellenas a mano, con un editor de texto, un usuario/contraseña de prueba (opcional, solo si vas a probar login) y el proveedor/API key/modelo del LLM. `init` nunca pide estos dos últimos valores por chat ni sobrescribe el `.env` si ya existe.

Rellena el `.env` y ejecuta `agente-qa map` antes de cualquier otro comando: sin un mapa, "Crear plan de pruebas" y "Generar tests Playwright" se niegan a arrancar.

### Proveedor LLM — opciones y cómo conseguir cada API key

| `AGENTE_QA_LLM_PROVIDER` | Proveedor real | Dónde conseguir la API key | Modelo por defecto |
|---|---|---|---|
| `anthropic` | Anthropic | https://console.anthropic.com/settings/keys | `claude-sonnet-5` |
| `openai` | OpenAI | https://platform.openai.com/api-keys | `gpt-5.1` |
| `google` | Google AI Studio (Gemini API, `generativelanguage.googleapis.com`) — **no** Vertex AI | https://aistudio.google.com/apikey | `gemini-3.6-flash` |
| `openai-compatible` | Cualquier API que implemente el protocolo de OpenAI: Groq, Together AI, Ollama en local, etc. | La del proveedor elegido | El que tú indiques — no hay uno por defecto |

Para las tres primeras opciones basta con `AGENTE_QA_LLM_PROVIDER` + `AGENTE_QA_LLM_API_KEY`. Para `openai-compatible` hacen falta además:

- **`AGENTE_QA_LLM_BASE_URL`**: la que exponga ese proveedor, p. ej. `https://api.groq.com/openai/v1` (Groq) o `http://localhost:11434/v1` (Ollama en local).
- **`AGENTE_QA_LLM_MODEL`**: el nombre exacto que ese proveedor use para el modelo, p. ej. `llama-3.3-70b-versatile` (Groq) o `llama3.3` (Ollama).

Ejemplo de `<proyecto>/.agente-qa/.env` completo, eligiendo Groq como proveedor `openai-compatible` (la URL de la app, el idioma y las rutas ya no van aquí — se preguntan en `init`/`Configuración` y se guardan en `config.json`):

```
AGENTE_QA_TEST_USERNAME=qa-tester@mi-app.com
AGENTE_QA_TEST_PASSWORD=Sup3rSecreta!
AGENTE_QA_LLM_PROVIDER=openai-compatible
AGENTE_QA_LLM_API_KEY=gsk_xxxxxxxxxxxxxxxx
AGENTE_QA_LLM_BASE_URL=https://api.groq.com/openai/v1
AGENTE_QA_LLM_MODEL=llama-3.3-70b-versatile
```

### Desarrollar sobre el propio Agente_QA (no para usarlo en tu app)

Si vas a tocar el código de Agente_QA en sí — no solo usarlo para probar tu
app —, clona y compila desde el propio repositorio en vez de instalar el
paquete publicado:

```
git clone https://github.com/Nicolascarames/Agente_QA.git
cd Agente_QA
npm install
npm run build
node cli/dist/bin/agente-qa.js init
node cli/dist/bin/agente-qa.js map
node cli/dist/bin/agente-qa.js chat
```

### Probar sin crear ficheros en este repo

`init`/`chat` escriben siempre en `process.cwd()` — lanzados como arriba,
desde la raíz de Agente_QA, dejan `.agente-qa/` (config + `.env`) dentro de
este repo. Para probar el CLI sin dejar nada aquí, lánzalo desde otra
carpeta, con la ruta absoluta al build:

- **Por qué `node <ruta>` y no `agente-qa` directo**: en modo desarrollo el
  paquete solo está compilado, no instalado (ni local ni global) — no hay
  symlink de `bin` que registre `agente-qa` como comando del `PATH`. Hay
  que invocar el archivo compilado directamente con `node`.
- **Dónde se genera esa ruta**: `npm run build` compila `cli/src/` a
  `cli/dist/`, incluyendo `cli/dist/bin/agente-qa.js` — esa es la ruta
  absoluta a usar (`<raíz-de-Agente_QA>/cli/dist/bin/agente-qa.js`).
  `dist/` está en `.gitignore`, así que no aparece en el árbol de archivos
  del editor a menos que actives "mostrar archivos ignorados" — solo
  existe después de correr `npm run build`, y se regenera cada vez que lo
  corres.

```
npm run build
mkdir /tmp/agente-qa-smoke && cd /tmp/agente-qa-smoke
node /ruta/absoluta/a/Agente_QA/cli/dist/bin/agente-qa.js init
node /ruta/absoluta/a/Agente_QA/cli/dist/bin/agente-qa.js map
node /ruta/absoluta/a/Agente_QA/cli/dist/bin/agente-qa.js chat
```

(En PowerShell: `mkdir $env:TEMP\agente-qa-smoke; cd $env:TEMP\agente-qa-smoke`.)

Todo lo que genere la sesión (`.agente-qa/`, tests generados, `node_modules`
si hace falta) queda en esa carpeta temporal, nunca en Agente_QA — bórrala
cuando termines.

## Uso

Ambas formas se usan igual: `agente-qa map` mapea la aplicación (hazlo primero, y cada vez que la aplicación cambie), y la conversación de `agente-qa chat` siempre empieza con una presentación y un menú de opciones (mapear aplicación, crear plan de pruebas, generar tests, ejecutar tests, ver reportes, configurar) — el propio menú también ofrece "Mapear aplicación" como primera opción, así que no hace falta salir a la terminal para volver a mapear.

## Estado del proyecto

El pipeline de 5 agentes (motor core + CLI), incluido el Agente Explorador y el mapa de
la aplicación, está **implementado en este repositorio y todavía no publicado en npm**.
Los paquetes publicados, [`agente-qa`](https://www.npmjs.com/package/agente-qa) y
[`@agente-qa/core`](https://www.npmjs.com/package/@agente-qa/core), siguen en la versión
`0.1.6` anterior a este pipeline (sin Explorador ni mapa de la aplicación) — instalar
desde npm hoy y ejecutar `agente-qa map` da "unknown command". Para usar lo descrito en
este README, clona y compila el propio repositorio (ver "Desarrollar sobre el propio
Agente_QA" más abajo); publicar la versión con el pipeline completo es una decisión
pendiente del mantenedor. La suite pasa 610 passed, 3 skipped tests (los `skipped`
dependen de tener `ruff` y el stack completo de Python — `pytest`, `pytest-bdd`,
`pytest-playwright`, `pytest-html` — instalados en la máquina). La superficie de plugin
de Claude Code queda pendiente como plan futuro independiente. Cada decisión de
arquitectura se documenta en [`docs/superpowers/specs/`](docs/superpowers/specs/).
