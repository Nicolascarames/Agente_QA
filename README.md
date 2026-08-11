# Agente_QA

Sistema agéntico de automatización de QA: convierte una descripción de pruebas en lenguaje natural (texto plano en v1; GitHub Issues/Jira quedan como fuentes futuras) en un plan de pruebas Gherkin, genera los tests automatizados en Python + Playwright (Page Object Model), los ejecuta y produce reportes.

## Arquitectura

Pipeline de 4 agentes especializados —todos implementados—, con lógica compartida (prompts, contratos de datos entre agentes, generadores de Gherkin/Playwright) reutilizada por dos formas de uso:

1. **Agente de intake** — recibe el texto y diseña el plan de pruebas en Gherkin. Si la petición encaja con un patrón conocido (login, logout, signup, recuperar contraseña...), lo usa como punto de partida en vez de generar desde cero. Requiere tu aprobación explícita del plan antes de seguir.
2. **Agente generador** — convierte el Gherkin aprobado en tests Python + Playwright (pytest-bdd, Page Object Model), con autochequeo de compilación/lint antes de escribir nada al proyecto. Si el caso no encajaba en ningún patrón, pregunta si se guarda como patrón nuevo reusable para ese proyecto.
3. **Agente ejecutor** — selecciona (por tags Gherkin) y lanza los tests generados con `pytest`; pregunta capturas/vídeo en cada ejecución (nativo de `pytest-playwright`, solo en fallo por defecto).
4. **Agente de reportes** — lee el `junit-xml` que deja Agente 3, confirma la ruta del reporte extendido (`pytest-html`, generado por el propio Agente 3) y genera un resumen en Markdown (conteos, duración, listado de fallos), con nivel de detalle a elegir en cada generación.

Ambas formas de uso comparten el mismo motor (prompts, contratos de datos, generadores, librería de patrones) y arrancan siempre con una presentación y un menú de opciones, tanto en la instalación como al usar los agentes. Detalle completo del diseño: [`docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md`](docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md).

### Dos formas de instalar y usar

| | Plugin de Claude Code | CLI standalone (npm) |
|---|---|---|
| Requiere | Claude Code + suscripción Pro/Max/Team/Enterprise (o API key) | Node.js, sin dependencia de Claude Code (+ Python y `ruff` para "Generar tests Playwright"; + `pytest`, `pytest-bdd`, `pytest-playwright` y `pytest-html` para "Ejecutar tests") |
| Modelo LLM | Solo Claude | Anthropic, OpenAI, Google, o cualquier proveedor compatible con la API de OpenAI (Groq, Together, Ollama local...) vía API key propia |
| Coste | Incluido en tu suscripción Claude | Pago por uso de API del proveedor elegido |
| Dónde corre | Dentro de una sesión Claude Code | Terminal, standalone, también en CI |

> A partir de "Generar tests Playwright" (Agente 2), la CLI standalone necesita además **Python 3 y `ruff`** en el `PATH` — se usan para verificar que el código generado compila y pasa lint antes de escribirlo al proyecto. No hace falta para "Crear plan de pruebas" (Agente 1).
>
> A partir de "Ejecutar tests" (Agente 3), la CLI standalone necesita además **`pytest`, `pytest-bdd`, `pytest-playwright` y `pytest-html`** en el `PATH` — son las dependencias reales que ejecutan los tests generados por Agente 2, capturan screenshots/vídeo solo en fallo, y generan el reporte extendido que "Ver/generar reportes" (Agente 4) confirma después. No hace falta nada adicional para "Ver/generar reportes" en sí — solo lee ficheros que Agente 3 ya dejó escritos.

### Instalar Python y las dependencias de test

Solo hace falta si vas a usar "Generar tests Playwright" o "Ejecutar tests" (Agente 1, crear plan de pruebas, no lo necesita).

**1. Python 3** (si no lo tienes ya — compruébalo con `python --version` o `python3 --version`):

- **Windows**: instala desde [python.org/downloads](https://www.python.org/downloads/) (marca "Add python.exe to PATH" en el instalador) o `winget install Python.Python.3.13`.
- **macOS**: `brew install python3`.
- **Linux (Debian/Ubuntu)**: `sudo apt install python3 python3-pip`.

**2. Dependencias Python**, una vez tengas Python y `pip` en el `PATH`:

```
pip install ruff pytest pytest-bdd pytest-playwright pytest-html
playwright install
```

- `ruff` — lo usa Agente 2 (Generar tests) para verificar lint/compilación antes de escribir nada al proyecto.
- `pytest`, `pytest-bdd`, `pytest-playwright`, `pytest-html` — los usa Agente 3 (Ejecutar tests) para correr los tests generados y producir el reporte extendido.
- `playwright install` descarga los navegadores (Chromium/Firefox/WebKit) que usan los tests — sin esto, `pytest-playwright` falla al lanzar el primer test aunque el paquete esté instalado.

Verifica que todo quedó en el `PATH`: `ruff --version` y `pytest --version` deben responder sin error.

## Instalación — Plugin de Claude Code

> Pendiente: nombre definitivo del marketplace/repositorio del plugin.

```
/plugin marketplace add <marketplace-agente-qa>
/plugin install agente-qa@<marketplace>
```

Requiere tener [Claude Code](https://code.claude.com) instalado y una sesión iniciada con tu cuenta (Pro, Max, Team o Enterprise).

## Instalación — CLI standalone (npm)

```
npm install -g agente-qa
agente-qa init
agente-qa chat
```

`init` lanza el asistente de configuración: proveedor LLM, API key, (solo para "otro") URL base y modelo, y en qué carpeta del proyecto guardar los tests. Las credenciales se guardan en `~/.agente-qa/credentials.json` (fuera de cualquier repo, permisos 0600/0700 — nunca en el proyecto ni en git). Para cambiar de proveedor más adelante, vuelve a ejecutar `agente-qa init`.

### Configurar el proveedor LLM — opciones y cómo conseguir cada API key

| Opción en el menú | Proveedor real | Dónde conseguir la API key | Modelo por defecto |
|---|---|---|---|
| Anthropic (Claude) | Anthropic | https://console.anthropic.com/settings/keys | `claude-sonnet-5` |
| OpenAI | OpenAI | https://platform.openai.com/api-keys | `gpt-5.1` |
| Google | Google AI Studio (Gemini API, `generativelanguage.googleapis.com`) — **no** Vertex AI | https://aistudio.google.com/apikey | `gemini-3.6-flash` |
| Otro (compatible con OpenAI) | Cualquier API que implemente el protocolo de OpenAI: Groq, Together AI, Ollama en local, etc. | La del proveedor elegido | El que tú indiques — no hay uno por defecto |

Para las tres primeras opciones solo hace falta pegar la API key cuando `init` la pida. Para "Otro" (`openai-compatible`), `init` pide dos datos más:

- **URL base**: la que exponga ese proveedor, p. ej. `https://api.groq.com/openai/v1` (Groq) o `http://localhost:11434/v1` (Ollama en local).
- **Modelo**: el nombre exacto que ese proveedor use para el modelo, p. ej. `llama-3.3-70b-versatile` (Groq) o `llama3.3` (Ollama).

Ejemplo completo de `agente-qa init` eligiendo "Otro":

```
? ¿Qué proveedor de LLM quieres usar? Otro (compatible con OpenAI: Groq, Together, Ollama local...)
? Pega tu API key de openai-compatible: ********
? URL base de la API (compatible con OpenAI), ej. https://api.groq.com/openai/v1: https://api.groq.com/openai/v1
? Nombre del modelo a usar (según lo que exponga ese proveedor), ej. llama-3.3-70b-versatile: llama-3.3-70b-versatile
? ¿En qué carpeta guardamos los tests? (relativa al proyecto) tests
```

Alternativa en local desde el propio repositorio (para desarrollo o antes de instalar global):

```
git clone https://github.com/Nicolascarames/Agente_QA.git
cd Agente_QA
npm install
npm run build
node cli/dist/bin/agente-qa.js init
node cli/dist/bin/agente-qa.js chat
```

## Uso

Ambas formas se usan igual: la conversación siempre empieza con una presentación y un menú de opciones (crear plan de pruebas, generar tests, ejecutar tests, ver reportes, configurar).

## Estado del proyecto

El pipeline de 4 agentes (motor core + CLI) está implementado y **publicado en npm**: [`agente-qa`](https://www.npmjs.com/package/agente-qa) y [`@agente-qa/core`](https://www.npmjs.com/package/@agente-qa/core), versión `0.1.3`. La suite pasa 175 passed, 9 skipped tests (los `skipped` dependen de tener `ruff` y el stack completo de Python — `pytest`, `pytest-bdd`, `pytest-playwright`, `pytest-html` — instalados en la máquina). La superficie de plugin de Claude Code queda pendiente como plan futuro independiente. Cada decisión de arquitectura se documenta en [`docs/superpowers/specs/`](docs/superpowers/specs/).
