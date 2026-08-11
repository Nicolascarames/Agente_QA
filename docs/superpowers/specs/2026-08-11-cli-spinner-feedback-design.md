# CLI — feedback visual (spinner) durante operaciones largas — Diseño

Fecha: 2026-08-11
Estado: Aprobado para pasar a plan de implementación
Depende de: ninguna spec previa. Toca solo `cli/src`; `core` no cambia.

## 1. Objetivo

El usuario reportó que, durante "Crear plan de pruebas" (Agente 1) y "Generar tests
Playwright" (Agente 2), la consola queda muda varios segundos mientras se espera la
respuesta del LLM (o el autochequeo de código en Agente 2) — sin ninguna señal de que
el proceso sigue vivo. Este documento añade un spinner de terminal en esos huecos.

### No objetivos

- "Ejecutar tests" (Agente 3): ya vuelca en vivo la salida de `pytest` vía el callback
  `onOutput` existente (`cli/src/commands/execute.ts:22`) — no tiene el problema.
- "Ver/generar reportes" (Agente 4): solo lee y parsea un fichero en disco, operación
  local y rápida — no lo necesita.
- Progreso granular por paso interno de un agente (p. ej. distinguir "comprobando
  ambigüedad" de "generando Gherkin" dentro de Agente 1) — el spinner es genérico por
  llamada, no por agente. Ver §3.
- Cambios en `core` — la regla de que `core` no hace I/O de terminal (CLAUDE.md,
  "Convenciones no evidentes") se mantiene sin excepción; todo el trabajo vive en `cli`.

## 2. Alcance: qué operaciones llevan spinner

Dos interfaces DI que la CLI ya construye e inyecta en `core`, ambas con hueco de
espera silenciosa real:

- `LLMProvider.generate()` — llamadas de red al proveedor LLM elegido. Se invoca desde
  dentro de `core` (Agente 1 y Agente 2 pueden llamarla más de una vez por comando:
  p. ej. Agente 1 usa `ambiguityChecker` y luego `gherkinGenerator`).
- `CodeChecker.check()` — subproceso local (`ruff check` + `python -m py_compile`) que
  lanza Agente 2 tras generar el código. Normalmente rápido (<1s) pero puede tardar más
  si el proyecto es grande o el intérprete Python arranca lento; el usuario pidió
  cubrirlo también.

## 3. Arquitectura

Nuevo fichero `cli/src/util/spinner.ts` con dos decoradores puros. Un decorador recibe
la implementación real de una interfaz DI y devuelve otra implementación de la misma
interfaz que hace exactamente lo mismo, más un spinner alrededor:

```typescript
import ora from "ora";
import type { LLMProvider, Message } from "@agente-qa/core";
import type { CodeChecker, CodeFile, CodeCheckResult } from "@agente-qa/core";

export function withLLMSpinner(provider: LLMProvider): LLMProvider {
  return {
    async generate(messages: Message[]): Promise<string> {
      const spinner = ora("Consultando al modelo...").start();
      try {
        const result = await provider.generate(messages);
        spinner.succeed("Modelo respondió.");
        return result;
      } catch (err) {
        spinner.fail("Fallo al consultar el modelo.");
        throw err;
      }
    },
  };
}

export function withCodeCheckerSpinner(checker: CodeChecker): CodeChecker {
  return {
    async check(files: CodeFile[]): Promise<CodeCheckResult> {
      const spinner = ora("Comprobando el código generado (ruff/py_compile)...").start();
      try {
        const result = await checker.check(files);
        if (result.ok) {
          spinner.succeed("Código comprobado sin errores.");
        } else {
          spinner.fail("El código generado tiene errores de lint/compilación.");
        }
        return result;
      } catch (err) {
        spinner.fail("Fallo al comprobar el código.");
        throw err;
      }
    },
  };
}
```

`CodeCheckResult.ok === false` no es una excepción (es un resultado válido que Agente 2
usa para reintentar) — por eso ese caso también termina el spinner con `.fail()` (señal
visual correcta: el intento no salió limpio) pero **sin** relanzar ni envolver nada; la
función sigue devolviendo el resultado tal cual a quien la llamó.

Ambos decoradores son *pass-through* de tipos: no cambian la forma de `LLMProvider` ni
de `CodeChecker`, así que todo el código de `core` que ya consume estas interfaces
(`runIntake`, `runGenerador`) sigue funcionando sin ningún cambio.

## 4. Dónde se conecta

- `cli/src/commands/chat.ts`: tras `const llm = createProvider(credentials);`, se
  envuelve con `withLLMSpinner(llm)` antes de pasarlo a `runIntake`.
- `cli/src/commands/generate.ts`: mismo cambio para `llm`, más
  `withCodeCheckerSpinner(realCodeChecker)` en vez de pasar `realCodeChecker` directo a
  `runGenerador`.
- `cli/src/commands/execute.ts` y `cli/src/commands/reports.ts`: sin cambios (§1, no
  objetivos).

## 5. Dependencia nueva

[`ora`](https://www.npmjs.com/package/ora) en `cli/package.json` (`dependencies`, no
`devDependencies` — se usa en tiempo de ejecución). Versión ESM pura (`ora@^9`),
compatible con `"type": "module"` que ya usa el proyecto. Sin dependencias nativas.

## 6. Manejo de errores

Los decoradores no cambian el contrato de errores: si `provider.generate()` o
`checker.check()` lanzan, el decorador para el spinner en fallo (`✖`, mensaje corto) y
**relanza la misma excepción tal cual** (`throw err`, sin envolver). El `catch` que ya
existe en `menu.ts` para cada opción de menú sigue imprimiendo el mensaje de error
completo exactamente igual que hoy — no se toca `menu.ts`.

## 7. Testing

Los decoradores se testean con un `LLMProvider`/`CodeChecker` fake (`vi.fn()`),
verificando:

- El resultado que devuelve el decorador es el mismo que devuelve el fake (éxito).
- Los argumentos que recibe el fake son los mismos que recibió el decorador (no se
  mutan ni se transforman).
- Si el fake lanza, el decorador relanza la misma excepción (no la envuelve, no la
  traga).

No se testea el efecto visual del spinner en sí (texto exacto en pantalla, símbolos
`✔`/`✖`) — es responsabilidad de la librería `ora`, ya probada; testearlo aquí sería
testear la librería, no nuestro código.

## 8. Puntos abiertos para specs futuras

- Progreso granular por paso interno de un agente (§1) — si en el futuro se quiere
  distinguir "comprobando ambigüedad" de "generando Gherkin" en el propio spinner, hará
  falta un callback de progreso nuevo en `core` (fuera de alcance aquí, YAGNI mientras
  el mensaje genérico "Consultando al modelo..." resuelva el problema real reportado).
