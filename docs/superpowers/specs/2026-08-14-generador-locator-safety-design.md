# Guardrail contra locators frágiles en el código generado (Agente 2) — Diseño

Fecha: 2026-08-14
Estado: Aprobado para pasar a plan de implementación
Depende de: `docs/superpowers/specs/2026-08-10-agente-2-generador-design.md` (este documento añade una comprobación al `CodeChecker` ya descrito ahí, no lo reescribe).

## 1. Contexto y problema

Bug real encontrado por el usuario probando el pipeline completo contra una app real (`babia-nav.vercel.app`). El código generado por Agente 2 para el Page Object de login incluía:

```python
self.password_input = page.get_by_placeholder("Your password").or_(page.get_by_label("Password"))
```

`get_by_label` de Playwright hace match por substring del nombre accesible. La UI real tiene un botón "mostrar/ocultar contraseña" con `aria-label="Toggle password"` — ese aria-label contiene la palabra "password", así que el combinador `.or_()` resuelve a **dos** elementos (el input y el botón), y Playwright falla en modo estricto (`strict mode violation`) en tiempo de ejecución de test (Agente 3), no en generación.

Causa raíz: `codeGenerationPrompt` (`core/src/prompts/generador.ts`) da al LLM el snapshot real de accesibilidad de la página, pero ninguna guía sobre qué estrategia de locator usar. El LLM combina varias estrategias con `.or_()` sin poder anticipar colisiones de substring entre elementos no relacionados (patrón de UI común: botones de "toggle password", "toggle visibility", etc., casi siempre comparten palabras con el campo al que acompañan).

Este bug es invisible para las comprobaciones actuales del `CodeChecker` (`py_compile` + `ruff`): el código es sintácticamente válido y pasa lint — el fallo solo aparece al ejecutarse contra el DOM real.

## 2. Objetivo

Reducir la recurrencia de esta clase de bug (locators ambiguos que resuelven a más de un elemento) sin esperar a que aparezca en "Ejecutar tests"/reportes:

1. Instrucción explícita en el prompt de generación para que el LLM evite combinadores de locator ambiguos.
2. Red de seguridad determinista: si el LLM genera igualmente el patrón prohibido, se detecta de forma estática (sin ejecutar navegador) y fuerza una regeneración automática usando el bucle de reintento que ya existe — el usuario nunca debería ver este caso concreto en Agente 3.

### No objetivos

- Detección genérica de "cualquier locator que podría resolver a más de un elemento" — eso requiere DOM real (ejecución de navegador), fuera de alcance; ver spec de Site Explorer para lo que ya se verifica con evidencia real.
- Verificar en generación que el locator generado resuelve exactamente a 1 elemento contra la app real (implicaría repetir la exploración de Site Explorer con los selectores exactos generados) — sobre-ingeniería para un solo patrón conocido, no pedido.
- Prohibir `.or_()` en tests ya escritos a mano por el usuario — el checker solo corre sobre código recién generado por Agente 2, no re-audita tests existentes.

## 3. Diseño

### 3.1 Arquitectura

Cero interfaces nuevas. `CodeChecker.check(files): Promise<CodeCheckResult>` ya devuelve `{ok, errors}` y ya alimenta el bucle de reintento de `runGenerador` (`core/src/agents/generador/runGenerador.ts:58-68`, `MAX_ATTEMPTS = 4`). Se añade una tercera comprobación estática, en paralelo conceptual a `py_compile`/`ruff`, dentro de `createRealCodeChecker`.

```
core/src/codeCheck/
  locatorLint.ts      # NEW: checkLocatorPatterns(files) — puro, sin proceso externo
  realCodeChecker.ts  # MODIFY: fusiona su resultado con py_compile + ruff
core/src/prompts/
  generador.ts         # MODIFY: párrafo de guardrail de locators en codeGenerationPrompt
```

### 3.2 `locatorLint.ts`

```typescript
export function checkLocatorPatterns(files: CodeFile[]): CodeCheckResult
```

Escanea el `content` de cada `CodeFile` línea a línea buscando el combinador `.or_(` (Playwright `Locator.or_()`). Por cada aparición, produce una entrada de error con formato `<path>:<línea>: <explicación accionable>`. Si no hay ninguna, `{ok: true}`.

El texto de la explicación es el mismo `feedback` que se le devuelve al LLM en el reintento — debe ser autocontenido y accionable:

> "`.or_()` combina varias estrategias de locator y puede resolver a más de un elemento real (ejemplo real: un botón «mostrar/ocultar contraseña» con `aria-label` que también contiene la palabra «password» colisiona con el locator del campo). Usa una única estrategia de locator precisa para este elemento (rol + nombre accesible exacto, `get_by_test_id` si la evidencia lo muestra, o un selector de atributo/CSS específico) en vez de combinar varias con `.or_()`."

Puro, sin `spawn`, sin gating por herramientas del sistema — se testea directo con `vitest`, sin `describe.skipIf`.

### 3.3 `realCodeChecker.ts`

Dentro de `check()`, junto a las llamadas existentes a `py_compile` y `ruff`, se añade:

```typescript
const locatorResult = checkLocatorPatterns(files);
if (!locatorResult.ok) {
  errors.push(locatorResult.errors ?? "");
}
```

Mismo patrón que ya usa para fusionar `compile`+`lint`: si compile, lint y locator lint fallan a la vez, los tres errores llegan juntos en el mismo `feedback` de reintento — no se descubren uno a uno en attempts sucesivos. `ok` sigue siendo `errors.length === 0`.

No se hace short-circuit antes de `py_compile`/`ruff` aunque el locator lint sea más barato — mantener el mismo orden y comportamiento de fusión que ya existe es más simple de razonar que una rama especial, y el coste extra de correr `py_compile`/`ruff` igualmente es despreciable (el `tmpDir` ya se crea para ellos).

### 3.4 `codeGenerationPrompt` (guardrail)

Nuevo párrafo en `core/src/prompts/generador.ts`, junto a las instrucciones existentes sobre `pytest-playwright`/variables de entorno:

> "Para los locators de Playwright, usa siempre una única estrategia precisa por elemento (rol + nombre accesible exacto, o `get_by_test_id` si la evidencia lo muestra) — nunca combines varias estrategias con `.or_()`: puede resolver a más de un elemento real y romper en modo estricto (ejemplo: un botón «mostrar/ocultar contraseña» cuyo `aria-label` también contiene la palabra «contraseña»/«password» colisiona con el locator del campo)."

Este párrafo es la primera línea de defensa (evita el intento fallido en la mayoría de los casos); el lint de 3.2/3.3 es la red de seguridad para cuando el LLM lo ignora igualmente.

### 3.5 Flujo de datos

Sin cambios de firma en `runGenerador`, `generateCode`, ni en la interfaz pública `CodeChecker`. El flujo de reintento (genera → `checker.check()` → si falla, feedback al siguiente intento → hasta `MAX_ATTEMPTS`) es exactamente el que ya existe.

### 3.6 Manejo de errores

Ninguno nuevo: `checkLocatorPatterns` es una función pura sobre strings ya en memoria, no puede lanzar (`fs`/proceso no entran en juego). Si el lint sigue fallando tras `MAX_ATTEMPTS` intentos, el error final que ve el usuario es el mismo camino ya existente (`runGenerador.ts:64-66`), incluyendo ahora también el mensaje de locator si es la causa.

## 4. Testing

- `core/src/codeCheck/locatorLint.test.ts` (nuevo, sin gating): detecta `.or_(` en un archivo → `ok:false` con `path:línea` correctos; archivo sin `.or_(` → `ok:true`; multi-archivo (dos `CodeFile`, uno con el patrón) → el error identifica el archivo correcto; múltiples apariciones en el mismo archivo → todas reportadas, no solo la primera.
- `core/src/codeCheck/realCodeChecker.test.ts` (modificado): un test nuevo que ejercita el `check()` fusionado con un archivo que contiene `.or_(` — mismo criterio de gating que ya usa el resto del fichero (`describe.skipIf` si no hay `ruff`/Python reales, porque `py_compile`/`ruff` siguen corriendo igual en el mismo `check()`).
- `core/src/agents/generador/runGenerador.test.ts`: sin cambios de contrato — ya cubre el bucle de reintento contra `FakeCodeChecker`; no necesita saber nada de locators.
- Verificación de regresión real: reconstruir el archivo Python del bug reportado (con el `.or_()` exacto del traceback) como fixture del test de `locatorLint.test.ts`, para que el test falle sin el fix y pase con él — mismo criterio de "repro exacto" ya usado en otras correcciones de este proyecto (ver `memory.md`, entrada sobre `generateText()`/`allowSystemInMessages`).
