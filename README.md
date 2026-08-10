# Agente_QA

Sistema agéntico de automatización de QA: convierte una descripción de pruebas en lenguaje natural (texto plano en v1; GitHub Issues/Jira quedan como fuentes futuras) en un plan de pruebas Gherkin, genera los tests automatizados en Python + Playwright (Page Object Model), los ejecuta y produce reportes.

## Arquitectura

Pipeline de 4 agentes especializados, con lógica compartida (prompts, contratos de datos entre agentes, generadores de Gherkin/Playwright) reutilizada por dos formas de uso:

1. **Agente de intake** — recibe el texto y diseña el plan de pruebas en Gherkin. Si la petición encaja con un patrón conocido (login, logout, signup, recuperar contraseña...), lo usa como punto de partida en vez de generar desde cero. Requiere tu aprobación explícita del plan antes de seguir.
2. **Agente generador** — convierte el Gherkin aprobado en tests Python + Playwright (convención fija: Page Object Model). Si el caso no encajaba en ningún patrón, pregunta si se guarda como patrón nuevo reusable para ese proyecto.
3. **Agente ejecutor** — selecciona (por tags Gherkin) y lanza los tests generados; pregunta capturas/vídeo en cada ejecución.
4. **Agente de reportes** — genera un reporte extendido (pytest-html) y un resumen (Markdown) de la ejecución.

Ambas formas de uso comparten el mismo motor (prompts, contratos de datos, generadores, librería de patrones) y arrancan siempre con una presentación y un menú de opciones, tanto en la instalación como al usar los agentes. Detalle completo del diseño: [`docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md`](docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md).

### Dos formas de instalar y usar

| | Plugin de Claude Code | CLI standalone (npm) |
|---|---|---|
| Requiere | Claude Code + suscripción Pro/Max/Team/Enterprise (o API key) | Node.js, sin dependencia de Claude Code |
| Modelo LLM | Solo Claude | Cualquiera (Claude, OpenAI, Google...) vía API key propia |
| Coste | Incluido en tu suscripción Claude | Pago por uso de API del proveedor elegido |
| Dónde corre | Dentro de una sesión Claude Code | Terminal, standalone, también en CI |

## Instalación — Plugin de Claude Code

> Pendiente: nombre definitivo del marketplace/repositorio del plugin.

```
/plugin marketplace add <marketplace-agente-qa>
/plugin install agente-qa@<marketplace>
```

Requiere tener [Claude Code](https://code.claude.com) instalado y una sesión iniciada con tu cuenta (Pro, Max, Team o Enterprise).

## Instalación — CLI standalone (npm)

> Pendiente: nombre definitivo del paquete npm.

```
npm install -g agente-qa
agente-qa init
```

`init` lanza el asistente de configuración: elige proveedor LLM, pega tu API key, define estructura de carpetas y preferencias de capturas/vídeo/reportes.

## Uso

Ambas formas se usan igual: la conversación siempre empieza con una presentación y un menú de opciones (crear plan de pruebas, generar tests, ejecutar tests, ver reportes, configurar).

## Estado del proyecto

Diseño v1 cerrado y documentado, pendiente de plan de implementación. Cada decisión de arquitectura se documenta en [`docs/superpowers/specs/`](docs/superpowers/specs/).
