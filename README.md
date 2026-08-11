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
| Modelo LLM | Solo Claude | Cualquiera (Claude, OpenAI, Google...) vía API key propia |
| Coste | Incluido en tu suscripción Claude | Pago por uso de API del proveedor elegido |
| Dónde corre | Dentro de una sesión Claude Code | Terminal, standalone, también en CI |

> A partir de "Generar tests Playwright" (Agente 2), la CLI standalone necesita además **Python 3 y `ruff`** (`pip install ruff`) en el `PATH` — se usan para verificar que el código generado compila y pasa lint antes de escribirlo al proyecto. No hace falta para "Crear plan de pruebas" (Agente 1).
>
> A partir de "Ejecutar tests" (Agente 3), la CLI standalone necesita además **`pytest`, `pytest-bdd`, `pytest-playwright` y `pytest-html`** (`pip install pytest pytest-bdd pytest-playwright pytest-html` y luego `playwright install` para los navegadores) en el `PATH` — son las dependencias reales que ejecutan los tests generados por Agente 2, capturan screenshots/vídeo solo en fallo, y generan el reporte extendido que "Ver/generar reportes" (Agente 4) confirma después. No hace falta nada adicional para "Ver/generar reportes" en sí — solo lee ficheros que Agente 3 ya dejó escritos.

## Instalación — Plugin de Claude Code

> Pendiente: nombre definitivo del marketplace/repositorio del plugin.

```
/plugin marketplace add <marketplace-agente-qa>
/plugin install agente-qa@<marketplace>
```

Requiere tener [Claude Code](https://code.claude.com) instalado y una sesión iniciada con tu cuenta (Pro, Max, Team o Enterprise).

## Instalación — CLI standalone (npm)

> El paquete todavía no está publicado en npm. Mientras tanto se instala en local desde el propio repositorio:

```
git clone <url-del-repositorio>
cd Agente_QA
npm install
npm run build
node cli/dist/bin/agente-qa.js init
node cli/dist/bin/agente-qa.js chat
```

`init` lanza el asistente de configuración: pregunta por el proveedor LLM, tu API key y en qué carpeta del proyecto guardar los tests.

Cuando el paquete se publique en npm, `npm install -g agente-qa` funcionará como atajo equivalente a los pasos anteriores.

## Uso

Ambas formas se usan igual: la conversación siempre empieza con una presentación y un menú de opciones (crear plan de pruebas, generar tests, ejecutar tests, ver reportes, configurar).

## Estado del proyecto

El Plan 1 (motor core + Agente de intake — Agente 1 —, superficie CLI incluida), el Agente 2 (generador de tests Playwright), el Agente 3 (ejecutor) y el Agente 4 (reportes) están implementados; la suite pasa 154 passed, 6 skipped tests (los `skipped` dependen de tener `ruff` y el stack completo de Python (`pytest`, `pytest-bdd`, `pytest-playwright`, `pytest-html`) instalados en la máquina). La superficie de plugin de Claude Code queda pendiente como plan futuro independiente. Cada decisión de arquitectura se documenta en [`docs/superpowers/specs/`](docs/superpowers/specs/).
