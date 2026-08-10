# Agente 2 — Generador (Gherkin aprobado → tests Playwright) — Diseño

Fecha: 2026-08-10
Estado: Aprobado para pasar a plan de implementación
Depende de: `docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md` (diseño global del pipeline, §5 define el contrato de entrada/salida de este agente a alto nivel; este documento lo detalla)

## 1. Objetivo

Primer sub-proyecto de "Plan 2" (memory.md: Agentes 2-4). Se decidió partir Plan 2 en specs independientes porque los tres agentes restantes son secuenciales, no independientes (Agente 3 consume el output de Agente 2, Agente 4 consume el de Agente 3) — no tiene sentido diseñarlos juntos antes de tener el primero construido y probado.

Agente 2 toma un `.feature` ya aprobado por Agente 1 y genera los tests Playwright correspondientes (Python, pytest-bdd, Page Object Model), con autochequeo de que el código generado compila y pasa lint antes de escribirlo al proyecto del usuario.

### No objetivos de este sub-proyecto

- Agente 3 (ejecutor) y Agente 4 (reportes) — specs propias, después.
- Empaquetado/publicación npm — sigue pendiente, sin relación con este trabajo.
- Adaptadores de intake distintos a texto plano — ya fuera de alcance en la spec global.

## 2. Decisión previa: partir de la spec global, no repetirla

La spec global (`2026-08-10-agente-qa-pipeline-design.md`, §5 "Agente 2") ya fija:
- Entrada: `.feature` aprobado.
- Convención fija: Page Object Model — `tests/`, `pages/`, `conftest.py`.
- Autochequeo antes de presentar: código debe compilar/lintar limpio, si no el propio agente lo corrige.
- Si el caso no encajaba en patrón existente, se pregunta si se guarda como patrón nuevo.

Este documento resuelve el detalle que la spec global dejaba abierto: qué runtime Python exacto (pytest-bdd vs pytest-playwright a secas), cómo se verifica "compila/lint limpio" desde un motor TypeScript, cómo viaja la información de qué patrón matcheó Agente 1 hasta Agente 2, y qué pasa con una divergencia encontrada en código ya implementado de Agente 1.

## 3. Divergencia encontrada en Agente 1 (corrección de alcance)

La spec global asigna "preguntar si guardar como patrón nuevo" a Agente 2 (§5, bajo el epígrafe de Agente 2, después de "generar con éxito"). La implementación actual de Agente 1 (`core/src/agents/intake/runIntake.ts:49-58`) ya hace esa pregunta y guarda el patrón — con `pageObjectTemplate: ""` vacío, porque en ese punto del pipeline no existe código Playwright todavía. Un patrón guardado así queda incompleto respecto a su propia definición (spec global §6: "pareja Gherkin + esqueleto de Page Object").

**Decisión**: mover esa responsabilidad completa a Agente 2, tal como dice la spec. Cambios en código existente de Agente 1 (parte de este plan, no oculto):

- `runIntake.ts`: elimina el bloque de guardar patrón (líneas 49-58).
- `IntakeCallbacks`: elimina `offerSavePattern`.
- Los tests existentes de `runIntake.test.ts` que cubran ese bloque se actualizan en consecuencia.

## 4. Cómo Agente 2 sabe qué patrón matcheó Agente 1

`runIntake` hoy no expone si hubo patrón coincidente ni cuál, y el `.feature` escrito tampoco lleva esa información. Como "Generar tests desde un plan aprobado" es una opción de menú independiente (puede ejecutarse en una sesión distinta a la que corrió Agente 1), esa información tiene que persistir en algún sitio.

**Decisión**: Agente 1, al escribir el `.feature`, añade una cabecera de comentario Gherkin:

```gherkin
# agente-qa:pattern=login
Feature: Inicio de sesión
  ...
```

Gherkin ignora comentarios — no rompe ningún parser ni pytest-bdd. Si no hubo patrón (`matchedPattern === null`), no se añade cabecera.

Cambios:
- `GherkinPlan` (`core/src/schemas/gherkinPlan.ts`): añade `matchedPatternName: string | null`.
- `generateGherkin` (`gherkinGenerator.ts`): recibe/propaga el nombre del patrón matcheado (ya tiene el `Pattern` completo disponible, solo falta pasarlo al resultado).
- `writeFeatureFile.ts`: antepone la cabecera si `matchedPatternName` no es null.
- Nuevo `core/src/agents/generador/parseFeatureHeader.ts`: lee la cabecera al inicio del `.feature`, devuelve el nombre o `null`.

## 5. Runtime de test: pytest-bdd

La spec global deja abierto "pytest-bdd/pytest-playwright" sin decidir. Se fija **pytest-bdd**:

- El `.feature` de Agente 1 se ejecuta directo vía `scenarios('../features/x.feature')` + step definitions (`@given`/`@when`/`@then`).
- Los tags Gherkin (`@smoke`, `@regression`) se convierten automáticamente en markers pytest — es el mecanismo real que necesita Agente 3 para "seleccionar por tags Gherkin" (spec global §5, Agente 3), que de otro modo no tendría un puente definido.
- Una sola fuente de verdad: no hay que mantener sincronizados un `.feature` y una re-etiquetación manual en Python.

## 6. Arquitectura y componentes

Seguimos la convención ya establecida en el repo (`core/src/agents/<agente>/`), no la ruta plana `core/generators/` de la spec original:

```
core/src/agents/generador/
  runGenerador.ts        # orquestador, equivalente a runIntake.ts
  codeGenerator.ts        # llama LLM, genera step defs + Page Objects (equivalente a gherkinGenerator.ts)
  writeTestFiles.ts       # escribe tests/*.py, pages/*.py, conftest.py
  parseFeatureHeader.ts   # lee "# agente-qa:pattern=<name>" del .feature
core/src/codeCheck/
  codeChecker.ts           # interfaz CodeChecker + implementación real (ruff + py_compile)
core/src/prompts/
  generador.ts             # prompt de generación de código (nuevo, análogo a intake.ts)
```

## 7. Flujo de datos (`runGenerador.ts`)

Entrada: ruta al `.feature` aprobado, `projectRoot`, `testsDir`, patrones disponibles (builtin + proyecto), `LLMProvider`, `CodeChecker`, `GeneratorCallbacks`.

1. Lee el `.feature`, extrae la cabecera de patrón (`parseFeatureHeader.ts`).
2. Si hay nombre de patrón, busca el `Pattern` completo (con su `pageObjectTemplate` real) en la lista cargada — se pasa como esqueleto de referencia al generador. Si no hay, genera desde cero.
3. `codeGenerator.ts` llama al LLM (prompt en `core/src/prompts/generador.ts`) → produce step definitions pytest-bdd + clases Page Object.
4. **Bucle de autocorrección, máx. 3 intentos**: `CodeChecker.check(files)` → si falla por error de código, el error se reenvía al LLM como feedback (mismo patrón que el loop de aprobación de `runIntake`, pero automático, sin intervención del usuario) → regenera. Al 4º fallo consecutivo: `throw`, no se escribe nada.
5. Limpio → `writeTestFiles.ts` escribe a disco (estructura §8).
6. Si no había patrón matcheado: `callbacks.offerSavePattern(plan)` — ahora con `pageObjectTemplate` real (código que ya pasó el autochequeo). Si se acepta, `saveProjectPattern` (sin cambios, ya existe).

Salida: rutas de los ficheros escritos.

No hay checkpoint de aprobación humana del código generado (a diferencia del checkpoint de Agente 1) — el autochequeo limpio es el único gate antes de escribir a disco. Coherente con que la spec global no menciona checkpoint para Agente 2, y con que Agente 3 simplemente "recoge conjunto de tests disponibles en el proyecto" sin gate intermedio.

## 8. Estructura de ficheros generados

```
<testsDir>/
  features/<slug>.feature      # ya existe, de Agente 1
  tests/test_<slug>.py          # scenarios() + step defs, pytest-bdd
  pages/<slug>_page.py           # Page Objects para ese feature
  conftest.py                    # fixtures compartidas (page/browser), una vez por proyecto
```

`<slug>` reutiliza el mismo slug que Agente 1 ya genera para el `.feature` (`slugify`).

**Colisiones**:
- `tests/test_<slug>.py` y `pages/<slug>_page.py`: si ya existen (se regenera el mismo feature), se reutiliza el callback `confirmOverwrite` que ya usa Agente 1 — mismo mecanismo, no uno nuevo.
- `conftest.py`: compartido entre features, no por-feature. Si ya existe, **no se toca** (se asume que puede estar editado a mano con fixtures propias del proyecto). Solo se escribe si falta.

## 9. Interfaces

```typescript
// core/src/codeCheck/codeChecker.ts
export interface CodeChecker {
  check(files: { path: string; content: string }[]): Promise<{ ok: boolean; errors?: string }>;
}
```

Implementación real: escribe los ficheros candidatos a un directorio temporal (`os.tmpdir()`), corre `ruff check` + `python -m py_compile`, parsea la salida, borra el temp — nunca toca el árbol real del proyecto hasta que pasa limpio. Shell-out a proceso externo, no es I/O de terminal con el usuario — no rompe la convención de `core` (mismo principio que ya aplica `LLMProvider` llamando una API externa).

```typescript
// core/src/agents/generador/runGenerador.ts
export interface GeneratorCallbacks {
  offerSavePattern(plan: GherkinPlan): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}
```

## 10. Manejo de errores

Tres clases distintas:

- **Error de código** (`ruff`/`py_compile` marcan fallo real): entra al bucle de autocorrección (§7, paso 4).
- **Herramienta ausente** (`ruff`/`python` no están en el host — `child_process` lanza `ENOENT`): NO entra al bucle (reintentar no arregla un binario que falta) — error inmediato, mensaje claro apuntando a instalar Python+ruff, mismo patrón que la spec global §8 ya usa para "Playwright no instalado".
- **Fallo LLM/API**: igual que ya maneja Agente 1 (mensaje claro, sin ficheros a medio escribir).

## 11. Testing

Mismo patrón DI que `LLMProvider` (`core/src/llm/testUtils.ts`): los tests de `runGenerador`/`codeGenerator` inyectan un `CodeChecker` fake (pass/fail determinista, en memoria) — no dependen de tener Python/ruff instalados para correr `vitest`.

La implementación **real** de `CodeChecker` (la que llama `ruff`/`python` de verdad) necesita su propio test aparte, que sí requiere Python+ruff instalados en la máquina — nuevo prerequisito de entorno que no existía en Plan 1 (100% TypeScript/Node). Cómo gatear ese test cuando no hay Python disponible (CI, por ejemplo) se decide en el plan de implementación, no aquí.

## 12. Puntos abiertos para specs futuras

- Agente 3 (ejecutor) y Agente 4 (reportes) — specs propias.
- Prompt exacto de generación de código (`core/src/prompts/generador.ts`) — se escribe durante la implementación, no bloquea este diseño.
- Si el prerequisito de Python/ruff en CI resulta problemático en la práctica, revisar si se gatea, se documenta como requisito de contribución, o se mockea de otra forma.
