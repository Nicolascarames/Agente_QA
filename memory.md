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
- Agente 2 (Generador) implementado (2026-08-11): Gherkin aprobado → tests Playwright (Python, pytest-bdd, Page Object Model). Runtime fijado en pytest-bdd porque Agente 3 necesita tags Gherkin→pytest markers automáticos. Detalle: `docs/superpowers/specs/2026-08-10-agente-2-generador-design.md`. **Revisado el mismo día** (ver entrada de Agente 3 abajo): pytest-bdd y pytest-playwright no son alternativas, se usan juntos — pytest-bdd para el puente Gherkin→pytest, pytest-playwright para los fixtures de navegador y las capturas nativas.
- Agente 3 (Ejecutor) implementado (2026-08-11), en `main`: selecciona tests por tags Gherkin, ejecuta `python -m pytest` (nuevo `TestRunner` con mismo patrón DI que `CodeChecker`), produce `junit-xml` en `<testsDir>/results/latest.xml` (ruta fija, se sobreescribe cada vez). Corrección de alcance sobre Agente 2 (ya shippeado): el generador pasó de 3 ficheros a 2 (se eliminó `conftest.py` hecho a mano) porque las capturas de pantalla/vídeo nativas de `pytest-playwright` (`--screenshot`/`--video`) necesitan sus propios fixtures, incompatibles con fixtures caseros de estructura libre generados por LLM. Vídeo específicamente no era viable sin esto: necesita configurarse en la creación del `context`, código que vivía dentro del `conftest.py` generado. Detalle: `docs/superpowers/specs/2026-08-11-agente-3-ejecutor-design.md`.
- Agente 4 (Reportes) implementado (2026-08-11), en `main` — **pipeline de 4 agentes completo**, todas las opciones del menú CLI son reales, ninguna sigue siendo stub. Lee `<testsDir>/results/latest.xml`, genera `<testsDir>/results/summary.md` (Markdown: conteos, duración, fallos — nivel "resumen"/"completo" a elegir cada vez) y confirma la ruta del `.html` (`pytest-html`, ya generado por Agente 3). Sin DI fake/real (a diferencia de `CodeChecker`/`TestRunner`): solo lectura de fichero + parseo puro con `fast-xml-parser` (nueva dependencia de `core`), no hay proceso externo que sustituir. Corrección de alcance sobre Agente 3 (ya shippeado): `pytest-html` no puede post-procesar un `junit-xml` ya existente, solo genera su reporte durante la propia invocación de pytest — Agente 3 pasa ahora siempre `--html --self-contained-html` junto a `--junitxml` en la misma ejecución, y su preflight exige también `pytest-html` instalado. Detalle: `docs/superpowers/specs/2026-08-11-agente-4-reportes-design.md`.
- CodeChecker (2026-08-11): mismo patrón DI que `LLMProvider` — interfaz + `FakeCodeChecker` (tests) + `realCodeChecker` (shell a `ruff check` + `python -m py_compile` en directorio temporal). Nuevo prerequisito de entorno: Python+ruff en el `PATH`, no existía en Plan 1 (100% Node/TS). Tests que ejercitan el real están gated (`describe.skipIf`) si no hay `ruff` instalado.
- Empaquetado npm cerrado (2026-08-11): `files: ["dist"]` en ambos `package.json`; `tsconfig.build.json` nuevo por paquete (extiende el `tsconfig.json` general, excluye `*.test.ts`) para que el build no emita tests a `dist/` sin dejar de typechecarlos con `--noEmit`; `"@agente-qa/core": "^0.1.0"` en `cli` (antes `"*"`); `prepack` + `rimraf` en ambos paquetes para que `dist/` se limpie siempre antes de empaquetar. Nombres confirmados y libres en el registro: `agente-qa` (CLI) y `@agente-qa/core`. Publish real sigue bloqueado en metadatos, ver Decisiones pendientes.
- Round-trip de patrón entre agentes (2026-08-11): Agente 1 estampa `# agente-qa:pattern=<nombre>` como primera línea del `.feature` cuando hubo match; Agente 2 lo lee (`parseFeatureHeader`) para reusar el `pageObjectTemplate` sin re-matchear. Guardar patrón nuevo (`offerSavePattern`) es responsabilidad de Agente 2 ahora, no de Agente 1 — corrección de alcance sobre lo implementado en Plan 1 (spec §5 ya lo asignaba a Agente 2; Plan 1 lo había hecho en Agente 1 con `pageObjectTemplate` vacío).

## Decisiones pendientes

- Identificador de plugin en marketplace (superficie Claude Code, Plan 2) — sigue sin decidir.
- **Publicación npm real, bloqueada en metadatos**: empaquetado (`files`, split build/test, rango de dependencia, `prepack`+`rimraf` para limpiar `dist/` antes de publicar) y permisos de `credentials.json` (`0600`/`0700`, con `chmod` explícito para tapar instalaciones antiguas) ya cerrados (2026-08-11, `docs/superpowers/specs/2026-08-11-npm-packaging-publish-design.md`). Lo que falta y bloquea el `npm publish` real: ninguno de los dos `package.json` tiene `license`, `description`, `repository`, `keywords` ni `author`, y ningún tarball lleva `README.md` — hallazgo de la review final, no de la spec/plan. Publicar sin licencia es de las pocas cosas que no se arreglan bien después en npm — decidir con el usuario antes del `npm publish` real, no asumir.
- Spec §5 dice que al encontrar un patrón coincidente el agente debe "ofrecerlo y pedir solo los datos específicos del proyecto" — Plan 1 lo simplificó a inyectar el patrón directo en el prompt sin ese paso conversacional. Queda para que la spec de Plan 2 lo revise explícitamente, no es bug de implementación.
- Tracing de Playwright (`context.tracing`) fuera de alcance de Agente 3 v1 — solo capturas de pantalla/vídeo.
- Historial de ejecuciones: decisión ya tomada y cerrada (spec de Agente 4 §1) — v1 usa ruta fija sobreescrita (`results/latest.xml`/`.html`/`summary.md`), no compara entre lanzamientos. No reabrir sin pedirlo explícitamente.
- `results/` (junit-xml, html, summary.md) y `test-results/` (screenshots/vídeo de pytest-playwright) dentro de `<testsDir>` no se añaden a ningún `.gitignore` automáticamente — pendiente decidir si documentarlo en el README o gestionarlo en un plan futuro.
- Hallazgos de la review final de Agente 4, aparcados por estar fuera de alcance del fix (no implementados, quedan como ideas para specs futuras si se piden): helper compartido `resolveResultsPaths(projectRoot, testsDir)` para que Agente 3 y Agente 4 no reconstruyan la misma convención de rutas por separado; detección de resultados obsoletos (mtime del `junit-xml`) si un run se interrumpe antes de escribir; mensaje explícito "no se ejecutó ningún test" en el resumen cuando `totalTests === 0`; que "Ejecutar tests" mencione también la ruta del `.html` en su salida (hoy solo aparece en "Ver/generar reportes").
- `core/tsconfig.tsbuildinfo` y `cli/tsconfig.tsbuildinfo` están trackeados en git sin entrada en `.gitignore` — hallazgo de la review final de empaquetado npm (2026-08-11), preexistente y sin relación con esa rama, aparcado como limpieza futura de bajo coste.

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

## [2026-08-11] `fast-xml-parser`: valor polimórfico para elementos fuera de `isArray` — nunca comprobar presencia por truthiness
- Qué se hizo mal: `parseJunitResults.ts` (Agente 4) comprobaba `if (testcase.failure || testcase.error)` para detectar un test fallido. `fast-xml-parser` solo fuerza a array los nombres listados en `isArray` (`testsuite`/`testcase`); `failure`/`error`/`skipped` sin atributos ni texto parsean a la cadena vacía `""` (falsy) — un `<failure/>` autocerrado se clasificaba como test pasado. Lo detectó la review final de rama de Agente 4, ninguna review de tarea individual (cada una probó solo con `<failure message="...">`, nunca con la variante vacía).
- Qué corrigió: comprobación por presencia estructural (`"failure" in testcase`) en vez de truthiness; extracción de mensaje con un helper que maneja las tres formas que devuelve la librería para un elemento repetible fuera de `isArray` — objeto (`{"@_message": "..."}`), string suelto (sin atributos) o array (elementos hermanos repetidos, coger el primero).
- Regla: al usar `fast-xml-parser` (o librerías XML-a-objeto similares), cualquier elemento que NO esté en la lista `isArray` puede parsear a objeto, string o array según su contenido — nunca asumir una forma fija ni comprobar presencia con `||`/truthiness; usar `"clave" in objeto` y un helper que cubra las tres formas.

## [2026-08-11] `mode` en `mkdir`/`writeFile` y `chmod` posterior son complementarios, no alternativos
- Qué se hizo mal: al añadir `fs.chmod(dirPath, 0o700)`/`fs.chmod(filePath, 0o600)` a `saveCredentials` (para tapar el caso de un fichero preexistente de una versión antigua, donde la opción `mode` de creación no sirve por llegar tarde), se quitaron las opciones `mode` de `fs.mkdir`/`fs.writeFile`. Efecto: en una instalación nueva, la API key vivía un instante en disco a los permisos por defecto del umask (típicamente 0644) antes de que el `chmod` la cerrara — ventana de exposición real, aunque breve.
- Qué lo detectó: la review final de rama, ninguna review de tarea individual (cada test comprobaba el estado final, nunca el estado intermedio).
- Regla: si hace falta `chmod` para corregir un path que ya existía, no elimines el `mode` de creación pensando que ahora es redundante — sirven a casos distintos (creación nueva vs. fichero preexistente) y hay que aplicar los dos a la vez.

## [2026-08-11] Cambiar un rango de dependencia interna sin regenerar el lockfile en el mismo commit
- Qué se hizo mal: `cli/package.json` pasó `"@agente-qa/core"` de `"*"` a `"^0.1.0"`, pero `package-lock.json` no se regeneró en ese commit — quedó registrando el rango viejo hasta que la review final de rama lo encontró.
- Qué lo detectó: la review final, no la review de la tarea que hizo el cambio (miraba solo el diff de `package.json`, no el lockfile completo).
- Regla: cualquier cambio de rango/versión en un `package.json` de un repo con lockfile se acompaña siempre de `npm install --package-lock-only` (o `npm install` si además hay que instalar algo) en el mismo commit — nunca dejarlo para "ya se regenerará".

## [2026-08-11] `isolation: "worktree"` en el Agent tool ignora la elección de "sin worktree" del usuario
- Qué se hizo mal: el usuario declinó worktree aislado para la sesión ("trabajar directo en main"); el primer despacho de subagente implementador en `subagent-driven-development` se hizo igualmente con `isolation: "worktree"`, creando rama+carpeta aparte sin que el usuario lo supiera.
- Qué se corrigió: cherry-pick del commit a `main`, borrado del worktree y la rama sueltos. El report file del implementador (escrito con ruta absoluta fuera del worktree) se perdió igualmente al borrar el worktree — tuvo que reconstruirse desde el contrato final que el propio agente devolvió.
- Regla: si el usuario declina worktree en la sesión, nunca pasar `isolation: "worktree"` al despachar subagentes de implementación — trabajar siempre en el checkout actual. Si además se usa `subagent-driven-development`, el flujo de reports/ledger asume que el checkout persiste; un worktree que se borra a media tarea destruye evidencia no comiteada.
