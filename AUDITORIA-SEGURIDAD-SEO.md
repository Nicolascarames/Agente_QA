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
