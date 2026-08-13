# Mejoras de UX del CLI (spinner, modo headed, apertura de reportes, .gitignore) — Diseño

Fecha: 2026-08-13
Estado: Aprobado para pasar a plan de implementación
Depende de: `docs/superpowers/specs/2026-08-11-agente-3-ejecutor-design.md`, `docs/superpowers/specs/2026-08-11-agente-4-reportes-design.md`, `docs/superpowers/specs/2026-08-12-project-env-config-design.md` (este documento modifica flujos ya descritos ahí, no los reescribe).

## 1. Objetivo

Cuatro puntos de fricción reales en el CLI, identificados por el usuario en la misma sesión que la spec de Site Explorer (2026-08-13), tratados como sub-proyecto propio por ser del mismo tamaño entre sí y no tocar la arquitectura de exploración real:

1. **"Ejecutar tests" se queda mudo** tras elegir tags y modo de captura, sin ningún indicador durante el hueco entre esa elección y el primer output de `pytest` — a diferencia de "Crear plan"/"Generar tests", que ya usan spinners (`withLLMSpinner`, `withCodeCheckerSpinner`).
2. **No hay forma de ver el navegador ni el progreso paso a paso** durante "Ejecutar tests" — todo corre headless y en silencio hasta que pytest empieza a imprimir sus propias líneas.
3. **"Ver/generar reportes" no abre nada** — genera `summary.md` y confirma la ruta del `.html`, pero solo imprime rutas de texto, nunca abre los ficheros.
4. **`init`/`Configuración" nunca toca el `.gitignore` del proyecto consumidor** — solo gestiona `.agente-qa/.gitignore` (para el `.env`). `node_modules` (de la instalación local de `agente-qa` vía npm), `<testsDir>/results` y `<testsDir>/test-results` no se excluyen nunca automáticamente.

### No objetivos de este sub-proyecto

- El modo headed del Site Explorer (Agente 2, durante "Generar tests") — ya fijo en `headed: true` por diseño, spec propia, no se toca aquí. Este documento es sobre el modo headed de **Agente 3** (ejecución de los tests ya generados), una configuración completamente distinta.
- Cachear o pre-rellenar `testsDir` con el valor ya guardado al re-ejecutar `init`/`config` — comportamiento preexistente (siempre pregunta con el mismo default fijo), no se cambia; `headedMode` sigue el mismo patrón por consistencia, no se le añade memoria de la que `testsDir` carece.
- Streaming genuino "paso a paso" reimplementado desde cero — `--gherkin-terminal-reporter` (nativo de `pytest-bdd`) ya lo resuelve, no hace falta parsear el output de pytest a mano.

## 2. Decisiones del usuario que fijan el diseño

- **Modo headed**: un único interruptor (`headedMode`, guardado en `config.json` del proyecto) controla **a la vez** el navegador visible (`--headed`) y la consola paso a paso (`--gherkin-terminal-reporter`) — no dos ajustes independientes. Se pregunta en cada `init`/`Configuración`, igual que el resto de esa pregunta. Default: `false` (headless, sin paso a paso — comportamiento actual).
- **Apertura de reportes**: nivel "resumen" abre solo el `.md`; nivel "completo" abre el `.md` **y además** el `.html` extendido. Detección de VSCode vía `TERM_PROGRAM=vscode`: el `.md` se abre con `code <ruta>` si se detecta VSCode (con fallback al abridor del sistema operativo si `code` no está en el `PATH`); el `.html` **siempre** con el abridor del sistema operativo (VSCode no renderiza HTML en vivo sin una extensión de por medio).
- **`.gitignore` del proyecto**: se pregunta en cada `init`/`Configuración`, pero **solo por las entradas que todavía falten** — si ya están las tres, no se pregunta nada.

## 3. Arquitectura y componentes

```
core/src/config/
  projectConfig.ts        # MODIFY: + headedMode en ProjectConfigSchema
  projectGitignore.ts       # NEW: leer/añadir entradas al .gitignore del proyecto
core/src/testRun/
  testRunner.ts               # MODIFY: TestRunOptions + headed, verboseSteps
  realTestRunner.ts             # MODIFY: + flags --headed / --gherkin-terminal-reporter
core/src/agents/ejecutor/
  runEjecutor.ts                 # MODIFY: recibe headedMode, lo traduce a los dos flags
cli/src/util/
  spinner.ts                      # MODIFY: + withTestRunnerSpinner
  openFile.ts                       # NEW: resolveOpenCommand (puro, testeado) + openFile (spawn real)
cli/src/prompts/
  types.ts                           # MODIFY: + InitPrompts.confirmHeadedMode/selectGitignoreEntries
  inquirerPrompts.ts                   # MODIFY: implementaciones reales de los dos prompts nuevos
cli/src/commands/
  init.ts                                # MODIFY: pregunta headedMode + gitignore, guarda/aplica
  execute.ts                              # MODIFY: lee headedMode de la config, envuelve el runner con el spinner
  reports.ts                               # MODIFY: abre .md (y .html si "completo") tras generar
```

Mismo patrón DI ya establecido: `TestRunOptions` sigue siendo la única interfaz que cruza a `TestRunner`; `resolveOpenCommand` separa la decisión (pura, testeable) de la ejecución real (`spawn`, no testeada — abrir una ventana real durante `vitest run` sería un efecto de sistema indeseable en CI, mismo criterio que ya excluye otras acciones con ventana visible de la suite automática).

## 4. Interfaces

```typescript
// core/src/config/projectConfig.ts (modificado)
export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
  headedMode: z.boolean().default(false),
});
```

```typescript
// core/src/config/projectGitignore.ts (nuevo)
export function projectGitignorePath(projectRoot: string): string;
export async function readProjectGitignoreEntries(projectRoot: string): Promise<string[]>;
export async function appendProjectGitignoreEntries(projectRoot: string, entries: string[]): Promise<void>;
```

```typescript
// core/src/testRun/testRunner.ts (modificado)
export interface TestRunOptions {
  cwd: string;
  markerExpression: string | null;
  screenshotMode: "off" | "only-on-failure" | "on";
  videoMode: "off" | "retain-on-failure" | "on";
  headed: boolean;        // NUEVO
  verboseSteps: boolean;  // NUEVO
  junitXmlPath: string;
  htmlReportPath: string;
  onOutput: (chunk: string) => void;
  env: Record<string, string>;
}
```

```typescript
// core/src/agents/ejecutor/runEjecutor.ts (firma modificada)
export async function runEjecutor(
  projectRoot: string,
  testsDir: string,
  runner: TestRunner,
  headedMode: boolean,   // NUEVO
  callbacks: ExecutorCallbacks,
  testEnv: Record<string, string> = {}
): Promise<EjecutorResult>;
```

```typescript
// cli/src/util/openFile.ts (nuevo)
export type FileKind = "markdown" | "html";
export interface OpenCommand { command: string; args: string[] }

export function resolveOpenCommand(
  kind: FileKind,
  filePath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): OpenCommand;

export async function openFile(kind: FileKind, filePath: string): Promise<void>;
```

```typescript
// cli/src/prompts/types.ts (InitPrompts ampliado)
export interface InitPrompts {
  inputTestsDir(): Promise<string>;
  confirmHeadedMode(): Promise<boolean>;                        // NUEVO
  selectGitignoreEntries(candidates: string[]): Promise<string[]>; // NUEVO
}
```

## 5. Flujo de datos

**Modo headed (init → ejecución):** `runInit` pregunta `confirmHeadedMode()` y guarda `headedMode` en `config.json` junto a `testsDir`. `execute.ts` lee `projectConfig.headedMode` y lo pasa a `runEjecutor`, que lo traduce en las `TestRunOptions` que recibe el `TestRunner`: `{ headed: headedMode, verboseSteps: headedMode, ... }`. `realTestRunner.ts` añade `--headed` y/o `--gherkin-terminal-reporter` a los argumentos de `pytest` según esos dos campos.

**Spinner del ejecutor:** `execute.ts` envuelve el `TestRunner` real con `withTestRunnerSpinner` antes de pasarlo a `runEjecutor` (mismo punto donde ya se envuelve `realCodeChecker`/el `LLMProvider` en `generate.ts`). El wrapper arranca un spinner justo antes de `runner.run(options)` y lo para en cuanto `onOutput` recibe su primer chunk (cubre el preflight de `realTestRunner` — comprobación de `pytest`/`pytest-bdd`/`pytest-playwright`/`pytest-html` instalados — y el arranque de `pytest` hasta su primera línea de salida); si `run()` lanza antes de emitir ningún chunk (p. ej. `MissingTestToolError`), el spinner termina con `.fail()` en vez de quedarse colgado.

**Apertura de reportes:** `reports.ts` captura localmente qué nivel eligió el usuario (envolviendo `prompts.selectDetailLevel` dentro de su propio callback a `runReportes`, sin cambiar el contrato de `core`). Tras `runGenerateReports`, abre `result.summaryPath` con `openFile("markdown", ...)` siempre; si el nivel elegido fue `"completo"`, abre además `result.htmlReportPath` con `openFile("html", ...)`.

**`.gitignore` del proyecto:** `runInit` calcula las tres candidatas (`node_modules`, `${testsDir}/results`, `${testsDir}/test-results`), lee las ya presentes con `readProjectGitignoreEntries`, filtra las que falten; si hay alguna, llama a `prompts.selectGitignoreEntries(missing)` (checkbox, todas premarcadas) y añade lo elegido con `appendProjectGitignoreEntries`. Si no falta ninguna, no se llama al prompt en absoluto.

## 6. Manejo de errores

- `resolveOpenCommand`/`openFile` nunca deben interrumpir el flujo de "Ver/generar reportes": si `spawn` falla (comando no encontrado, permisos), se ignora en silencio — el usuario ya tiene la ruta impresa por consola como hoy, abrir el fichero es una comodidad añadida, no un paso crítico. El único fallback explícito es `code` → abridor del sistema operativo cuando `code` no está en el `PATH`.
- `appendProjectGitignoreEntries` no falla si el `.gitignore` no existía — lo crea. No duplica entradas ya presentes (`readProjectGitignoreEntries` las filtra antes de construir la pregunta).
- `withTestRunnerSpinner` no cambia ninguna semántica de error existente de `TestRunner` — solo añade feedback visual; el `catch`/rethrow deja pasar el error original intacto tras parar el spinner.

## 7. Testing

- `projectGitignore.ts`: `fs.mkdtemp` real (mismo patrón que `projectConfig.test.ts`/`projectEnv.test.ts`) — sin fakes, es solo lectura/escritura de fichero.
- `resolveOpenCommand`: función pura, tests exhaustivos por combinación (`kind` × `TERM_PROGRAM` presente/ausente × `platform`), sin tocar el sistema real.
- `openFile`/`trySpawn` (el `spawn` real): **no testeado automáticamente** — abrir una ventana/aplicación real durante `vitest run` es un efecto de sistema no deseable en CI, mismo criterio ya aplicado a otras acciones con ventana visible. Punto abierto para spec futura si hiciera falta más confianza aquí (p. ej. inyectar la función de spawn para un test con un comando fake controlado).
- `withTestRunnerSpinner`: mock de `ora` (mismo patrón que los tests existentes de `withLLMSpinner`/`withCodeCheckerSpinner` en `cli/src/util/spinner.test.ts`) — verificar que el spinner para en el primer `onOutput` y no antes, y que usa `.fail()` si `run()` lanza sin haber emitido ningún chunk.
- `runEjecutor.test.ts`: `FakeTestRunner`, verificar que `headedMode` se traduce correctamente en `headed`/`verboseSteps` dentro de las opciones que recibe el runner.
- `realTestRunner.test.ts`: extender los tests gateados existentes para comprobar que `--headed`/`--gherkin-terminal-reporter` se añaden a los argumentos cuando corresponde (se puede verificar por argv capturado, sin depender de que un navegador realmente se abra).

## 8. CLI

- `init.ts`: `runInit` gana los dos pasos nuevos (headed + gitignore) entre la pregunta de `testsDir` y el resto del flujo existente (plantilla `.env`). `InitResult` gana `gitignoreEntriesAdded: string[]` para que `menu.ts` pueda informar de qué se añadió, si algo.
- `execute.ts`: construye `withTestRunnerSpinner(realTestRunner)`, lee `projectConfig.headedMode`, pasa ambos a `runEjecutor`.
- `reports.ts`: como se describe en Flujo de datos — captura el nivel elegido, abre ficheros tras `runGenerateReports`.
- `menu.ts`: sin cambios de estructura, solo consume los campos nuevos de `InitResult` para el mensaje de confirmación de `init`/`config`.

## 9. Puntos abiertos para specs futuras

- Testear `openFile`/`trySpawn` con una función de `spawn` inyectable si en el futuro se necesita más confianza automática sobre la apertura real (hoy se acepta el hueco, ver §7).
- Prellenar `testsDir`/`headedMode` con el valor ya guardado al re-ejecutar `init`/`Configuración` en vez de preguntar siempre desde el mismo default — decisión de UX explícitamente fuera de este documento (ver §1, No objetivos).
