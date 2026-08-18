# CLAUDE.md — Agente_QA

Sistema agéntico de automatización de QA (monorepo `core`+`cli`). Plan 1 (motor core + Agente 1 de intake) está completo y en `main`; es un prototipo funcional, todavía sin publicar en npm.

## Idioma y trato

Responde y pregunta SIEMPRE en castellano (español de España), incluidas las preguntas de aclaración y los resúmenes. El código, los identificadores y los mensajes de commit van en inglés; los commits siguen Conventional Commits (`feat(core): ...`, `fix(cli): ...`, `test: ...`, `docs: ...`, `chore: ...`). Las cadenas de cara al usuario final del CLI (menú, prompts, mensajes de error del agente) van en castellano — eso sí es parte del producto, no del código.

## Estilo de trabajo — profesional, no complaciente

El objetivo de cada sesión es sacar trabajo productivo y terminado, no volumen de cambios. Para eso:

- Antes de implementar nada no trivial, interroga los detalles: presenta las decisiones abiertas con opciones concretas y espera la elección.
- **Features de producto** (agentes nuevos, cambios de arquitectura, superficies nuevas) pasan por el ciclo completo: `superpowers:brainstorming` → spec en `docs/superpowers/specs/` → `superpowers:writing-plans` → `superpowers:subagent-driven-development`. No lo abrevies ahí.
- **Configuración, docs, tooling y fixes de una causa localizada NO pasan por el ciclo.** Correr spec+plan+subagentes sobre un cambio de config cuesta más de lo que ahorra. Si dudas, di qué camino tomas y por qué en una línea, y sigue.
- **Presupuesto de review: una re-review como máximo.** review → fix → re-review, y ahí se cierra. Lo que siga abierto se aparca con motivo escrito. Los bucles de re-review fueron $348 de pura iteración en la historia de este repo.
- "Hecho" significa: código + `tsc --noEmit` limpio en ambos paquetes + `vitest run` en verde + review aprobado (o hallazgos aparcados con motivo), con la salida del comando como evidencia.
- **Verificación agrupada**: `tsc` y `vitest` se ejecutan una vez al cerrar la tarea, no tras cada edición. Cada ejecución paga el contexto entero de la sesión; en este repo se acumularon 997 ejecuciones de vitest y 530 de tsc.
- No amplíes el alcance por iniciativa propia. Mejoras no pedidas se proponen, no se hacen.

## Inicio de cada sesión

1. Lee `memory.md` entero antes de la primera tarea (está acotado a ~8KB justamente para que eso sea barato). Las lecciones históricas viven en `docs/memoria/` y solo se leen si la tarea las toca.
2. La sesión arranca en Opus 5 para brainstorm/spec/plan. **Al cerrar el plan, recuérdale al usuario que cambie a `/model sonnet`** para la implementación — no puedes cambiarlo tú, y a partir de ahí el hilo principal solo orquesta.

## Memoria (`memory.md`)

- Cuando el usuario corrija algo — código, un supuesto, una preferencia, una forma de trabajar — regístralo en `memory.md` ANTES de continuar. No pidas permiso.
- Registra también decisiones tomadas y conceptos clave del proyecto.
- **Límite duro: 10KB.** Se mide en bytes, no en líneas — el conteo por líneas engañaba (131 líneas eran 54KB de párrafos gigantes, y `memory.md` acabó siendo el fichero más leído del repo: 230k tokens). Al pasarse: reduce las correcciones asimiladas a reglas de una línea y mueve el detalle a `docs/memoria/`.

## Economía de contexto y despacho

El coste de una sesión lo domina el tamaño del contexto que arrastra el hilo principal, no lo que se escribe. Medido en este repo: **87% del gasto fue releer contexto**; a 400k tokens cada llamada costaba $0,45 frente a $0,14 a 120k, produciendo lo mismo.

- **El hilo principal orquesta: despacha, lee resúmenes y commitea. No lee código.** Lo que abra ficheros grandes va dentro de un subagente, cuyo contexto muere con él.
- Para localizar código usa PRIMERO el grafo de codebase-memory (`search_graph`, `trace_path`, `get_code_snippet`, `get_architecture`) o despacha `brain-scout`; Grep/Read solo para texto plano, configs o cuando el grafo no cubra. Si el índice está desfasado, `detect_changes` + reindexado.
- **Nunca leas un fichero entero "para orientarte".** Pide anclas `fichero:línea` y lee solo ese rango con `offset`/`limit`. En este repo `realCrawler.ts` (1.757 líneas) se leyó entero 68 veces: 218k tokens.
- **Los briefs de subagente llevan `fichero:línea` exactos**, el cambio exacto y el comando de verificación. Un brief cerrado es lo que permite que lo ejecute un modelo barato.
- **Al pasar de ~150k de contexto, cierra la tarea y abre sesión nueva** con un handoff de 20 líneas.
- **Enrutado por agente, no por decisión ad hoc**: `brain-scout` (haiku, localizar), `brain-implementer` (sonnet, una tarea de brief cerrado), `brain-reviewer` (sonnet, review por tarea — el reviewer por defecto), `brain-final-reviewer` (opus, review final de rama). Definidos en `~/.claude/agents/`.
- **Máximo 2 despachos a opus por sesión**: review final de rama y diagnóstico difícil. Todo lo demás es sonnet o haiku. Histórico: opus fue el 8% de los despachos y el 52% del gasto en subagentes.

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
- DI explícita: las funciones de `core` reciben `projectRoot` como parámetro, nunca leen `process.cwd()` por dentro — así los tests usan `fs.mkdtemp` real sin mockear `fs`.
- Imports relativos con sufijo `.js` aunque el fichero sea `.ts` (ESM NodeNext).
- `cli`'s `tsc` necesita `core/dist/` construido para resolver `@agente-qa/core` (vitest en cambio alía directo a `core/src`). Si falla resolución: `npm run build --workspace=core`, nunca tocar `cli/tsconfig.json` — ver Task 17 en el plan de Plan 1 para el porqué exacto.
- **Un fichero de test por módulo, no por tarea del plan.** El TDD por tarea generó `realCrawler.capture.test.ts` + `.walk.test.ts` + `.write.test.ts` (63KB combinados con setup repetido) para un solo módulo. Si una tarea añade casos a un módulo que ya tiene test, van a ese fichero.
- **Los planes llevan criterio de aceptación, no código inline.** El código lo escribe el implementador desde el brief. Los planes de este repo llegaron a 3.372 líneas y se leyeron 501k tokens de ellos.

## Comandos

- Test: `npx vitest run` (o `npm test`)
- tsc: `npx tsc -p core/tsconfig.json --noEmit` / `npx tsc -p cli/tsconfig.json --noEmit`
- Build: `npm run build` (compila `core` antes que `cli`, el orden importa)
- Ejecutar CLI (tras build): `node cli/dist/bin/agente-qa.js init` / `... chat`

## Zonas intocables

- Credenciales reales (`<proyecto>/.agente-qa/.env`, gitignored) y cualquier secreto — nunca hardcodear ni commitear valores reales.
- `docs/superpowers/specs/` y `docs/superpowers/plans/` — no reescribir retroactivamente, solo añadir ficheros nuevos fechados (`YYYY-MM-DD-tema.md`).
- `git push` a `origin/main` — confirmar antes de cada push, aunque los commits locales se hagan libremente.
