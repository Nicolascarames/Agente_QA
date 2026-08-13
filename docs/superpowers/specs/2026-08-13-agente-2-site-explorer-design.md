# Agente 2 — Descubrimiento real de rutas y localizadores (Site Explorer) — Diseño

Fecha: 2026-08-13
Estado: Aprobado para pasar a plan de implementación
Depende de: `docs/superpowers/specs/2026-08-10-agente-2-generador-design.md` (este documento modifica su flujo de generación de código, no lo reescribe).

## 1. Origen y objetivo

Depurando un test generado para un proyecto real (`babia-nav.vercel.app`), se encontró que `LoginPage.goto()` navegaba a `f"{base_url}/login"` — ruta que no existe en esa app (el login vive en la raíz `/`, montado por Clerk). El código generado no era un bug de sintaxis: el LLM había adivinado la ruta y los localizadores siguiendo la convención de la plantilla incorporada (`core/src/patterns/builtin/login.ts`), sin verificarlos nunca contra la aplicación real. Ninguna parte del pipeline abre nunca un navegador durante la generación — solo se ejecuta `ruff`/`py_compile` (sintaxis), nunca una carga real de la página.

**Objetivo**: antes de que Agente 2 escriba código, verificar contra la aplicación real (rutas, formularios, texto de botones, labels) para que el código generado use localizadores que existen de verdad, en vez de adivinados por convención.

### No objetivos de este sub-proyecto

- Agente 1 (intake): el descubrimiento ocurre solo en Agente 2, justo antes de generar código (decisión explícita del usuario) — Agente 1 sigue conversando el Gherkin sin tocar la app real.
- Un "mapa del sitio" persistente o exploración exhaustiva de toda la app: solo se exploran las pantallas que el escenario Gherkin aprobado necesita, nada más.
- Caché de lo descubierto entre generaciones: cada generación vuelve a explorar en caliente (decisión explícita del usuario, ver §7).
- Las 4 mejoras de UX del CLI pedidas en la misma conversación (spinner del ejecutor, modo headed configurable en `init`, apertura automática de reportes, preguntas de `.gitignore`) — sub-proyecto aparte ("Proyecto B"), spec propia.

## 2. Enfoque: híbrido, escala solo cuando hace falta

Tres opciones evaluadas con el usuario:

1. **Navegación por patrón conocido** (rápida): cada patrón incorporado lleva pistas de navegación (rutas candidatas, si requiere login real). Cubre los 4 patrones incorporados y cualquier patrón de proyecto guardado que ya las tenga. No generaliza a un Gherkin sin patrón.
2. **Exploración guiada por LLM** (agentic, general): para cualquier Gherkin, un bucle donde el LLM decide la siguiente acción real mirando el snapshot de accesibilidad de la pantalla actual, hasta completar el escenario. Generaliza siempre, pero es más lento y hace más llamadas al LLM.
3. **Híbrido**: opción 1 primero cuando hay patrón con pistas; si falla (ruta no encontrada, elemento no aparece) o no hay patrón, escala a la opción 2.

**Decisión: opción 3.** Mismo principio que ya sigue el proyecto ("pensar caro, ejecutar barato"): barato en el caso común (patrón conocido, la mayoría de generaciones), robusto en el caso raro o nuevo.

## 3. Decisiones del usuario que fijan el diseño

- **Cuándo**: justo antes de generar código (Agente 2), no durante el intake.
- **Login real**: si el escenario necesita una pantalla autenticada (dashboard, perfil...), el explorador inicia sesión de verdad con las credenciales de test (`AGENTE_QA_TEST_USERNAME`/`PASSWORD`) para capturarla. No se limita a páginas públicas.
- **Caché**: ninguna. Cada generación explora en caliente — nunca se persiste ni se reutiliza un snapshot de una generación anterior.
- **Modo navegador**: headed (ventana visible) durante la exploración.

## 4. Arquitectura y componentes

```
core/src/siteExplorer/
  siteExplorer.ts       # interfaz SiteExplorer + tipos de entrada/salida
  realSiteExplorer.ts   # implementación real: Playwright (Node) headed + LLMProvider para el camino agentic
  testUtils.ts           # FakeSiteExplorer
core/src/prompts/
  explorer.ts            # prompt para la decisión de siguiente acción (camino agentic)
core/src/patterns/
  schemas/pattern.ts     # + navigationHints opcional
  builtin/*.ts            # login/logout/signup/password-reset ganan navigationHints
```

Mismo patrón DI que `CodeChecker`/`TestRunner`: interfaz + `FakeSiteExplorer` (tests, determinista) + `realSiteExplorer` (real, Playwright). Playwright (paquete Node, `playwright`) pasa a ser dependencia de `core` — **distinta y aparte** del Playwright Python que usan los tests generados (`pytest-playwright`). Requiere sus propios navegadores instalados (`npx playwright install`) como prerequisito nuevo para usar `agente-qa` (no para el proyecto del usuario bajo test).

## 5. Interfaces

```typescript
// core/src/siteExplorer/siteExplorer.ts
export interface ScreenEvidence {
  stepText: string;     // paso Gherkin (o descripción) que motivó capturar esta pantalla
  url: string;           // URL real alcanzada
  ariaSnapshot: string;  // snapshot de accesibilidad en texto (roles + nombres accesibles), sin datos sensibles
}

export interface ExplorationInput {
  featureText: string;
  matchedPattern: Pattern | null;
  baseUrl: string;
  credentials?: { username: string; password: string };
  headed: boolean;
}

export type ExplorationResult =
  | { ok: true; screens: ScreenEvidence[] }
  | { ok: false; error: string };

export interface SiteExplorer {
  explore(input: ExplorationInput, onStep?: (message: string) => void): Promise<ExplorationResult>;
}
```

`onStep` es un callback opcional de progreso ("Probando ruta /login... 404", "Probando raíz... formulario de login encontrado") — mismo propósito que el Proyecto B pedirá para la fase de ejecución de tests, aquí cubre la fase de exploración sin invadir el alcance del otro sub-proyecto.

```typescript
// core/src/schemas/pattern.ts (añadido)
export const NavigationHintsSchema = z.object({
  routeCandidates: z.array(z.string()).min(1), // ej. ["/login", "/signin", "/"]
  requiresLogin: z.boolean(),
});

export const PatternSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  gherkinTemplate: z.string().min(1),
  pageObjectTemplate: z.string(),
  navigationHints: NavigationHintsSchema.optional(), // ausente = siempre camino agentic
});
```

## 6. Flujo de datos

`runGenerador.ts`, antes de la primera llamada a `generateCode`:

1. Construye `ExplorationInput` (featureText, matchedPattern, `AGENTE_QA_APP_URL`, credenciales de test si están configuradas, `headed: true`).
2. `siteExplorer.explore(input, onStep)`.
   - **Camino rápido** (si `matchedPattern?.navigationHints` existe): prueba cada `routeCandidate` en orden hasta encontrar una que no dé 404/error; si `requiresLogin`, realiza el login real; captura `ariaSnapshot` de la(s) pantalla(s) relevante(s) al escenario (la de login, y si aplica, la posterior a iniciar sesión).
   - **Escalado a camino agentic** si el camino rápido falla (todas las rutas fallan, o un elemento esperado no aparece) o si no hay `navigationHints`: bucle acotado (máx. 20 acciones) donde, para cada paso Gherkin relevante, se pide al LLM una acción sobre la pantalla actual (`goto`/`click`/`fill_credential`/`done`/`fail`) en JSON, usando el prompt de `core/src/prompts/explorer.ts`; el driver ejecuta la acción con Playwright y captura el `ariaSnapshot` resultante.
3. Si `ok: false`, `runGenerador` lanza el error inmediatamente — **no** se llama a `generateCode`, no hay reintento automático de la exploración (ver §8, motivo de seguridad).
4. Si `ok: true`, `screens` se serializa como nueva sección "Evidencia real capturada de la aplicación" dentro de `codeGenerationPrompt` (`core/src/prompts/generador.ts`), junto al Gherkin y la plantilla del patrón (si la hay). El LLM ya no adivina rutas ni labels: los toma de esta evidencia.

La exploración corre **una sola vez** por generación — el bucle de reintentos ya existente en `runGenerador` (hasta 4 intentos, hoy solo por errores de `ruff`/`py_compile`) sigue igual y no vuelve a explorar en cada reintento de lint; la evidencia capturada en el paso 2 se reutiliza en todos los intentos de esa generación.

## 7. Por qué sin caché entre generaciones

Decisión explícita del usuario: cada generación debe reflejar el estado real de la app en ese momento, incluso si eso significa reabrir el navegador y volver a iniciar sesión cada vez. Esto es coherente con el enfoque híbrido: el camino rápido (cuando hay `navigationHints`) ya es barato — probar 2-3 rutas y hacer un login real toma segundos, no minutos — así que el coste de no cachear es aceptable en el caso común. Solo el camino agentic (poco frecuente, patrón nuevo o camino rápido fallido) es notablemente más lento.

## 8. Manejo de errores y seguridad

Clases de fallo, todas con mensaje claro y sin reintento automático de la exploración:

- **Ruta no encontrada** tras agotar `routeCandidates` y el camino agentic: error apuntando a que ninguna ruta probada sirvió, con la lista de URLs intentadas.
- **Elemento no encontrado** (ni el camino rápido ni el agentic lo localizan): error con el paso Gherkin que lo necesitaba.
- **Credenciales de test ausentes** pero el escenario requiere login: error claro apuntando a rellenar `AGENTE_QA_TEST_USERNAME`/`AGENTE_QA_TEST_PASSWORD` en `.agente-qa/.env` — no se intenta adivinar ni generar código sin ellas.
- **Límite de pasos agotado** en el camino agentic (20 acciones): error indicando que el escenario no se pudo completar automáticamente.

**Por qué no hay reintento automático de la exploración completa**: a diferencia del bucle de lint (barato, sin efectos secundarios), reintentar una exploración que incluye login real tiene efectos secundarios sobre la cuenta de test (riesgo de disparar límites de intentos/bloqueo de la propia app bajo test — hay un escenario exactamente de eso en el Gherkin de ejemplo: "Login fallido con usuario bloqueado"). Fallar una vez, alto y claro, es preferible a reintentar en bucle contra la app real sin que el usuario lo sepa.

**El LLM nunca ve las credenciales reales.** En el camino agentic, el LLM solo puede pedir una acción `fill_credential` con `field: "username" | "password"` — el driver (código, no el LLM) sustituye el valor real localmente antes de escribirlo en el navegador. Ni el prompt ni la respuesta del LLM contienen nunca el usuario o la contraseña de test.

Esta funcionalidad automatiza logins reales de forma repetida contra la aplicación bajo test — antes de darla por cerrada, pasa por la skill `seguridad-seo` (CLAUDE.md lo exige al tocar credenciales/auth).

## 9. Testing

- `FakeSiteExplorer`: determinista, sin red ni navegador — cubre la lógica de `runGenerador` (inyección de evidencia en el prompt, corte inmediato si `ok: false`) igual que `FakeCodeChecker`/`FakeTestRunner` cubren sus agentes.
- `realSiteExplorer`: red real, navegador real, credenciales reales — test gateado (`describe.skipIf`) si no hay navegadores de Playwright (Node) instalados o no hay credenciales de prueba disponibles en el entorno de test, mismo patrón que `realCodeChecker`/`realTestRunner`.
- Prompt del camino agentic (`explorer.ts`): tests de las funciones puras de construcción del prompt (sin llamar al LLM real), igual que `generador.test.ts` ya hace con `codeGenerationPrompt`.

## 10. Puntos abiertos para specs futuras

- Patrones nuevos guardados por el usuario (`saveProjectPattern`, cuando no hubo match) no capturan `navigationHints` automáticamente a partir de lo que hizo el camino agentic — quedan siempre en camino agentic hasta que una spec futura decida cómo traducir la traza de acciones a pistas de navegación reutilizables.
- Si en el futuro se decide que Agente 1 (intake) también debería explorar (para escribir un Gherkin más ajustado a la app real desde el principio), es una spec aparte — este documento fija explícitamente que v1 solo explora en Agente 2.
