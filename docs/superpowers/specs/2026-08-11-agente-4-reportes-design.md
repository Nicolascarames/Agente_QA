# Agente 4 — Reportes (resultados de ejecución → reporte extendido + resumen) — Diseño

Fecha: 2026-08-11
Estado: Aprobado para pasar a plan de implementación
Depende de: `docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md` (§5 define el contrato de entrada/salida de este agente a alto nivel) y `docs/superpowers/specs/2026-08-11-agente-3-ejecutor-design.md` (Agente 4 consume directamente lo que produce Agente 3).

## 1. Objetivo

Cuarto y último sub-proyecto de "Plan 2" (memory.md). Agente 4 toma los resultados de la última ejecución de tests (Agente 3) y produce un resumen legible: conteo pass/fail/skip, duración total y listado de fallos, en Markdown; más la confirmación de que el reporte extendido (`pytest-html`, autocontenido, con capturas/vídeo embebidos) ya existe y dónde está.

### No objetivos de este sub-proyecto

- Empaquetado/publicación npm — sigue pendiente, sin relación con este trabajo.
- Historial de ejecuciones o comparación entre lanzamientos — Agente 3 fija una única ruta sobreescrita (`results/latest.xml`), decisión ya tomada en su propia spec §10; este documento no la revisa.
- Abrir el `.html` automáticamente en el navegador del usuario — fuera de alcance v1, YAGNI (el usuario ya tiene la ruta, la abre él).

## 2. Divergencia sobre Agente 3 (corrección de alcance)

La spec global (§5, "Agente 4") fija que el reporte extendido se genera con `pytest-html`, "un único `.html` autocontenido, embebe capturas/vídeo por test". Investigando cómo encajar esto en un agente que corre *después* de que los tests ya se ejecutaron, se encontró que **`pytest-html` no puede generar un reporte a partir de un `junit-xml` ya existente** — es un plugin de pytest que solo produce su reporte durante la propia invocación de pytest (necesita el flag `--html=<ruta> --self-contained-html` en esa misma ejecución; la integración con capturas/vídeo de `pytest-playwright` también depende de que ambos plugins estén activos en el mismo proceso).

**Decisión**: Agente 3 pasa a generar siempre el `.html`, no solo el `junit-xml`:

- `core/src/testRun/testRunner.ts` (`TestRunOptions`): añade `htmlReportPath: string`. A diferencia de `screenshotMode`/`videoMode` (que sí se preguntan al usuario en cada lanzamiento), esto no es opcional ni se pregunta — se genera siempre.
- `core/src/testRun/realTestRunner.ts`: añade `--html=${runOptions.htmlReportPath} --self-contained-html` a la misma invocación de `python -m pytest` que ya lleva `--screenshot`/`--video`/`--junitxml`.
- `core/src/agents/ejecutor/runEjecutor.ts`: calcula la ruta fija `<projectRoot>/<testsDir>/results/latest.html` (mismo patrón que `latest.xml`: se sobreescribe cada ejecución, sin preguntar), la pasa al `TestRunner` y la añade a `EjecutorResult`.
- Nueva dependencia Python de cualquier proyecto generado: `pytest-html` (además de `pytest`, `pytest-bdd`, `pytest-playwright`, `playwright`) — se documenta en `README.md` como las anteriores.
- Tests existentes que cubren `TestRunOptions`/`realTestRunner`/`runEjecutor`/`execute.ts` se actualizan para reflejar el nuevo campo obligatorio.

Con esto, Agente 4 nunca invoca `pytest` ni genera el `.html` — solo confirma su ruta (ya fija y conocida) y construye el resumen a partir del `junit-xml`, que sí puede leerse después del hecho sin problema (es solo XML).

## 3. Arquitectura y componentes

```
core/src/agents/reportes/
  parseJunitResults.ts        # XML (junit) → estructura tipada
  generateSummaryMarkdown.ts   # estructura + nivel de detalle → texto Markdown
  runReportes.ts                # orquestador
```

A diferencia de Agente 3, este agente no necesita el patrón DI de interfaz+fake+real: no shell-ea ningún proceso externo, solo lee un fichero y parsea XML con una librería. Se testea con ficheros junit-xml de ejemplo escritos a un directorio temporal real (mismo estilo que el resto del proyecto: sin mocks de `fs`).

**Nueva dependencia de `core`**: [`fast-xml-parser`](https://www.npmjs.com/package/fast-xml-parser) — sin dependencias nativas, tipos TS incluidos, se configura con `isArray` para garantizar que `testsuite`/`testcase` sean siempre array aunque haya un único elemento (el XML de pytest colapsa a objeto suelto si no se fuerza).

## 4. Formato de entrada: `junit-xml` de pytest

Estructura esperada (raíz `<testsuites>` con una o más `<testsuite>`, cada una con `<testcase>`):

```xml
<testsuites>
  <testsuite name="pytest" tests="5" failures="1" errors="0" skipped="1" time="2.341">
    <testcase classname="tests.test_login" name="test_login_ok" time="0.512" />
    <testcase classname="tests.test_login" name="test_login_bad_password" time="0.489">
      <failure message="AssertionError: expected error message not shown">...</failure>
    </testcase>
    <testcase classname="tests.test_login" name="test_login_locked" time="0.1">
      <skipped message="not implemented yet" />
    </testcase>
  </testsuite>
</testsuites>
```

`parseJunitResults.ts` produce:

```typescript
export interface JunitTestCase {
  name: string;
  status: "passed" | "failed" | "skipped";
  message?: string; // atributo "message" de <failure>/<error>/<skipped>, no el traceback completo
}

export interface JunitResults {
  totalTests: number;
  passed: number;
  failed: number; // failures + errors
  skipped: number;
  durationSeconds: number; // suma del atributo "time" de cada <testsuite>
  testCases: JunitTestCase[];
}
```

El atributo `message` de `<failure>`/`<error>` ya es el mensaje de una línea que pide el resumen (pytest lo genera así; el contenido dentro de la etiqueta es el traceback completo, que no se usa aquí).

## 5. Flujo de datos (`runReportes.ts`)

Entrada: `projectRoot`, `testsDir`, `ReportesCallbacks`.

1. `junitXmlPath = <projectRoot>/<testsDir>/results/latest.xml`. Si no existe (`fs.access` falla): `throw new Error("No hay resultados de ejecución todavía. Usa 'Ejecutar tests' primero.")`.
2. Lee y parsea el XML (`parseJunitResults`). Si el parseo falla (XML corrupto/inesperado): error claro envolviendo el mensaje original, sin reintentos.
3. `htmlReportPath = <projectRoot>/<testsDir>/results/latest.html` — ruta fija conocida, ya generada por Agente 3 (§2); no se comprueba su existencia (si el usuario la borró a mano, es su decisión, no bloquea el resumen).
4. `callbacks.selectDetailLevel()` → `"resumen" | "completo"`.
5. `generateSummaryMarkdown(results, detailLevel)` produce el Markdown:
   - Cabecera con conteos (total, pasados, fallidos, omitidos) y duración total.
   - Sección "Fallos": **todos** los tests con `status === "failed"`, cada uno `` `nombre` — mensaje ``. Si no hay fallos, línea "Ningún test falló." en vez de una lista vacía.
   - Si `detailLevel === "completo"`: sección adicional "Pasados", listado de todos los `status === "passed"` (solo nombre).
6. Escribe `<projectRoot>/<testsDir>/results/summary.md` (ruta fija, se sobreescribe sin pedir confirmación — mismo criterio que `latest.xml`/`latest.html`, no son ficheros que el usuario edite a mano).
7. Devuelve `{ junitXmlPath, htmlReportPath, summaryPath, totalTests, passed, failed, skipped }`.

## 6. Interfaces

```typescript
// core/src/agents/reportes/runReportes.ts
export interface ReportesCallbacks {
  selectDetailLevel(): Promise<"resumen" | "completo">;
}

export interface ReportesResult {
  junitXmlPath: string;
  htmlReportPath: string;
  summaryPath: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
}

export async function runReportes(
  projectRoot: string,
  testsDir: string,
  callbacks: ReportesCallbacks
): Promise<ReportesResult>;
```

## 7. Manejo de errores

Dos clases, coherentes con la spec global §8 y el precedente de Agente 3 §7:

- **No hay resultados todavía** (`latest.xml` no existe): error inmediato y claro, apunta a "Ejecutar tests" — mismo patrón que el guard de Agente 3 sobre `.feature` files inexistentes.
- **`junit-xml` corrupto o con forma inesperada**: error inmediato envolviendo el fallo de parseo, sin reintentos (no hay "arreglo automático" posible para un XML que no es el que pytest genera).

No hay manejo de errores de LLM/API ni de herramienta externa ausente en este agente — no invoca ningún modelo ni ningún proceso (`pytest-html` ya se generó en Agente 3).

## 8. Testing

`parseJunitResults`/`generateSummaryMarkdown`/`runReportes` se testean con ficheros junit-xml de ejemplo (string literal con la forma real que produce pytest) escritos a un `fs.mkdtemp` real — sin mocks de `fs`, mismo estilo que `listFeatureFiles`/`listAvailableTags`. No hace falta ningún componente "fake" ni gating por herramienta externa: a diferencia de `CodeChecker`/`TestRunner`, aquí no hay proceso que shell-ear, solo una librería de parseo pura corriendo sobre datos en disco.

## 9. CLI

`cli/src/commands/reports.ts` (`runGenerateReports`): carga `projectConfig` (mismo guard "ejecuta `agente-qa init` primero" que ya usan `generate.ts`/`execute.ts`), llama `runReportes` con un `ReportesPrompts` real (`selectDetailLevel` vía `select` de inquirer, opciones "Resumen" / "Completo"). Wireado en `cli/src/menu.ts`, opción `"reports"` — el último de los cinco elementos de menú que quedaba sin implementar.

## 10. Puntos abiertos para specs futuras

- Empaquetado/publicación npm — sigue pendiente, sin relación con este trabajo.
- Abrir el `.html`/`.md` automáticamente (navegador, editor) — explícitamente fuera de v1 (§1).
- Historial/comparación entre ejecuciones — depende de si Agente 3 revisa algún día su decisión de ruta fija sobreescrita (su spec §10 ya lo deja anotado).
