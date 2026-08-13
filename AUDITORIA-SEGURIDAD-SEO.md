# Auditoría de seguridad y SEO — Agente_QA — 2026-08-11

## Resumen ejecutivo

Auditoría previa al primer `npm publish` de `@agente-qa/core` y `agente-qa` (CLI). Proyecto: monorepo TypeScript, sin frontend web ni base de datos — un motor + CLI de terminal que llama a APIs de LLM (Anthropic/OpenAI/Google) y ejecuta herramientas Python locales (`ruff`, `pytest`) vía subproceso. **Sin hallazgos CRÍTICO ni ALTO.** Un hallazgo BAJO, ya mitigado por diseño, se deja documentado. `npm audit` (prod + dev): 0 vulnerabilidades. No se aplicó ninguna corrección de código — no hizo falta ninguna. Fase SEO omitida: no aplica (sin páginas públicas indexables).

## Hallazgos de seguridad

| # | Severidad | Hallazgo | Ubicación | Estado |
|---|---|---|---|---|
| 1 | BAJO | Código Python generado por LLM se escribe al proyecto sin revisión humana previa | `core/src/agents/generador/runGenerador.ts` | ✅ Ya mitigado por diseño |

### Detalle por hallazgo

**#1 — Código generado por LLM sin checkpoint de aprobación humana**

Agente 2 (Generador) escribe a disco el código Python que devuelve el LLM tras pasar `CodeChecker` (`ruff` + `py_compile`) — ese autochequeo es solo sintáctico/estilo, no semántico: no detecta código malicioso sintácticamente válido. A diferencia de Agente 1 (que sí exige aprobación explícita del plan Gherkin antes de continuar), Agente 2 no pide revisión humana del código antes de escribirlo — decisión de diseño ya tomada y documentada en `docs/superpowers/specs/2026-08-10-agente-2-generador-design.md` §7, no un descuido de esta pasada.

Riesgo real: un prompt malicioso (inyectado vía el texto de entrada de Agente 1, que se propaga hasta el prompt de generación de código) podría en teoría hacer que el modelo genere código Python dañino, sintácticamente válido, que pasaría el `CodeChecker` sin más.

Por qué el riesgo está acotado hoy:
- El código escrito NO se ejecuta automáticamente — hace falta un paso explícito y separado ("Ejecutar tests", Agente 3) que el usuario invoca a mano.
- `assertSafeRelativePath` (`core/src/util/assertSafeRelativePath.ts`) ya impide que el LLM controle la RUTA del fichero fuera del directorio de tests esperado (protección añadida en un commit reciente de esta misma rama de trabajo).
- Es la misma categoría de riesgo que cualquier herramienta de generación de código con IA (Copilot, Cursor, etc.): el código generado se trata como borrador a revisar, no como confiable por defecto.

No se aplica corrección de código — no hay nada que arreglar en el código en sí, es una propiedad inherente de "generar código con LLM y escribirlo a disco". Recomendación no vinculante en "Recomendaciones futuras".

### Áreas revisadas sin hallazgos

- **Secretos en el repo**: sin coincidencias reales tras grep de patrones de claves (Anthropic/OpenAI/AWS/Google/GitHub/JWT/claves privadas) sobre todo el árbol — las 3 coincidencias del patrón `sk-[A-Za-z0-9]{20,}` son fixtures de test (`"sk-ant-test"` en `anthropic.test.ts`/`init.test.ts`), no claves reales. Sin `.env`/`.npmrc` en el repo ni en el historial de git — el proyecto no usa `.env` en ningún punto, las credenciales viven fuera del repo en `~/.agente-qa/credentials.json`.
- **Permisos de credenciales**: `core/src/config/credentials.ts` ya deja `~/.agente-qa/` en `0700` y `credentials.json` en `0600` (mode explícito en la creación + `chmod` posterior para tapar instalaciones previas) — hallazgo cerrado en esta misma sesión de trabajo, antes de esta auditoría.
- **Inyección de comandos**: todo shell-out (`core/src/codeCheck/realCodeChecker.ts`, `core/src/testRun/realTestRunner.ts`) usa `child_process.spawn` con argv como array — nunca `shell: true`, `exec`/`execSync`, ni concatenación de comandos. Sin superficie de inyección.
- **Path traversal**: `assertSafeRelativePath` se aplica exactamente donde una ruta puede venir controlada por el LLM (`writeTestFiles.ts`) o por ficheros candidatos temporales (`realCodeChecker.ts`) — resuelve con `path.resolve` + comprobación de prefijo con separador final (evita el bypass clásico de `startsWith` sin separador).
- **Logging de credenciales**: sin coincidencias de `apiKey`/`credentials` en ninguna llamada a `console.*`; los errores de los proveedores LLM (`core/src/llm/providers/*.ts`) envuelven el mensaje del SDK, nunca la clave.
- **`eval`/`innerHTML`/`dangerouslySetInnerHTML`**: sin coincidencias — no aplica de todos modos, sin DOM/frontend en este proyecto.
- **Qué viaja en los tarballs publicados**: verificado en la review final del plan de empaquetado (2026-08-11) con `npm pack --dry-run` en ambos paquetes — solo `dist/**` + `package.json`, nada de tests ni fuente sin compilar.
- **Cadena de suministro**: `npm audit` (con y sin `--omit=dev`) → 0 vulnerabilidades. Lockfile (`package-lock.json`) versionado y sincronizado. Sin scripts `postinstall` sospechosos en las dependencias directas.
- **Prompt injection / datos hacia el LLM**: el texto del usuario y el plan Gherkin se pasan al modelo delimitados con comillas triples en los prompts (`core/src/prompts/intake.ts`, `generador.ts`); no hay ejecución de "decisiones" del LLM fuera del catálogo fijo de la propia pipeline (generar Gherkin, generar código Python) — no hay un LLM eligiendo herramientas/acciones dinámicamente. Sin PII estructural enviada al LLM (el usuario decide qué texto pega).

## Hallazgos SEO

No aplica — `agente-qa` es un paquete npm (CLI de terminal + librería), sin páginas web públicas indexables. Fase SEO omitida conscientemente, per el propio criterio de esta skill.

## Verificación

- `npx vitest run` → 157 passed, 9 skipped (166 tests) — sin cambios de código en esta pasada, mismo resultado que antes de la auditoría.
- `npx tsc -p core/tsconfig.json --noEmit` / `npx tsc -p cli/tsconfig.json --noEmit` → limpio en ambos.
- `npm audit --omit=dev` → 0 vulnerabilidades.
- `npm audit` (con devDependencies) → 0 vulnerabilidades.

## Recomendaciones futuras

- Añadir un aviso explícito en la salida de "Generar tests Playwright" (Agente 2) recordando revisar el código generado antes de ejecutarlo — mismo espíritu que cualquier herramienta de codegen con IA. Es un cambio de copy/UX, no de seguridad estructural; se deja como recomendación, no aplicado automáticamente (no bloquea el publish).
- Si en el futuro se añade la superficie de plugin de Claude Code (Plan 2) o cualquier servidor MCP propio, revisar de nuevo contra `references/seguridad-mcp-ia.md` §3 — hoy no aplica porque el proyecto no implementa ni consume servidores MCP.
- `core/tsconfig.tsbuildinfo` y `cli/tsconfig.tsbuildinfo` están trackeados en git sin entrada en `.gitignore` (hallazgo de higiene, no de seguridad, ya registrado en `memory.md`) — sin impacto en los tarballs publicados (`files: ["dist"]` los deja fuera igualmente).

---

# Auditoría de seguridad y SEO — Agente_QA — 2026-08-12

## Resumen ejecutivo

Auditoría previa a publicar la rama que sustituye `~/.agente-qa/credentials.json` (credenciales globales) por `<proyecto>/.agente-qa/.env` (credenciales por proyecto: URL de la app bajo test, usuario/contraseña de test, proveedor/API key/modelo LLM) — cambio disparador obligatorio de esta skill según `CLAUDE.md` ("tras tocar credenciales, auth o el manejo de API keys"). **Sin hallazgos CRÍTICO ni ALTO.** Un hallazgo BAJO (mismo patrón que el de la auditoría anterior, ahora aplicado a datos de conexión en vez de a código arbitrario) y una nota de higiene de versión (no es un hallazgo de seguridad, pero bloquea el publish si no se decide). `npm audit` (prod + dev): 0 vulnerabilidades. `npm pack --dry-run` en ambos paquetes: solo `dist/**` + metadatos, nada de fuente/tests. No hizo falta ninguna corrección de código — el mecanismo de permisos ya se dejó bien resuelto durante el propio desarrollo de la rama (ver más abajo). Fase SEO omitida: sigue sin aplicar.

## Hallazgos de seguridad

| # | Severidad | Hallazgo | Ubicación | Estado |
|---|---|---|---|---|
| 1 | BAJO | Código Python generado por LLM puede en teoría escribir un secreto en texto plano si el modelo ignora la instrucción de usar `os.environ` | `core/src/prompts/generador.ts` | ✅ Ya mitigado por diseño (mismo patrón que auditoría anterior) |

### Detalle por hallazgo

**#1 — El prompt instruye usar variables de entorno, pero nada lo garantiza estructuralmente**

Esta rama añadió una instrucción al prompt de generación de código (`core/src/prompts/generador.ts`): el código Python generado debe leer la URL de la app y las credenciales de test vía `os.environ["AGENTE_QA_APP_URL"]` etc., nunca como texto literal — porque ese código se escribe y se comitea al repo del usuario. Es una instrucción de prompt, no una garantía estructural: un modelo que la ignore podría escribir `page.goto("https://staging.mi-app.com")` con la URL real, o peor, la contraseña de test, directamente en el `.py` generado.

Por qué el riesgo está acotado:
- Mismo patrón ya documentado en el hallazgo #1 de la auditoría 2026-08-11 (código generado por LLM sin checkpoint de revisión humana antes de escribirse a disco) — esta rama no lo empeora, solo añade una categoría más de dato sensible al mismo riesgo ya aceptado.
- `realCodeChecker` (`ruff` + `py_compile`) no detecta secretos hardcodeados — es un chequeo sintáctico, no semántico ni de secret-scanning. No se le pide que lo haga en esta pasada (cambiaría su contrato, fuera de alcance de una auditoría).
- El código escrito no se ejecuta automáticamente; "Ejecutar tests" es un paso separado que el usuario invoca a mano, con oportunidad de revisar el `.py` generado antes.
- Aunque el modelo escriba una URL literal, el riesgo real es menor que con una contraseña literal: la URL de una app de staging/test no suele ser secreta en sí misma. El caso que de verdad importa (contraseña de test hardcodeada, comiteada al repo del usuario) sigue siendo posible en teoría, mismo mecanismo de mitigación que arriba.

No se aplica corrección de código — no hay nada estructural que arreglar sin cambiar el contrato de `realCodeChecker`, que es una decisión de diseño ya tomada (`docs/superpowers/specs/2026-08-11...codechecker`). Recomendación no vinculante abajo.

### Corrección de un hallazgo de la auditoría anterior, ya vencido por el propio desarrollo de la rama

La entrada "Permisos de credenciales" de la auditoría 2026-08-11 (arriba) describe `core/src/config/credentials.ts`, que **ya no existe** — esta rama lo sustituyó por `core/src/config/projectEnv.ts`. Reverificado contra el código actual, no como reafirmación ciega de lo ya escrito:

- `ensureProjectEnvTemplate` (`core/src/config/projectEnv.ts:82-113`) aplica `fs.chmod(dirPath, 0o700)` y `fs.chmod(filePath, 0o600)` **incondicionalmente en cada llamada** (no solo al crear) — corrige un bug real encontrado en la propia revisión final de esta rama, donde el `mode` de creación de `fs.mkdir` era un no-op porque el directorio ya existía (creado antes, sin `mode`, por `saveProjectConfig`). El fix mantiene el `mode` de creación (protege la ventana entre `mkdir`/`writeFile` y el `chmod` posterior) y añade el `chmod` sobre cualquier estado previo — mismo patrón que documentó la corrección análoga sobre `credentials.ts` en `memory.md` (2026-08-11), aplicado correctamente aquí también.
- `.agente-qa/.gitignore` (contenido `.env\n`) se escribe **incondicionalmente en cada llamada**, antes de tocar el `.env` — si esa escritura falla, la función lanza antes de llegar a escribir el `.env`, así que no existe ninguna ventana donde el `.env` exista sin estar protegido por el `.gitignore`. Verificado leyendo el orden exacto de las operaciones, no solo el comentario que lo describe.
- `loadProjectEnv` usa `dotenv.parse()`, nunca `dotenv.config()` — no muta `process.env` de forma implícita en ningún punto del código (`grep` de `dotenv\.` en todo `core/src`/`cli/src`: única coincidencia, el import de `parse`).

Corrección aplicada a la afirmación desactualizada de la sección 2026-08-11: **"el proyecto no usa `.env` en ningún punto"** ya no es cierta para los proyectos consumidores (sí lo sigue siendo para el propio repo `Agente_QA`, que nunca crea un `.env` para sí mismo — verificado sin coincidencias de `.env` en su propio historial de git ni en su propio `.gitignore` de raíz).

### Áreas revisadas sin hallazgos nuevos

- **Secretos reales en el repo**: sin coincidencias de patrones de claves reales tras grep de todo el árbol; las únicas coincidencias de `sk-` son fixtures de test (`"sk-test"` en varios `*.test.ts`, ya revisadas en cada tarea de la rama).
- **Inyección vía las nuevas variables de entorno**: `TestRunOptions.env` se fusiona como objeto plano (`{ ...process.env, ...runOptions.env }`) y se pasa a `child_process.spawn(command, args, { cwd, env })` — nunca `shell: true`, así que no hay superficie de inyección de comandos vía el contenido de una variable de entorno maliciosa en el `.env` del usuario.
- **Qué viaja en los tarballs publicados**: reverificado con `npm pack --dry-run` en ambos paquetes tras el build de esta rama — sigue siendo solo `dist/**` + `package.json` (+ `LICENSE`/`README.md`), nada de fuente sin compilar ni tests.
- **Cadena de suministro**: `npm audit` (con y sin `--omit=dev`) → 0 vulnerabilidades, igual que en la auditoría anterior. Única dependencia nueva de esta rama: `dotenv@^17.4.2` — sin vulnerabilidades reportadas, cero dependencias propias.
- **Plantilla `.env`**: el ejemplo de `AGENTE_QA_LLM_API_KEY` (`sk-ant-xxxxxxxxxxxxxxxx`) y el de `AGENTE_QA_TEST_PASSWORD` (`Sup3rSecreta!`) son evidentemente ficticios, no claves reales ni patrones que un scanner automático pudiera confundir con una clave real filtrada.

## Hallazgos SEO

No aplica — sigue sin haber páginas web públicas indexables.

## Verificación

- `npx vitest run` → 208 passed, 3 skipped (211) — sin cambios de código en esta pasada de auditoría.
- `npx tsc -p core/tsconfig.json --noEmit` / `npx tsc -p cli/tsconfig.json --noEmit` → limpio en ambos.
- `npm audit --omit=dev` → 0 vulnerabilidades.
- `npm audit` (con devDependencies) → 0 vulnerabilidades.
- `npm pack --dry-run` en `core/` y `cli/` → contenido del tarball verificado, solo `dist/**` + metadatos.

## Nota de higiene de versión (no es un hallazgo de seguridad, pero bloquea el publish)

`core/package.json` y `cli/package.json` siguen en `0.1.4` — la misma versión ya publicada en npm (`npm view @agente-qa/core version` / `npm view agente-qa version` → `0.1.4` ambos). Esta rama introduce un cambio de comportamiento incompatible hacia atrás sin subir de versión: cualquier usuario con `~/.agente-qa/credentials.json` de una instalación anterior lo verá completamente ignorado tras actualizar, sin aviso — tendrá que volver a ejecutar `agente-qa init` y rellenar el `.env` a mano. No es un hallazgo de seguridad (no hay fuga de datos), pero republicar sin subir de versión ni es posible (`npm publish` rechaza una versión ya publicada) ni sería correcto de cara al usuario (rompe semver). Necesita una decisión del usuario antes de publicar — no es algo que esta skill decida por su cuenta.

## Recomendaciones futuras

- (Ya recomendado en la auditoría anterior, sigue sin aplicarse) Añadir un aviso en la salida de "Generar tests Playwright" recordando revisar el código antes de ejecutarlo.
- Si se quiere cerrar del todo el hallazgo #1 de esta pasada, una opción futura no aplicada aquí (cambia el contrato de `CodeChecker`, decisión de diseño, no autofix): añadir una regla de `ruff` o un grep post-generación que bloquee patrones como `https?://` o contraseñas de más de N caracteres literales en los ficheros generados, en vez de confiar solo en la instrucción del prompt.

---

# Auditoría de seguridad y SEO — Agente_QA — 2026-08-13

## Resumen ejecutivo

Auditoría disparada por la rama "Site Explorer" (Agente 2): antes de generar código, un navegador real (Playwright, Node) verifica rutas/localizadores contra la aplicación bajo test, incluyendo inicio de sesión real con las credenciales de test cuando el escenario lo requiere — cambio que dispara la skill obligatoriamente según `CLAUDE.md` ("tras tocar credenciales, auth"). Esta rama ya había pasado por un proceso de review adversarial propio durante su desarrollo (3 rondas de corrección sobre cómo se redactan las credenciales antes de mandarlas al LLM, documentadas en el ledger de `subagent-driven-development`), así que esta auditoría se centra en una pasada independiente, a nivel de todo el proyecto, no solo en re-revisar lo ya cubierto tarea a tarea.

**Corrección importante sobre esta misma pasada** (ver "Adenda" al final de esta sección): la afirmación original de este resumen — "el LLM nunca recibe la credencial real" — resultó **incompleta**. Esta auditoría verificó correctamente que el LLM del propio explorador (el que decide qué acción tomar durante la exploración) nunca la recibe, pero no verificó el segundo consumidor de esa misma evidencia: el LLM de generación de código (Agente 2), que recibía la `ScreenEvidence` sin redactar. Lo encontró la review final de rama (un proceso distinto, posterior, que mira las 10 tareas juntas) y ya está corregido — hallazgo #4 más abajo, añadido a esta misma fecha en vez de abrir una entrada nueva.

**Total tras la corrección: 1 hallazgo CRÍTICO, 1 MEDIO y 2 BAJO, todos corregidos.** Un hallazgo BAJO adicional queda documentado y aceptado (riesgo residual ya conocido, no alcanzable por ningún camino de código real hoy). `npm audit` (prod + dev): 0 vulnerabilidades. `npm pack --dry-run` en ambos paquetes: revisado y corregido (ver hallazgo #2). Fase SEO omitida: sigue sin aplicar.

## Hallazgos de seguridad

| # | Severidad | Hallazgo | Ubicación | Estado |
|---|---|---|---|---|
| 1 | MEDIO | El explorador agentic podía rellenar credenciales de test en una página de otro origen | `core/src/siteExplorer/realSiteExplorer.ts` | ✅ Corregido |
| 2 | BAJO | Servidor HTTP de test (con credenciales de fixture hardcodeadas) se compilaba al `dist/` publicado | `core/tsconfig.build.json` | ✅ Corregido |
| 3 | BAJO | El redactor de credenciales en URL solo cubre rutas/fragmentos con un fallback literal (no decodificado) | `core/src/siteExplorer/realSiteExplorer.ts` | ⏳ Aceptado (no alcanzable hoy, documentado) |
| 4 | CRÍTICO | La evidencia capturada (`ScreenEvidence`) se devolvía sin redactar y llegaba íntegra al prompt de generación de código — un segundo LLM nunca cubierto por la redacción del hallazgo #1 | `core/src/siteExplorer/realSiteExplorer.ts` | ✅ Corregido (encontrado por la review final de rama, no por esta auditoría) |
| 5 | MEDIO | El camino rápido (`performRealLogin`) tecleaba credenciales reales sin la misma comprobación de origen que el hallazgo #1 añadió al camino agentic | `core/src/siteExplorer/realSiteExplorer.ts` | ✅ Corregido (encontrado por la review final de rama) |

### Detalle por hallazgo

**#1 — Relleno de credenciales sin comprobar el origen de la página (MEDIO)**

El camino "agentic" del explorador (cuando no hay patrón conocido o las rutas conocidas fallan) deja que el LLM decida a qué navegar (`goto`) y en qué campo escribir la credencial de test (`fill_credential`), a partir de lo que lee en el snapshot de accesibilidad de la página real. Antes de esta pasada, ni `goto` ni `fill_credential` comprobaban que el destino siguiera siendo el mismo origen que `AGENTE_QA_APP_URL` (la app que el usuario configuró).

Riesgo real: la app bajo test puede legítimamente enlazar a otro origen dentro de un flujo de login (un botón "Iniciar sesión con Google", un enlace comprometido por XSS, un anuncio) — el snapshot de accesibilidad se lo mostraría al LLM como un elemento más de la pantalla, y el LLM no tiene forma de saber que seguirlo es distinto de seguir un enlace interno. Si lo sigue y a continuación intenta `fill_credential` pensando que sigue en el flujo de login, la contraseña de test real se escribiría en un formulario que no pertenece a la aplicación que el usuario configuró — sin que el usuario lo pidiera ni lo aprobara.

Corrección aplicada (`core/src/siteExplorer/realSiteExplorer.ts`, función `isSameOrigin`): `goto` rechaza cualquier destino cuyo origen no coincida con `AGENTE_QA_APP_URL` (no navega, deja constancia en `onStep`); `fill_credential` rechaza escribir en cualquier pantalla cuyo origen actual no coincida — esta segunda comprobación es la protección real, porque `goto` no es el único vector de navegación: un click real sobre un `<a href>` de la propia página deja el navegador en otro origen sin pasar nunca por el código `goto`. Verificado con dos tests contra dos servidores de fixture reales en puertos distintos (origen distinto de verdad, no simulado): uno prueba que el `goto` cruzado se rechaza, otro prueba que un click real a un enlace externo sí navega (la app puede tener enlaces externos legítimos) pero el `fill_credential` posterior queda bloqueado y la credencial nunca llega a escribirse en la página de destino (comprobado leyendo el snapshot de accesibilidad final, no solo confiando en que no se llamó a una función).

Severidad MEDIO, no ALTO/CRÍTICO: requiere que la app bajo test tenga contenido de otro origen alcanzable durante el flujo que el escenario describe (no cualquier app lo tiene), y el usuario ve la sesión en un navegador visible (`headed: true`) mientras ocurre.

**#2 — El servidor de test del explorador viajaba en el paquete publicado (BAJO)**

`core/src/siteExplorer/testFixtureApp.ts` es un servidor HTTP local usado solo por `realSiteExplorer.test.ts` para probar la redacción de credenciales contra un navegador real — incluye credenciales de fixture hardcodeadas (`qa-tester@example.com` / `hunter2-test-only`, evidentemente ficticias, no reales). `core/tsconfig.build.json` solo excluía `**/*.test.ts` del build; como este fichero no termina en `.test.ts`, se compilaba a `dist/siteExplorer/testFixtureApp.js` y viajaba en el tarball de `npm pack` — verificado con `npm pack --dry-run` antes y después del fix. No es una fuga de secreto real (los valores son ficticios y ya se usaban igual en los tests, visibles en el código fuente del repo), pero es código muerto en el paquete publicado (nunca se importa desde ningún fichero de producción ni se exporta del barrel) con forma exacta de credenciales — el tipo de cadena que un scanner de secretos automático en un consumidor aguas abajo podría marcar como falso positivo.

Corrección aplicada: `core/tsconfig.build.json` excluye ahora también `src/siteExplorer/testFixtureApp.ts` explícitamente. Reverificado con `npm pack --dry-run`: ya no aparece en el tarball; `FakeSiteExplorer` (`testUtils.js`, sí forma parte deliberada de la API pública para que los consumidores lo usen en sus propios tests) sigue presente, sin cambios.

**#3 — Redacción de credenciales en rutas/fragmentos de URL, solo literal (BAJO, aceptado)**

Ya documentado durante el desarrollo de esta rama (ronda 3 del bucle de corrección de `subagent-driven-development`, ver `docs/superpowers/plans/2026-08-13-agente-2-site-explorer.md` y su ledger): `redactCredentialsFromUrl` decodifica y compara correctamente los parámetros de query string (donde una credencial llega tras un envío de formulario real), pero el *fallback* literal que se aplica al resto de la URL (ruta, fragmento) no decodifica — hereda la misma clase de fragilidad de codificación que ya se cerró para el caso de query string. Revisado de nuevo en esta auditoría, no solo reafirmado: hoy no existe ningún camino de código donde una credencial real llegue a `page.url()` fuera de un parámetro de query string (el único mecanismo que la escribe ahí es un envío de formulario nativo, que siempre serializa a query string) — así que el hueco es real pero no alcanzable con el código actual. Se deja documentado en vez de corregido para no ampliar el alcance de esta pasada sin necesidad; si en el futuro se añade algún camino que pueda dejar una credencial en la ruta o el fragmento de una URL (p. ej. una app bajo test que la incluya ahí por diseño), revisar `redactCredentialsFromUrl`/`redactLiteralCredentials` entonces.

**#4 — La evidencia capturada llegaba sin redactar al LLM de generación de código (CRÍTICO)**

Esta auditoría (hallazgo #1 de esta misma pasada) redactó correctamente el prompt del propio explorador — el LLM que decide qué acción tomar durante la exploración nunca ve una credencial real. Lo que esta auditoría **no comprobó** en su momento: la misma `ScreenEvidence` que el explorador devuelve al llamador (`runGenerador.ts`) se pasa íntegra, sin redactar, al prompt de generación de código (`core/src/prompts/generador.ts` → `codeGenerationPrompt`) — un **segundo** LLM, con un consumidor distinto (Agente 2, el generador de tests), que ese hallazgo #1 nunca cubrió. Ese prompt además instruye explícitamente "usa estas rutas y estos nombres accesibles reales, no inventes otros", lo que empuja al modelo a copiar literalmente lo que reciba — incluida una credencial, si estaba presente en el snapshot de accesibilidad (p. ej. tras un login fallido, donde el campo de usuario/contraseña ya rellenado queda visible en el árbol de accesibilidad) o en la URL (tras un envío de formulario nativo). De haber ocurrido, el `.py` generado con la credencial en texto literal se habría escrito al repo del usuario.

Lo encontró la **review final de rama** de `subagent-driven-development` (no esta auditoría): un proceso posterior que mira las 10 tareas de la rama juntas, precisamente diseñado para detectar lo que ninguna revisión de una tarea aislada puede ver — cada tarea había cumplido su propio contrato (la Tarea 5 redactó el prompt del explorador; la Tarea 6 cableó la evidencia al prompt de codegen sin saber que podía llevar secretos).

Corrección aplicada: función compartida `captureEvidence` (`core/src/siteExplorer/realSiteExplorer.ts`) que redacta (reutilizando `redactCredentialsFromUrl`/`redactLiteralCredentials`, ya auditados) antes de construir el objeto `ScreenEvidence`, usada en los tres puntos donde antes se construía sin pasar por ella. Verificado por mutación, no solo por el test en verde: revirtiendo temporalmente la redacción dentro de `captureEvidence`, el nuevo test de `core/src/agents/generador/runGenerador.test.ts` (explorador real, fixture "leaky", hasta el prompt de codegen) falla mostrando la contraseña real en texto plano; restaurada la redacción, vuelve a pasar.

**#5 — El camino rápido tecleaba credenciales sin la misma comprobación de origen que el camino agentic (MEDIO)**

El hallazgo #1 de esta pasada añadió la comprobación de mismo-origen (`isSameOrigin`) solo al camino "agentic". `performRealLogin` (el camino rápido, usado siempre que `navigationHints.requiresLogin` es cierto — el caso común) seguía tecleando la contraseña real sin ninguna comprobación. `page.goto()` sigue redirecciones: una app cuya ruta de login haga un 302 a un proveedor de login externo (Clerk, Auth0, Okta hosted login — precisamente la familia de la app que originó esta funcionalidad) dejaría el navegador en otro origen y `performRealLogin` escribiría ahí la contraseña real.

También lo encontró la review final de rama. Corrección aplicada: la misma comprobación de `isSameOrigin`, ahora también antes de `performRealLogin` — mismo criterio en los dos caminos (nunca teclear una credencial fuera del origen configurado en `AGENTE_QA_APP_URL`, sin mecanismo de lista blanca para proveedores externos, decisión deliberada para esta pasada). Verificado con un nuevo modo de fixture (`redirect-login`, un 302 real) y un test que comprueba el rechazo.

### Corrección a una afirmación de esta misma auditoría

La entrada "El LLM nunca recibe la credencial real" (más abajo, en "Áreas revisadas") solo era cierta para el LLM del propio explorador — no para el de generación de código, por el hallazgo #4 de arriba. Corregida in situ.

### Áreas revisadas sin hallazgos nuevos

- **Secretos reales en el repo**: grep de patrones de claves reales (Anthropic/OpenAI/AWS/Google/GitHub/JWT/claves privadas/cadenas de conexión) sobre todo el árbol, sin coincidencias. Las credenciales de fixture de esta rama (`hunter2-test-only`, `qa-tester@example.com`) son evidentemente ficticias y ya estaban en el propio código fuente del repo (no es una fuga nueva) — el hallazgo real era que viajaran también al `dist/` publicado (#2, ya corregido).
- **Inyección de comandos**: el nuevo `realSiteExplorer.ts` controla el navegador vía la API de Playwright (`chromium.launch()`, `page.goto()`, etc.), nunca vía `child_process`/shell — no añade superficie de inyección de comandos (mismo patrón ya verificado en auditorías anteriores para `realCodeChecker`/`realTestRunner`, que sí usan `spawn` con argv como array).
- **Logging de credenciales**: los mensajes de progreso (`onStep`, cableados a `console.log` solo en `cli/src/commands/generate.ts`) nunca incluyen el valor de una credencial — se limitan a nombres de acción, rutas probadas y mensajes de estado; revisado línea a línea en `realSiteExplorer.ts`, no solo por el nombre de la variable.
- **El LLM del explorador nunca recibe la credencial real** (afirmación acotada tras la corrección de arriba): el esquema `ExplorerActionSchema` (`fill_credential`) solo permite que el modelo indique QUÉ campo rellenar (`"username"`/`"password"`), nunca un valor — estructuralmente imposible que el modelo pida escribir un valor concreto, verificado en el propio esquema zod, no solo en el prompt. Tras el hallazgo #4, esto ahora es cierto también para el LLM de generación de código, verificado con un test end-to-end (explorador real → `runGenerador` → prompt de codegen), no solo con el esquema.
- **Cadena de suministro**: `npm audit` (con y sin `--omit=dev`) → 0 vulnerabilidades. Única dependencia nueva de esta rama: `playwright` (Node) — sin vulnerabilidades reportadas. Lockfile (`package-lock.json`) actualizado y versionado en el mismo commit que añadió la dependencia.
- **Qué viaja en los tarballs publicados**: `npm pack --dry-run` en ambos paquetes tras el build — `cli/` sin cambios relevantes; `core/` corregido (#2).

## Hallazgos SEO

No aplica — sigue sin haber páginas web públicas indexables.

## Verificación

- `npx vitest run` → 251 passed, 3 skipped (254) — cifra final tras los hallazgos #1/#2 de esta auditoría y los hallazgos #4/#5 encontrados por la review final de rama, incluyendo el test end-to-end nuevo (explorador real → `runGenerador` → prompt de codegen) y su verificación por mutación.
- `npx tsc -p core/tsconfig.json --noEmit` / `npx tsc -p cli/tsconfig.json --noEmit` → limpio en ambos.
- `npm audit --omit=dev` → 0 vulnerabilidades.
- `npm audit` (con devDependencias) → 0 vulnerabilidades.
- `npm pack --dry-run` en `core/` (antes y después del fix #2) y en `cli/` → contenido del tarball verificado.

## Recomendaciones futuras

- Si en el futuro el explorador agentic gana la capacidad de interactuar con iframes u otras páginas (`page.frames()`), extender la comprobación de mismo-origen a ese contexto también — hoy solo opera sobre `page` de nivel superior.
- Cerrar del todo el hallazgo #3 si alguna vez se identifica un camino de código real que deje una credencial en la ruta/fragmento de una URL (hoy no existe ninguno, ver detalle arriba).
- (No es un hallazgo de seguridad, pero relacionado) `runGenerador` tiene ahora 10 parámetros posicionales, varios `string` contiguos (`featureFilePath`, `projectRoot`, `testsDir`, `baseUrl`) — intercambiar dos compila sin error y falla en runtime de forma oscura. Señalado por la review final de rama como Important de mantenibilidad, no de seguridad; el cableado actual está verificado correcto, se deja como refactor futuro (objeto de opciones) sin bloquear esta rama.
- (Ya señalado en la auditoría del 2026-08-12, sigue pendiente) Los paquetes siguen en `0.1.6`, ya publicada — esta rama introduce cambios incompatibles (`generateCode`/`runGenerador` cambian de firma, `GeneratorCallbacks` gana un miembro obligatorio, nuevo prerequisito de instalación). No bloquea el merge, sí el `publish` — decidir el bump de versión antes de publicar, no antes de mergear.
- (Recomendaciones ya existentes de auditorías anteriores, siguen sin aplicarse — ver secciones 2026-08-11/2026-08-12 arriba.)
