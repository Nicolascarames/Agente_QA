# memory.md — Agente_QA

Memoria viva del proyecto y del usuario. Leer entera al inicio de cada sesión.

**Disciplina de este fichero**
- Cada entrada debe cambiar cómo actuará Claude mañana; si no, no entra.
- Un hecho, una vez: si ya existe una entrada sobre el tema, se actualiza, no se duplica.
- **Límite duro 10KB** (bytes, no líneas — el conteo por líneas engañaba: 131 líneas llegaron a ser 54KB). Al pasarse: reducir a reglas de una línea y mover el detalle a `docs/memoria/`. El número sale de que a 10KB esto son ~2,5k tokens por sesión, ruido frente a los 14k que costaba antes; bajar de ahí obligaría a borrar reglas que sí cambian comportamiento.
- El histórico completo anterior al 2026-08-18 está en `docs/memoria/2026-08-18-memoria-completa.md`. El porqué de cada rama vive en `docs/superpowers/specs/` + `plans/` + git.

## Sobre el usuario

- Confirmación explícita antes de cada `git push` a `origin/main`; los commits locales sin preguntar.
- Idiomas con intención: conversación/specs/docs en castellano, código/commits/identificadores en inglés.
- Windows con Git Bash; `origin` por HTTPS (la key SSH no tenía permisos sobre este repo).
- **Rigor proporcional al riesgo (corregido 2026-08-18, sustituye a "el mismo proceso siempre")**: features de producto llevan el ciclo completo; configuración, docs, tooling y fixes de causa localizada NO. Correr spec+plan+subagentes sobre un cambio de config cuesta más de lo que ahorra.
- **Vigila el gasto de tokens y quiere que se justifique con datos, no con intuición.** Pide investigación medida antes de cambiar cómo se trabaja.

## Estado actual

Pipeline de 5 agentes completo y en `main`: **Explorador** (crawler → `.agente-qa/map/map.json` + `pages/*.py` deterministas) → **Intake** (Gherkin) → **Generador** (Playwright/pytest-bdd) → **Ejecutor** (`python -m pytest`) → **Reportes**. Intake y Generador se niegan a arrancar sin mapa; `siteExplorer` retirado. 654 tests. Publicado en npm: `0.1.6`, que NO trae el mapa.

## Conceptos clave

- **Arquitectura**: monorepo `core`+`cli`. `core` es motor puro sin I/O de terminal (callbacks inyectados + canal de eventos tipado `AgentEvent`/`EmitEvent`, solo salida). Dos superficies —CLI npm y, en Plan 2, plugin de Claude Code— porque ningún proveedor permite reusar tokens de suscripción de chat desde una app externa vía API.
- **Config por proyecto** en `<proyecto>/.agente-qa/`: `config.json` (`testsDir`, `appUrl` obligatorio, `appLanguage`, `routes`, `headedMode`) y `.env` gitignored (credenciales de test, proveedor/API key/modelo LLM), 0700/0600 en cada `init`. Sin fallbacks ni migraciones: corte limpio, criterio del usuario.
- **Prerequisitos** más allá de Node `>=22`: Python + `ruff` + `pytest` + `pytest-bdd` + `pytest-playwright` + `pytest-html` en el `PATH`, y `npx playwright install chromium`. Los tests que ejercitan lo real están gated con `describe.skipIf`.
- **El mapa es la fuente de verdad de localizadores.** Los Page Objects se emiten con plantilla determinista SIN LLM: un localizador inventado es imposible por construcción. `pageFixtureLint` prohíbe que un step definition construya el suyo.
- **Desambiguación**: por atributo SEMÁNTICO (`data-testid`, `type`, `name`), NUNCA por `class` ni por posición (`.first`/`.nth()` sobrevive a reordenaciones sin fallar, que es lo peor que puede hacer). El nombre sale de su `disambiguatedBy`, jamás de un contador. La ambigüedad superviviente aborta; no se coge el primer match.
- **Verificación**: `count>=2` es fallo; `count===0` es SIEMPRE aviso (un mensaje de error no existe hasta enviar el formulario). Un literal ausente aborta sin gastar reintentos, porque vive en el `.feature` que el bucle no regenera.
- **La evidencia agéntica no se cachea nunca** (clave `appUrl+patrón+rutas`; con patrón `null` dos features colisionan). Solo se cachea la exploración guiada por hints.
- Un mensaje de error es un ESTADO de la misma pantalla, no una pantalla nueva — si no, "un Page Object por ruta" se rompe.
- La skill `seguridad-seo` trae su propio protocolo de autocorrección; usarla tal cual, no envolverla en `subagent-driven-development`.

## Reglas de trabajo aprendidas

- **La review final de rama es la única red que atrapa fallos "en agregado". Van 9 instancias** en este proyecto (la lista está en el archivo histórico). No saltarla aunque cada tarea salga limpia.
- **Un fixture propio prueba los mecanismos, no los supuestos sobre el mundo real.** Antes de dar por bueno un agente que toca webs, correrlo contra una app real y leer el artefacto que produce. Los 4 fallos de la primera corrida del crawler eran supuestos sobre ARIA y Playwright, no errores de implementación.
- **Un fixture que no reproduce la forma EXACTA que manda el prompt no prueba el prompt.** El `Given I am on the "<pantalla>" screen` sobrevivió a once reviews porque ningún fixture lo contenía.
- **La solución que propone una review es una hipótesis, no un arreglo.** Todo fix de un test que "no puede fallar" se valida por mutación, igual que el bug original.
- **La redacción de secretos hecha "para un consumidor LLM" no protege a un segundo consumidor** del mismo dato: comprobar cada sitio donde se reenvía.
- Gotcha de la suite: `npx vitest run` completo falla la PRIMERA vez ("82 failed / no tests") y pasa limpio al repetir. No es el código; repetir antes de investigar.
- Gotcha de subagentes: lanzan la suite en segundo plano y PARQUEAN esperando una notificación que nunca consumen, devolviendo el turno sin commitear. Exigir verificación síncrona en primer plano y avisar de que un `| tail` sobre 4 min de suite parece colgado y no lo está.

## Economía de contexto (medido 2026-08-18)

Transcripts reales del repo: **$3.200 en 19 sesiones, 87% en releer contexto del hilo principal**, no en producir. A 400k cada llamada costaba $0,45 frente a $0,14 a 120k, misma productividad. Las reviews ($686) costaron más que toda la implementación ($396); opus fue el 8% de los despachos y el 52% del gasto en subagentes. Las reglas que salieron están en `CLAUDE.md`; los agentes con modelo atado en `~/.claude/agents/` y los hooks de aviso en `~/.claude/hooks/brain-*.js`.

## Decisiones pendientes

- **Borrar la superficie de patrones entera — DECIDIDO, sin implementar**: tras el switchover, `matchPattern`, `patternMatchPrompt`, `loadProjectPatterns`, `loadAllPatterns`, `saveProjectPattern`, `loadBuiltinPatterns`, los cuatro patrones incorporados y `parseFeatureHeader` no los llama nadie. Rama nueva con ciclo completo: son exports públicos de un paquete publicado.
- **Bump MAYOR antes de publicar** (`core`/`cli` siguen en `0.1.6`): tres ramas de cambios rompientes acumulados — firmas de opciones, `emit` POSICIONAL en los callbacks, `PatternSchema` `.strict()`, nueve exports retirados, `onAmbiguousLocator` obligatorio, y cambian todos los nombres de método de los Page Objects ya generados (hay que remapear y regenerar). **`cli/package.json` fija `"@agente-qa/core": "^0.1.0"`, que en 0.x resuelve `>=0.1.0 <0.2.0`**: si `core` sube a `0.2.0`, el CLI publicado seguiría resolviendo `0.1.x` en silencio. Bump y ensanchado del rango, en el MISMO commit.
- Plugin de Claude Code (Plan 2): usa el MCP de Playwright nativo, NO `siteExplorer` (ya no existe). Identificador en marketplace sin decidir.
- Aparcados con decisión registrada (candidatos a spec, no bugs abiertos): dos elementos cuyo nombre base y token de desambiguación colisionan a la vez se intercambian el nombre si cambia el orden del DOM (haría falta crawler de dos pasadas; falsifica la §4 de su spec, que lo afirma en absoluto); un texto entrecomillado que no resuelve a ningún localizador se descarta en silencio en `mapFreshness.ts`, y ahora la herramienta ESCRIBE nombres de localizador en los `.feature`, así que un remapeo deja el paso huérfano; `wait_until="networkidle"` sin protección puede colgar 30s en apps con websockets; los dos `tsconfig.tsbuildinfo` trackeados sin entrada en `.gitignore`.

## Reglas asimiladas (el porqué está en git)

- Antes de fijar una constraint de versión en un plan, comprobar los `engines` reales de las dependencias — no asumir.
- Si `tsc` no resuelve un paquete del propio monorepo, primero `npm run build --workspace=<paquete>` — nunca tocar un tsconfig compartido como primer intento.
- `mode` en `mkdir`/`writeFile` y un `chmod` posterior son complementarios, no alternativos: aplicar los dos.
- Cualquier cambio de rango de dependencia en un `package.json` va con `npm install --package-lock-only` en el MISMO commit.
- Al comparar una entrada contra líneas de un fichero con sintaxis propia (`.gitignore` y similares), normalizar antes (comentarios fuera, slashes colapsados): la comparación literal subestima y sobreestima presencia a la vez.
- Un mock que reenvía parámetros nombrados uno a uno oculta cambios de firma; reenviar `...args: unknown[]`.
- Un test que mockea entera una función de librería externa no puede detectar un bug en cómo se la llama. Para contratos de librería, dejar la función real y sustituir solo la capa de red/modelo.
- Un flag añadido a producción SOLO para que pase un `toContain` es sospechoso: hacer tolerante el test, no pobre el producto.
- Al verificar la afirmación de un implementador sobre un error de compilador, reproducir la expresión EXACTA y los mismos flags de `tsconfig` — una simplificación "equivalente" puede no disparar la misma regla.
- **Credenciales válidas en un `.feature` SIEMPRE salen de `.env`** (`AGENTE_QA_TEST_USERNAME`/`_PASSWORD`), nunca literales inventados por el LLM; las credenciales INVÁLIDAS sí son datos literales del escenario y da igual cuáles sean.
- Un `replace` global sobre código fuente debe distinguir literales y comentarios de código real; si no, "arregla" una regla duplicada y estrena un bug de la misma familia dentro de las cadenas.
