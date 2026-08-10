# CLAUDE.md — Agente_QA

Sistema agéntico de automatización de QA (monorepo `core`+`cli`). Plan 1 (motor core + Agente 1 de intake) está completo y en `main`; es un prototipo funcional, todavía sin publicar en npm.

## Idioma y trato

Responde y pregunta SIEMPRE en castellano (español de España), incluidas las preguntas de aclaración y los resúmenes. El código, los identificadores y los mensajes de commit van en inglés; los commits siguen Conventional Commits (`feat(core): ...`, `fix(cli): ...`, `test: ...`, `docs: ...`, `chore: ...`). Las cadenas de cara al usuario final del CLI (menú, prompts, mensajes de error del agente) van en castellano — eso sí es parte del producto, no del código.

## Estilo de trabajo — profesional, no complaciente

El objetivo de cada sesión es sacar trabajo productivo y terminado, no volumen de cambios. Para eso:

- Antes de implementar nada no trivial, interroga los detalles: presenta las decisiones abiertas con opciones concretas y espera la elección.
- Todo cambio no trivial pasa por el mismo ciclo que Plan 1: `superpowers:brainstorming` → spec en `docs/superpowers/specs/` → `superpowers:writing-plans` (tareas TDD bite-sized) → `superpowers:subagent-driven-development` (implementador + review por tarea + review final de rama). No lo abrevies para features grandes ni para agentes nuevos.
- "Hecho" significa: código + `tsc --noEmit` limpio en ambos paquetes + `vitest run` en verde + review de subagente aprobado (o hallazgos aparcados con motivo), con la salida del comando como evidencia.
- No amplíes el alcance por iniciativa propia. Mejoras no pedidas se proponen, no se hacen.

## Inicio de cada sesión

1. Lee `memory.md` entero antes de la primera tarea.
2. Pregunta al usuario: «¿Activo claude-brain para esta sesión?». Si dice que sí, invoca la skill `claude-brain` y sigue su protocolo de planificación y enrutado de modelos durante toda la sesión.

## Memoria (`memory.md`)

- Cuando el usuario corrija algo — código, un supuesto, una preferencia, una forma de trabajar — regístralo en `memory.md` ANTES de continuar. No pidas permiso.
- Registra también decisiones tomadas y conceptos clave del proyecto.
- Si supera ~150 líneas, consolida: fusiona entradas repetidas, reduce correcciones asimiladas a reglas de una línea, borra lo obsoleto.

## Exploración del código y economía de tokens

- Para localizar código usa PRIMERO el grafo de codebase-memory (`search_graph`, `trace_path`, `get_code_snippet`, `get_architecture`); Grep/Read solo para texto plano, configs o cuando el grafo no cubra. Si el índice está desfasado, `detect_changes` + reindexado.
- Lee estrecho: secciones concretas, no ficheros enteros; nunca releas lo que ya está en contexto.
- Piensa caro, ejecuta barato: planificación y diagnóstico difícil al modelo potente; ejecución mecánica y búsquedas al barato — así se dispachan los subagentes implementadores en `subagent-driven-development` (haiku para tareas con código completo en el brief, sonnet+ para integración/juicio, el más capaz para la review final de rama).

## Seguridad y producción

Antes de cualquier despliegue a producción o de publicar en npm — y tras tocar credenciales, auth o el manejo de API keys — pasa la skill `seguridad-seo` y resuelve sus hallazgos. Sin auditoría no hay deploy ni publish.

## Mapa del proyecto

- Motor compartido, sin I/O de terminal directo: `core/src/` — credenciales/config (`core/src/config/`), proveedores LLM Anthropic/OpenAI/Google (`core/src/llm/`), librería de patrones (`core/src/patterns/`), agentes (`core/src/agents/intake/` = Agente 1, hecho; Agentes 2-4 irán al lado cuando toquen), barrel público `core/src/index.ts`.
- CLI: `cli/src/` (comandos, menú, prompts reales con inquirer) + `cli/bin/agente-qa.ts` (entry point de `agente-qa`).
- Specs de diseño (por qué se decidió cada cosa): `docs/superpowers/specs/`.
- Planes de implementación (tareas TDD): `docs/superpowers/plans/`.
- Ledger de ejecución de un plan en curso (scratch, gitignored): `.superpowers/sdd/<plan>/progress.md` — se borra al terminar el plan, la historia queda en git.

## Convenciones no evidentes

- `core/src` nunca hace I/O de terminal (nada de `console.*`/`readline`) — toda interacción humana cruza callbacks inyectados (`IntakeCallbacks` y equivalentes futuros). Es lo que permite reusar `core` tal cual en la superficie de plugin Claude Code de Plan 2 — no lo rompas.
- DI explícita: las funciones de `core` reciben `homeDir`/`projectRoot` como parámetro, nunca leen `os.homedir()`/`process.cwd()` por dentro — así los tests usan `fs.mkdtemp` real sin mockear `fs`.
- Imports relativos con sufijo `.js` aunque el fichero sea `.ts` (ESM NodeNext).
- `cli`'s `tsc` necesita `core/dist/` construido para resolver `@agente-qa/core` (vitest en cambio alía directo a `core/src`). Si falla resolución: `npm run build --workspace=core`, nunca tocar `cli/tsconfig.json` — ver Task 17 en el plan de Plan 1 para el porqué exacto.

## Comandos

- Test: `npx vitest run` (o `npm test`)
- tsc: `npx tsc -p core/tsconfig.json --noEmit` / `npx tsc -p cli/tsconfig.json --noEmit`
- Build: `npm run build` (compila `core` antes que `cli`, el orden importa)
- Ejecutar CLI (tras build): `node cli/dist/bin/agente-qa.js init` / `... chat`

## Zonas intocables

- Credenciales reales (`~/.agente-qa/credentials.json`) y cualquier secreto — nunca hardcodear ni commitear valores reales.
- `docs/superpowers/specs/` y `docs/superpowers/plans/` — no reescribir retroactivamente, solo añadir ficheros nuevos fechados (`YYYY-MM-DD-tema.md`).
- `git push` a `origin/main` — confirmar antes de cada push, aunque los commits locales se hagan libremente.
