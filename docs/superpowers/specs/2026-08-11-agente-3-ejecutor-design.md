# Agente 3 — Ejecutor (selecciona y lanza tests) — Diseño

Fecha: 2026-08-11
Estado: Aprobado para pasar a plan de implementación
Depende de: `docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md` (§5 define el contrato de entrada/salida de este agente a alto nivel) y `docs/superpowers/specs/2026-08-10-agente-2-generador-design.md` (Agente 3 consume directamente lo que genera Agente 2).

## 1. Objetivo

Segundo sub-proyecto de "Plan 2" tras Agente 2 (memory.md). Agente 3 toma los tests Playwright ya generados (Agente 2), deja elegir al usuario qué subconjunto lanzar por tags Gherkin, los ejecuta con `pytest`, y produce un `junit-xml` que alimentará al Agente 4 (reportes).

### No objetivos de este sub-proyecto

- Agente 4 (reportes) — spec propia, después. Agente 3 no parsea el `junit-xml` que produce, solo garantiza que existe en una ruta predecible.
- Empaquetado/publicación npm — sigue pendiente, sin relación con este trabajo.
- Tracing de Playwright (`context.tracing`) — la spec global §5 solo pide capturas/vídeo, no trazas. Queda fuera de v1.

## 2. Divergencia sobre Agente 2 (corrección de alcance)

Investigando cómo capturar screenshots/vídeo solo en fallo (spec global §5: "retain-on-failure nativo de Playwright"), se encontró que el `conftest.py` que genera Agente 2 hoy (`core/src/prompts/generador.ts`) define los fixtures `browser`/`page` a mano vía `playwright.sync_api`, en vez de depender del plugin `pytest-playwright`. Con fixtures caseras las flags nativas `--screenshot`/`--video` de ese plugin no se enganchan — y el vídeo en concreto necesita configurarse en el momento de crear el `context` (`browser.new_context(record_video_dir=...)`), código que vive dentro de ese `conftest.py` generado por LLM con estructura libre (no garantiza siquiera un fixture `context` nombrado).

**Decisión**: adoptar `pytest-playwright` como dependencia del proyecto generado, y simplificar Agente 2 en consecuencia:

- `core/src/prompts/generador.ts` (`codeGenerationPrompt`): pasa de pedir 3 ficheros a pedir **2**: `tests/test_<slug>.py` (step defs, usa el fixture `page` que provee el plugin automáticamente) y `pages/<slug>_page.py` (Page Objects). Se elimina la instrucción de generar `conftest.py` — ya no hace falta código propio para browser/page/context.
- `core/src/agents/generador/runGenerador.ts` y `writeTestFiles.ts`: se elimina el caso especial `file.path === "conftest.py"` (skip del check de overwrite, skip-if-exists) — ya no aplica.
- `core/src/agents/generador/codeGenerator.test.ts` y `runGenerador.test.ts`: los fixtures de test que asumían 3 ficheros se actualizan a 2.
- Nueva dependencia Python de cualquier proyecto generado: `pytest-playwright` (además de `pytest`, `pytest-bdd`, `playwright`, ninguna declarada hoy en ningún `requirements.txt` — el sistema no gestiona dependencias Python del proyecto del usuario, solo las documenta en `README.md` como ya se hizo para `ruff`).

Este documento reemplaza, para el alcance de Agente 2, la sección 8 ("Estructura de ficheros generados") y la sección 6 (arquitectura, en la parte de `conftest.py`) de `2026-08-10-agente-2-generador-design.md`. Ese documento no se reescribe (zona intocable); esta sección es la corrección vigente.

## 3. Cómo Agente 3 sabe qué tags existen

Cada `.feature` puede llevar tags Gherkin (`@smoke`, `@regression`, etc.) sobre `Feature:` o sobre cada `Scenario:`. `pytest-bdd` los convierte automáticamente en markers de pytest (nombre sin la `@`) — es el puente ya fijado en la spec de Agente 2 §5.

`listAvailableTags(projectRoot, testsDir)`: lee todos los `.feature` bajo `<testsDir>/features/` (reutiliza `listFeatureFiles` ya existente), extrae con una expresión regular las líneas que son solo tags (`^\s*(@\S+\s*)+$`), acumula el conjunto único de tags de todos los ficheros, ordenado alfabéticamente. No necesita un parser Gherkin completo — no se generan falsos positivos porque las únicas líneas que empiezan por `@` en un `.feature` son líneas de tags.

## 4. Arquitectura y componentes

```
core/src/agents/ejecutor/
  listAvailableTags.ts     # escanea features/*.feature, extrae tags únicos
  runEjecutor.ts             # orquestador: construye comando, invoca TestRunner
core/src/testRun/
  testRunner.ts               # interfaz TestRunner (equivalente a CodeChecker)
  realTestRunner.ts           # implementación real: spawn a "python -m pytest"
```

Mismo patrón DI que `core/src/codeCheck/`: interfaz + implementación real que hace shell-out a un proceso externo (no es I/O de terminal con el usuario — el mismo principio que ya aplican `LLMProvider` y `CodeChecker`).

## 5. Flujo de datos (`runEjecutor.ts`)

Entrada: `projectRoot`, `testsDir`, `TestRunner`, `ExecutorCallbacks`.

1. `listAvailableTags(projectRoot, testsDir)`. Si no hay ningún `.feature`, error claro: "No hay tests generados todavía. Usa 'Generar tests Playwright' primero."
2. `callbacks.selectTags(availableTags)` → subconjunto elegido por el usuario (la CLI valida que se elija al menos un tag; `runEjecutor` no contempla selección vacía). Si el subconjunto es igual al conjunto completo de tags disponibles, se interpreta como "lanzar todo": no se aplica filtro `-m` (así se incluyen también escenarios sin ningún tag, que un filtro por marker excluiría). Si es un subconjunto estricto, se construye una expresión de marker `tag1 or tag2 or ...` (sin el `@`).
3. `callbacks.selectCaptureMode()` → `"off" | "only-on-failure" | "always"`. Mapeo a flags nativas de `pytest-playwright`:
   - `off` → `--screenshot=off --video=off`
   - `only-on-failure` → `--screenshot=only-on-failure --video=retain-on-failure`
   - `always` → `--screenshot=on --video=on`
4. Se asegura que existe `<projectRoot>/<testsDir>/results/` (`fs.mkdir(..., { recursive: true })`). Ruta fija del resultado: `<projectRoot>/<testsDir>/results/latest.xml` — cada ejecución la sobreescribe (decisión v1, ver §10).
5. `checker.run({ cwd: <projectRoot>/<testsDir>, markerExpression, screenshotMode, videoMode, junitXmlPath: "<projectRoot>/<testsDir>/results/latest.xml", onOutput: callbacks.onOutput })`.
6. Resultado: `{ exitCode, junitXmlPath, browserSetupWarning?: string }`.

Salida: el objeto anterior. Agente 3 no lanza excepción por tests fallidos (exit code 1 de pytest es resultado normal) — solo lanza si `TestRunner` señala un fallo de arranque (ver §7).

## 6. Interfaces

```typescript
// core/src/testRun/testRunner.ts
export interface TestRunOptions {
  cwd: string;
  markerExpression: string | null; // null = sin filtro, lanzar todo
  screenshotMode: "off" | "only-on-failure" | "on";
  videoMode: "off" | "retain-on-failure" | "on";
  junitXmlPath: string;
  onOutput: (chunk: string) => void;
}

export interface TestRunResult {
  exitCode: number;
  browserSetupWarning?: string; // detectado si el output sugiere navegadores sin instalar
}

export interface TestRunner {
  run(options: TestRunOptions): Promise<TestRunResult>;
}
```

```typescript
// core/src/agents/ejecutor/runEjecutor.ts
export interface ExecutorCallbacks {
  selectTags(availableTags: string[]): Promise<string[]>;
  selectCaptureMode(): Promise<"off" | "only-on-failure" | "always">;
  onOutput(chunk: string): void;
}
```

## 7. Manejo de errores

Tres clases, coherentes con la spec global §8 y con el precedente de Agente 2 §10:

- **Herramienta ausente** (`pytest`/`pytest-bdd`/`pytest-playwright` no instalados): preflight antes de ejecutar nada, `python -c "import pytest, pytest_bdd, pytest_playwright"`. Si falla (`ModuleNotFoundError` o `python` con `ENOENT`), error inmediato y claro apuntando a `pip install pytest pytest-bdd pytest-playwright` — no entra en ningún bucle de reintento, igual que `MissingCodeToolError` en Agente 2.
- **Navegadores no instalados** (`playwright install` pendiente): no se puede detectar en preflight, solo al lanzar un browser dentro de un test. Si el output combinado de la ejecución contiene la firma característica de ese error, `TestRunner` lo señala en `browserSetupWarning` — se muestra como aviso adicional junto al resultado normal, no se trata como fallo fatal del sistema (spec global §8 ya distingue este caso).
- **Fallos de test individuales**: resultado normal de una ejecución de QA (exit code 1 de pytest), no error del sistema — va al `junit-xml`, lo consume el Agente 4.

No hay manejo de errores de LLM/API en este agente — no invoca ningún modelo, es orquestación pura.

## 8. Testing

Mismo patrón DI que `CodeChecker`/`LLMProvider`: `runEjecutor` se testea con un `FakeTestRunner` (in-memory, determinista, sin Python real) — vitest no depende de tener Python/pytest-playwright instalados para correr. `listAvailableTags` se testea con `fs.mkdtemp` real (mismo patrón que `listFeatureFiles`).

`realTestRunner` (la implementación que hace `spawn` real a `python -m pytest`) tiene su propio test aparte, gated (`describe.skipIf`) si no hay Python + `pytest-playwright` instalados en la máquina — mismo mecanismo ya usado para `realCodeChecker`.

## 9. CLI

`cli/src/commands/execute.ts` (espejo de `generate.ts`): carga config de proyecto, valida que hay tests generados, llama `listAvailableTags`, `prompts.selectTags` (checkbox, inquirer), `prompts.selectCaptureMode` (list, sugerencia por defecto `only-on-failure`), conecta `onOutput` a `process.stdout.write` para ver la ejecución en vivo. Al terminar, resumen mínimo: exit code, ruta del `junit-xml`, y el aviso de navegadores si aplica. No parsea el XML — eso es Agente 4. Wiring en `cli/src/menu.ts`, opción 3 "Ejecutar tests".

## 10. Puntos abiertos para specs futuras

- Agente 4 (reportes): parseo del `junit-xml` de `<testsDir>/results/latest.xml`, generación de `pytest-html` y resumen Markdown (spec global §5).
- Tracing de Playwright (`context.tracing`) — no se aborda en v1, ver §1.
- Historial de ejecuciones (guardar más de un `junit-xml` con timestamp) — se decidió explícitamente ruta fija sobreescrita para v1; si Agente 4 necesita comparar ejecuciones, revisar entonces.
- `results/` dentro de `<testsDir>` no se añade a ningún `.gitignore` automáticamente — si conviene evitar que resultados de ejecución se commiteen, se decide en el plan de implementación o se deja como nota para el usuario en el README.
