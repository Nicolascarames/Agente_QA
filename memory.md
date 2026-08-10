# memory.md — Agente_QA

Memoria viva del proyecto y del usuario. Leer entera al inicio de cada sesión.

**Disciplina de este fichero**
- Cada entrada debe cambiar cómo actuará Claude mañana; si no, no entra.
- Un hecho, una vez: si ya existe una entrada sobre el tema, se actualiza, no se duplica.
- Al superar ~150 líneas: consolidar (fusionar repetidos, reducir correcciones asimiladas a reglas de una línea, borrar obsoletos).

## Sobre el usuario

- Rigor de trabajo: quiere el mismo nivel de proceso siempre (brainstorming → spec → plan TDD → subagentes con review), no una versión ligera para cambios pequeños.
- Quiere confirmación explícita antes de cada `git push` a `origin/main`, aunque los commits locales se hagan sin preguntar.
- Prefiere separar idiomas con intención: conversación/specs/docs en castellano, código/commits/identificadores en inglés — no es descuido, es la convención elegida.
- Windows con Git Bash como shell principal de esta sesión; el remoto `origin` usa HTTPS (la key SSH configurada no tenía permisos sobre este repo).

## Conceptos clave del proyecto

- Arquitectura decidida (2026-08-10): monorepo `core`+`cli`. `core` es motor puro sin I/O de terminal (todo cruza callbacks inyectados); dos superficies encima — CLI npm standalone (API key, cualquier proveedor: Anthropic/OpenAI/Google) y, en Plan 2, un plugin de Claude Code (usa la suscripción Claude del usuario, solo modelos Claude).
- Por qué dos superficies y no una: ningún proveedor de LLM permite reutilizar tokens de suscripción de chat desde una app externa vía SDK/API (política de Anthropic confirmada del 19-feb-2026 para el caso Claude; norma general del sector). Detalle en `docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md`.
- Librería de patrones: incorporados (`core/src/patterns/builtin/`: login, logout, signup, password-reset) + aprendidos por proyecto en `<proyecto>/.agente-qa/templates/`, solo tras confirmación explícita del usuario (nunca guardado en silencio).
- Config: credenciales globales en `~/.agente-qa/credentials.json` (fuera de cualquier repo); preferencias de proyecto en `<proyecto>/.agente-qa/config.json`.
- Node floor: `>=22` (subido desde `>=20` durante Plan 1 — `@ai-sdk/*` lo exige de verdad).

## Decisiones pendientes

- Nombre definitivo del paquete npm y del identificador de plugin en marketplace.
- Empaquetado real para publicar en npm: falta `files: ["dist"]` en ambos `package.json`, excluir `*.test.ts` del build, y cambiar `"@agente-qa/core": "*"` por un rango real — hallazgo de la review final de Plan 1, aparcado (nadie va a hacer `npm publish` todavía).
- Permisos del fichero de credenciales (`0600`/`0700`) — aparcado dos veces (Task 2 y review final), decisión consciente de dejarlo para más adelante.
- Spec §5 dice que al encontrar un patrón coincidente el agente debe "ofrecerlo y pedir solo los datos específicos del proyecto" — Plan 1 lo simplificó a inyectar el patrón directo en el prompt sin ese paso conversacional. Queda para que la spec de Plan 2 lo revise explícitamente, no es bug de implementación.
- Plan 2 = Agentes 2-4 (generador Playwright, ejecutor, reportes), confirmado como objetivo de las próximas sesiones (2026-08-10).

## Correcciones

## [2026-08-10] Constraint global de Node mal calculado en el plan
- Qué se asumió: el plan de Plan 1 fijó "Node.js >= 20" como constraint global sin comprobar los requisitos reales de las dependencias.
- Qué corrigió la review de Task 1: `@ai-sdk/*` declara `engines.node >= 22`; el usuario decidió subir el suelo del proyecto en vez de pinnear versiones antiguas del SDK.
- Regla: antes de fijar una constraint de versión en un plan, comprobar los `engines` reales de las dependencias que se van a instalar — no asumir.

## [2026-08-10] Editar tsconfig no es la respuesta a "cannot find module" en un workspace propio
- Qué se hizo mal: el implementador de Task 17 no pudo resolver `@agente-qa/core` en `tsc` y añadió un `paths` override + cambió `rootDir` en `cli/tsconfig.json`, sin que fuera necesario ni estuviera en el brief.
- Qué corrigió la review: el problema real era que `core/dist/` no estaba construido — la resolución de módulos por workspace symlink + `package.json.types` ya funcionaba sola una vez existía `dist`. El cambio de `rootDir` además rompía cualquier fichero futuro bajo `cli/bin/`.
- Regla: si `tsc` no resuelve un paquete del propio monorepo, primero `npm run build --workspace=<paquete>` — nunca tocar un tsconfig compartido como primer intento.

## [2026-08-10] Ningún test de tarea individual detecta la ausencia de manejo de errores transversal
- Qué pasó: 21 tareas de Plan 1, cada una revisada y aprobada por separado, dejaron el CLI entero sin un solo `try`/`catch` — cualquier fallo de red/API mataba la sesión con un stack trace crudo. Ninguna review de tarea lo vio porque cada una miraba solo su propio diff.
- Qué lo detectó: la review final de rama (mirando los 21 diffs juntos), no ninguna review individual.
- Regla: la review final de rama después de completar todas las tareas de un plan no es un trámite — es la única red que atrapa fallos que solo existen "en agregado". No saltarla nunca, aunque cada tarea individual haya salido limpia.
