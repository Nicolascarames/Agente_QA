# Plugin de Claude Code — exploración web vía MCP de Playwright (adenda a Plan 2)

Fecha: 2026-08-14
Estado: decisión de arquitectura registrada, Plan 2 sigue sin spec completa ni implementación. No bloquea nada del CLI (Plan 1, completo).

Esta adenda no reescribe [`2026-08-10-agente-qa-pipeline-design.md`](2026-08-10-agente-qa-pipeline-design.md) — lo complementa en el punto abierto de su sección 10 ("nombre/arquitectura del plugin, sin resolver").

## Decisión

En el modo plugin de Claude Code, todo lo que hoy hace `core/src/siteExplorer/` en el CLI (visitar páginas reales, recuperar localizadores) y las partes de Agente 1/Agente 2 que dependen de esa exploración (crear casos de prueba Gherkin confirmados contra la app real, generar código con localizadores reales) se apoyan en el **MCP de Playwright** — el mismo servidor que Claude Code ya sabe consumir de forma nativa (`mcp__playwright__*`), no un servidor MCP propio.

## Por qué (contraste con el CLI)

El CLI llama al LLM vía API (AI SDK, `core/src/llm/*`) — ese LLM no tiene tool-calling nativo a un navegador, así que Site Explorer tuvo que construirse desde cero: Playwright para Node + un bucle "agentic" donde el LLM elige una acción a la vez (`goto`/`click`/`fill_credential`/`done`/`fail`, `core/src/siteExplorer/explorerAction.ts`) y `core` la ejecuta.

En el plugin, el propio Claude Code YA tiene tool-calling nativo. Si el MCP de Playwright está disponible en la sesión, el agente navega e inspecciona páginas/localizadores directamente con esas tools — sin ningún bucle de acciones intermedio escrito a mano, sin schema de acciones propio, sin nada de `core` en medio para esa parte.

## Alcance de esta decisión

Cubre exactamente lo que se pidió:

- **Visitar páginas reales y recuperar localizadores** — equivalente funcional de `core/src/siteExplorer/` en el CLI, pero vía tools nativas del MCP en vez de código Node propio.
- **Agente 1 (Intake)** — cuando haga falta confirmar un caso de prueba contra la app real antes de aprobar el `.feature`.
- **Agente 2 (Generador)** — generación de código apoyada en los localizadores reales obtenidos vía MCP, en vez de adivinados por convención.

**Fuera de esta decisión, sin resolver todavía:**

- **Agente 3 (Ejecutor)** — los tests generados son Python/pytest-bdd; lo más probable es que el plugin siga shelling a `pytest` igual que el CLI (`core/src/testRun/realTestRunner.ts`), no vía MCP, pero no está decidido — el MCP de Playwright sirve para que el agente explore/inspeccione, no para ejecutar una suite pytest ya escrita.
- **Agente 4 (Reportes)** — sin cambios previstos, sigue siendo lectura/parseo de ficheros (`junit-xml`, `pytest-html`), no depende de navegador en ningún modo.

## Consecuencia sobre la premisa de "un solo motor compartido"

La spec original (2026-08-10, §3) asume que `core/` es 100% compartido entre las dos superficies. Esta decisión introduce una excepción real: **la exploración web NO es compartida** — cada superficie tiene la suya:

- CLI: `core/src/siteExplorer/realSiteExplorer.ts` (Playwright Node + bucle agentic propio) — se queda exactamente como está, no se toca.
- Plugin: MCP de Playwright nativo, consumido directamente por el agente/skill del plugin — no pasa por `core/src/siteExplorer/` en ningún punto.

El resto de `core` (prompts, schemas, generadores de Gherkin/Playwright, librería de patrones) sigue siendo compartido sin cambios — la excepción es solo la capa de exploración web.

## Prerequisito nuevo para el plugin

El MCP de Playwright debe estar configurado y disponible en la sesión Claude Code del usuario (vía la config de MCP de Claude Code) para poder usar "Generar tests Playwright" en modo plugin. Esto es independiente de los navegadores de Playwright para Node que instala el CLI (`npx playwright install chromium`) — el plugin, para esta parte, no necesita esa instalación en absoluto.

## Puntos abiertos (quedan para la spec completa de Plan 2)

- Si Agente 3 (Ejecutor) también se apoya en MCP de alguna forma, o sigue shelling a `pytest` igual que el CLI (probable).
- Arquitectura interna exacta de `plugin/agents/`, `plugin/skills/`, `plugin/commands/` (esqueleto ya esbozado en la spec de 2026-08-10, sin detallar).
- Nombre definitivo del plugin en marketplace — sigue sin decidir (ver `memory.md`).
