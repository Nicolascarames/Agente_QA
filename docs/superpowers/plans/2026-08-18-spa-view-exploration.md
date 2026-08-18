# Exploración de vistas SPA — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que el Explorador recorra vistas de una SPA que cambian el DOM sin cambiar de URL — promoviendo a pantalla propia las que revelan un campo rellenable, y explorando siempre más allá, promovido o no — y que el código Python generado sepa reproducir el camino hasta ellas.

**Architecture:** El crawler pasa de una cola BFS de URLs a una cola BFS de "nodos" (URL directa, o URL de un ancestro más un camino de acciones). Cada nodo se clasifica al descubrirse — pantalla propia si añade un input/select, estado del ancestro si no — pero en ambos casos sus controles nuevos se siguen encolando. La aprobación de escrituras pasa de una llamada única al final a una llamada por cada frontera de formularios nuevos. El emisor de Page Objects añade un `goto()` que reproduce el camino grabado, y el prompt del Generador aprende a describírselo al LLM cuando lleva parámetros.

**Tech Stack:** TypeScript (core+cli, ESM/NodeNext), Playwright (crawler), Zod (esquemas), Vitest, Python/pytest-bdd (salida generada, no se ejecuta en este plan).

**Spec:** `docs/superpowers/specs/2026-08-18-spa-view-exploration-design.md`

## Global Constraints

- Imports relativos con sufijo `.js` aunque el fichero sea `.ts` (ESM NodeNext).
- `core/src` nunca hace I/O de terminal ni depende de UI — toda interacción cruza callbacks inyectados.
- Un fichero de test por módulo, no por tarea: los casos nuevos van al fichero de test ya existente del módulo que tocan.
- `tsc --noEmit` (ambos paquetes) y `vitest run` se corren una vez al cerrar cada tarea, no tras cada edición.
- `schemaVersion` sube a `2`; un `map.json` v1 se rechaza al cargar, no se migra.
- Ningún formulario se envía sin aprobación explícita — la aprobación se vuelve incremental (D4), nunca se elimina.
- `maxViewDepth` por defecto `4`.
- Separador de id de vista anidada: `~` (nunca `-`, que ya aparece dentro de un segmento kebab-case).

**Corrección de alcance encontrada al planificar** (no requiere tocar la spec de nuevo): la resolución de `toScreenId` por `urlTemplate` al final del walk (`realCrawler.ts` ~1676) **no necesita arreglo**. Una pantalla anidada solo puede existir en el array `screens` después de que su ancestro ya esté en él —nada puede referenciar un `entryScreenId` que no exista todavía— así que `screens.find(s => s.urlTemplate === template)` siempre encuentra primero al ancestro, sea cual sea el orden de la cola. La Tarea 1 no toca esa función.

---

## Estructura de ficheros

**Nuevo:**
- `core/src/appMap/credentialFields.ts` — `PASSWORD_NAME`, `hasPasswordField`, `looksLikeEmail`, extraídos de `realCrawler.ts` para que `pageObjectEmitter.ts` (sin dependencia de Playwright) pueda decidir "¿este envío es un login?" sin importar `realCrawler.ts` entero.
- `core/src/appMap/credentialFields.test.ts`
- `core/src/appMap/__fixtures__/site/spa-nested.html` — fixture nuevo: login que no cambia de URL, dashboard con un botón que revela un formulario con un input de texto.

**Modificados (por tarea, ver cada una):**
- `core/src/appMap/schema.ts`, `mapStore.ts`, `mapStore.test.ts`
- `core/src/agents/intake/checkFeatureLiterals.ts`, `.test.ts`
- `core/src/appMap/elementIdentity.ts`, `.test.ts`
- `core/src/appMap/crawler.ts`, `testUtils.test.ts`
- `core/src/config/projectConfig.ts`, y sus tests
- `core/src/appMap/realCrawler.ts`, `realCrawler.walk.test.ts`, `realCrawler.capture.test.ts`
- `core/src/appMap/pageObjectEmitter.ts`, `.test.ts`
- `core/src/prompts/generador.ts`, `.test.ts`
- `cli/src/prompts/types.ts`, `inquirerPrompts.ts`
- `cli/src/commands/init.ts`, `.test.ts`

---

### Task 1: Esquema — `reachedBy`, `schemaVersion: 2`, rechazo de mapas v1

**Files:**
- Modify: `core/src/appMap/schema.ts:27-35` (ScreenStateSchema, sin cambios de forma pero referenciado), `:67-82` (ScreenSchema), `:92-107` (AppMapSchema)
- Modify: `core/src/appMap/mapStore.ts` (todo el fichero, ~46 líneas)
- Test: `core/src/appMap/schema.test.ts`, `core/src/appMap/mapStore.test.ts`

**Interfaces:**
- Produces: `ScreenSchema` gana `reachedBy` opcional:
  ```ts
  export const ScreenReachedBySchema = z.object({
    entryScreenId: z.string().min(1),
    path: z.array(
      z.object({
        action: z.enum(["click", "submit"]),
        locator: z.string().min(1),
        data: z.enum(["valid", "invalid", "none"]),
      })
    ).min(1),
  });
  ```
  Tipo exportado `ScreenReachedBy`. `AppMapSchema.schemaVersion` pasa de `z.literal(1)` a `z.literal(2)`.

- [ ] **Step 1: Test — el esquema acepta una pantalla con `reachedBy`**

En `core/src/appMap/schema.test.ts`, junto a los tests existentes de `ScreenSchema`:

```ts
it("accepts a screen reached by a path of actions from an addressable ancestor", () => {
  const screen = {
    ...baseScreen, // usa el mismo fixture base que el resto del fichero
    id: "home~crear-bebe",
    reachedBy: {
      entryScreenId: "home",
      path: [
        { action: "submit", locator: "log_in_button_2", data: "valid" },
        { action: "click", locator: "crear_bebe_button", data: "none" },
      ],
    },
  };
  expect(ScreenSchema.safeParse(screen).success).toBe(true);
});

it("rejects schemaVersion 1", () => {
  const map = { ...baseMap, schemaVersion: 1 };
  expect(AppMapSchema.safeParse(map).success).toBe(false);
});
```

Si el fichero no tiene ya un `baseScreen`/`baseMap` reutilizable, constrúyelo mínimo a partir del `ScreenSchema` (mira los tests ya existentes en el fichero para el shape exacto que usan).

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/schema.test.ts`
Expected: FAIL — `reachedBy` no existe en el tipo / `schemaVersion: 1` todavía se acepta.

- [ ] **Step 3: Implementar**

En `core/src/appMap/schema.ts`, antes de `ScreenSchema`:

```ts
export const ScreenReachedBySchema = z.object({
  entryScreenId: z.string().min(1),
  path: z
    .array(
      z.object({
        action: z.enum(["click", "submit"]),
        locator: z.string().min(1),
        data: z.enum(["valid", "invalid", "none"]),
      })
    )
    .min(1),
});
```

Dentro de `ScreenSchema`, añade el campo:
```ts
  /** Presente solo en una vista sin URL propia: cómo se llega a ella desde `entryScreenId`. */
  reachedBy: ScreenReachedBySchema.optional(),
```

En `AppMapSchema`, cambia `schemaVersion: z.literal(1)` por `schemaVersion: z.literal(2)`.

Al final del fichero, junto a los demás `export type`:
```ts
export type ScreenReachedBy = z.infer<typeof ScreenReachedBySchema>;
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/appMap/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Test — `mapStore` rechaza un mapa v1 con mensaje explícito**

En `core/src/appMap/mapStore.test.ts`, junto al test existente de "formato inesperado":

```ts
it("rejects a schemaVersion 1 map with a message that asks to re-map", async () => {
  const target = appMapPath(tmpProject);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ ...validV2Map, schemaVersion: 1 }));

  await expect(loadAppMap(tmpProject)).rejects.toThrow(/agente-qa map/);
});
```

Usa el mismo patrón de `tmpProject`/`beforeEach`/`afterEach` que ya tiene el fichero, y un `validV2Map` mínimo construido igual que el resto de tests de guardado/carga del fichero.

- [ ] **Step 6: Verificar que falla, implementar si hace falta, verificar que pasa**

Run: `npx vitest run core/src/appMap/mapStore.test.ts`

`mapStore.ts` ya usa `AppMapSchema.safeParse` y ya lanza el mensaje "no tiene el formato esperado... Vuelve a mapear" cuando `safeParse` falla — con `schemaVersion` ahora `z.literal(2)`, un mapa v1 YA falla ese `safeParse` sin tocar más código. Confirma con el run; si pasa sin cambios, no hay Step de implementación aquí, solo confirmación.

- [ ] **Step 7: `tsc` de core**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: limpio. Si algo en `realCrawler.ts` construye `{ schemaVersion: 1, ... }` fallará aquí — se corrige en la Tarea 8 (es la misma línea que la Tarea 8 toca de todos modos), así que un error en `realCrawler.ts:1708` en este punto es esperado y se deja para entonces.

- [ ] **Step 8: Commit**

```bash
git add core/src/appMap/schema.ts core/src/appMap/schema.test.ts core/src/appMap/mapStore.test.ts
git commit -m "feat(core): add reachedBy to ScreenSchema and bump schemaVersion to 2"
```

---

### Task 2: `checkFeatureLiterals` admite `~` en la etiqueta `@screen:`

**Files:**
- Modify: `core/src/agents/intake/checkFeatureLiterals.ts:21`
- Test: `core/src/agents/intake/checkFeatureLiterals.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `SCREEN_TAG` sigue exportando el mismo comportamiento, solo amplía el conjunto de caracteres aceptados.

- [ ] **Step 1: Test — reconoce una etiqueta con `~`**

En `core/src/agents/intake/checkFeatureLiterals.test.ts`, añade junto a los tests de reconocimiento de etiqueta:

```ts
it("recognizes a nested screen tag containing '~'", () => {
  const map = /* mapa mínimo con una screen id "home~crear-bebe" y algún texto */;
  const feature = `Feature: x
  @screen:home~crear-bebe
  Scenario: y
    Then I see "Crear bebé"`;
  const result = checkFeatureLiterals(feature, map);
  expect(result.screenTagFound).toBe(true);
});
```

Construye el `map` mínimo con el mismo estilo que ya usan los tests vecinos del fichero (un `AppMap` con una única `Screen` cuyo `texts` incluya `"Crear bebé"`).

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/agents/intake/checkFeatureLiterals.test.ts`
Expected: FAIL — `screenTagFound` es `false` porque el regex corta en `home`.

- [ ] **Step 3: Implementar**

En `core/src/agents/intake/checkFeatureLiterals.ts:21`:

```ts
const SCREEN_TAG = /@screen:([\p{L}\p{N}_~-]+)/u;
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/agents/intake/checkFeatureLiterals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/agents/intake/checkFeatureLiterals.ts core/src/agents/intake/checkFeatureLiterals.test.ts
git commit -m "fix(core): accept '~' in @screen: tags for nested SPA views"
```

---

### Task 3: `screenIdentity` traduce `~` a un nombre de clase Python válido

**Files:**
- Modify: `core/src/appMap/realCrawler.ts:771-777`
- Test: `core/src/appMap/realCrawler.capture.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `screenIdentity(screenId: string): { id: string; name: string; className: string }` — mismo tipo, `className` ahora también válido para un id con `~`.

- [ ] **Step 1: Test — un id con `~` produce un className PascalCase sin `~`**

`screenIdentity` no está exportada. Añade el test contra su efecto observable: captura o construye un `Screen` con `id: "home~crear-bebe"` y comprueba `className`. Si el fichero de test ya tiene un helper que llama a `captureScreen` con un `screenId` inyectado, reutilízalo; si no, exporta `screenIdentity` (quítale el `function` sin `export` y añade `export`) — es la opción más simple y no cambia su comportamiento.

En `core/src/appMap/realCrawler.capture.test.ts`:

```ts
it("derives a valid Python class name from a nested view id containing '~'", () => {
  const identity = screenIdentity("home~crear-bebe");
  expect(identity.className).toBe("HomeCrearBebePage");
  expect(identity.id).toBe("home~crear-bebe");
});
```

Añade `screenIdentity` al import del fichero desde `./realCrawler.js`.

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: FAIL — `screenIdentity` no se exporta, o el className sale como `Home~crear_bebePage` (inválido en Python).

- [ ] **Step 3: Implementar**

En `core/src/appMap/realCrawler.ts:771`, exporta la función y traduce `~` antes de derivar el className:

```ts
/** `id`, `name` y `className` derivan todos del mismo slug, en un solo sitio. */
export function screenIdentity(screenId: string): { id: string; name: string; className: string } {
  const pythonSafeSlug = screenId.replace(/~/g, "_");
  return {
    id: screenId,
    name: screenId,
    className: `${pythonIdentifier(pythonSafeSlug).replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())}Page`,
  };
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/realCrawler.capture.test.ts
git commit -m "fix(core): derive a valid Python class name for nested view ids"
```

---

### Task 4: Extraer `credentialFields.ts` — detección de login sin Playwright

**Files:**
- Create: `core/src/appMap/credentialFields.ts`
- Create: `core/src/appMap/credentialFields.test.ts`
- Modify: `core/src/appMap/realCrawler.ts:34` (borra `PASSWORD_NAME` local), `:886-891` (`valueFor`, reusa `looksLikeEmail`/`PASSWORD_NAME` importados), `:961-966` (`hasPasswordField`, se borra, se importa)

**Interfaces:**
- Produces:
  ```ts
  export const PASSWORD_NAME: RegExp;
  export function looksLikeEmailField(fieldName: string): boolean;
  export function hasPasswordField(screen: Screen, action: WriteAction): boolean;
  ```
  `pageObjectEmitter.ts` (Tarea 12) importa `hasPasswordField` de aquí — es el motivo de la extracción: ese fichero no puede depender de `realCrawler.ts`, que importa `playwright`.

- [ ] **Step 1: Test — `hasPasswordField` y `looksLikeEmailField`**

En `core/src/appMap/credentialFields.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hasPasswordField, looksLikeEmailField, PASSWORD_NAME } from "./credentialFields.js";
import type { Screen, WriteAction } from "./schema.js";

const baseScreen = (locators: Screen["locators"]): Screen => ({
  id: "home", name: "home", className: "HomePage", urlTemplate: "/",
  signature: "sig", requiresAuth: false, texts: [], probeValues: [],
  locators, states: [], ambiguous: [], transitions: [], writeActions: [],
});

describe("hasPasswordField", () => {
  it("is true when a form field's accessible name looks like a password", () => {
    const screen = baseScreen([
      { name: "password_input", kind: "input", accessibleName: "Password", python: "page.get_by_label(\"Password\")", count: 1, verifiedAt: "2026-01-01" },
    ]);
    const action: WriteAction = { locator: "submit_button", label: "Log in", kind: "submit", formFields: ["password_input"] };
    expect(hasPasswordField(screen, action)).toBe(true);
  });

  it("is false when no form field is a password", () => {
    const screen = baseScreen([
      { name: "name_input", kind: "input", accessibleName: "Nombre", python: "page.get_by_label(\"Nombre\")", count: 1, verifiedAt: "2026-01-01" },
    ]);
    const action: WriteAction = { locator: "crear_button", label: "Crear", kind: "submit", formFields: ["name_input"] };
    expect(hasPasswordField(screen, action)).toBe(false);
  });
});

describe("looksLikeEmailField", () => {
  it("matches common email/username field names", () => {
    expect(looksLikeEmailField("Email")).toBe(true);
    expect(looksLikeEmailField("Usuario")).toBe(true);
    expect(looksLikeEmailField("Nombre")).toBe(false);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/credentialFields.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crea `core/src/appMap/credentialFields.ts`:

```ts
import type { Screen, WriteAction } from "./schema.js";

export const PASSWORD_NAME = /password|contrasena|contraseña|clave/i;

/** Mismo criterio que `realCrawler.ts` usa al decidir qué valor de prueba darle a un campo. */
export function looksLikeEmailField(fieldName: string): boolean {
  return /email|correo|user|usuario/i.test(fieldName);
}

/**
 * Si alguno de los campos de este envío parece una contraseña. Es el único
 * criterio del proyecto para "esto es un login": ni el propio Explorador ni
 * el emisor de Page Objects (que no puede importar Playwright) tienen otra
 * señal — un envío de credenciales siempre pide contraseña, y ningún otro
 * formulario de la aplicación debería hacerlo.
 */
export function hasPasswordField(screen: Screen, action: WriteAction): boolean {
  return action.formFields.some((fieldName) => {
    const field = screen.locators.find((l) => l.name === fieldName);
    return field?.accessibleName !== undefined && PASSWORD_NAME.test(field.accessibleName);
  });
}
```

Ahora en `core/src/appMap/realCrawler.ts`:
- Borra la línea 34 (`const PASSWORD_NAME = ...`).
- Borra la función `hasPasswordField` en `:961-966`.
- Añade a los imports: `import { PASSWORD_NAME, looksLikeEmailField, hasPasswordField } from "./credentialFields.js";`
- En `valueFor` (línea ~886), reemplaza `const looksLikeEmail = /email|correo|user|usuario/i.test(fieldName);` por `const looksLikeEmail = looksLikeEmailField(fieldName);`.

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/appMap/credentialFields.test.ts core/src/appMap/realCrawler.write.test.ts`
Expected: PASS en ambos — el segundo confirma que mover `hasPasswordField`/`PASSWORD_NAME` no rompió el comportamiento de login existente.

- [ ] **Step 5: `tsc` de core**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add core/src/appMap/credentialFields.ts core/src/appMap/credentialFields.test.ts core/src/appMap/realCrawler.ts
git commit -m "refactor(core): extract password-field detection so pageObjectEmitter can reuse it"
```

---

### Task 5: Detección de sesión por firma, no por URL (D3)

**Files:**
- Modify: `core/src/appMap/realCrawler.ts:1060-1092` (`attemptLogin`), `:1230-1245` (`runWritePass`, comparación de URL para `authenticated`)
- Test: `core/src/appMap/realCrawler.write.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function submitSucceeded(
    page: Page, before: string, loginSignature: string | null, secrets: string[]
  ): Promise<boolean>
  ```
  Usada por `attemptLogin` y `runWritePass` para decidir si un envío de login tuvo éxito. Requiere que un campo de contraseña siga presente o no en la vista resultante — reutiliza `currentSignature` (ya definida, `:764`) y necesita saber si la vista actual todavía muestra un campo de contraseña, así que recibe también el `Page` para consultarlo directamente vía `page.getByRole("textbox").locator(...)` NO — más simple: reutiliza el resultado de `currentSignature` más una comprobación de si existe algún `input[type=password]` visible, que Playwright puede responder sin pasar por el mapa.

- [ ] **Step 1: Test — el fixture SPA de login (sin cambio de URL) se detecta como autenticado**

Este test necesita el fixture nuevo de la Tarea 9; para no bloquear esta tarea con esa dependencia, escribe aquí un fixture HTML mínimo dedicado, `core/src/appMap/__fixtures__/site/spa-login-only.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fixture · SPA login, no route change</title></head>
  <body>
    <main id="app">
      <h1>Sign in</h1>
      <form id="login">
        <label>Email <input name="email" type="email" /></label>
        <label>Password <input name="password" type="password" /></label>
        <button type="submit">Log in</button>
      </form>
    </main>
    <script>
      document.getElementById("login").addEventListener("submit", (event) => {
        event.preventDefault();
        document.getElementById("app").innerHTML = "<h1>Dashboard</h1><p>Welcome back.</p>";
      });
    </script>
  </body>
</html>
```

En `core/src/appMap/realCrawler.write.test.ts`, junto a los tests de `attemptLogin`/autenticación existentes:

```ts
it("marks the crawl authenticated after a login that swaps the view without changing the URL", async () => {
  const result = await createRealCrawler().crawl({
    baseUrl: site.url.replace(/\/$/, "") + "/spa-login-only.html",
    limits,
    credentials: { username: "user@example.test", password: "secret" },
    callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async () => [] },
    emit: () => {},
  });
  if (!result.ok) throw new Error(result.error);
  expect(result.map.authenticated).toBe(true);
}, 20000);
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/realCrawler.write.test.ts -t "swaps the view without changing"`
Expected: FAIL — `authenticated` sale `false` porque `page.url() !== before` es falso (la URL no cambió).

- [ ] **Step 3: Implementar**

En `core/src/appMap/realCrawler.ts`, añade cerca de `currentSignature` (después de su definición, `:768`):

```ts
/**
 * Si un envío que se suponía login tuvo éxito. La URL cambiando sigue siendo
 * la señal más barata y se comprueba primero; en una SPA nunca cambia, así
 * que la segunda comprobación es la que de verdad importa aquí: la firma dejó
 * de ser la de la pantalla de login Y ya no queda ningún campo de contraseña
 * visible. Comparar solo firmas no vale — un login FALLIDO también cambia la
 * firma, al pintar el mensaje de error.
 */
async function submitSucceeded(
  page: Page,
  before: string,
  loginSignature: string | null,
  secrets: string[]
): Promise<boolean> {
  if (page.url() !== before) return true;
  if (loginSignature === null) return false;
  const signature = await currentSignature(page, secrets);
  if (signature === null || signature === loginSignature) return false;
  const passwordFieldCount = await page
    .locator('input[type="password"]')
    .count()
    .catch(() => 1); // en caso de error, no reclamar éxito
  return passwordFieldCount === 0;
}
```

En `attemptLogin` (`:1078-1088`), reemplaza:

```ts
  const authenticated = page.url() !== before;
```

por:

```ts
  const authenticated = await submitSucceeded(page, before, entry.signature, secrets);
```

(el parámetro `loginSignature` es la firma de `entry`, la propia pantalla de login, ya capturada arriba en la función).

En `runWritePass`, dentro del bucle de datos `"valid"`/`"invalid"` (`:1230` en adelante), la comprobación actual es `if (page.url() !== before) { ... if (data === "valid") { ...; if (isLoginAction) authenticated = true; } continue; }`. Cuando `isLoginAction` es verdad y la URL NO cambió, hoy cae directo a `mergeScreenState` sin comprobar si fue un login SPA exitoso. Cambia la condición para ese caso:

```ts
      if (page.url() !== before) {
        if (data === "valid") {
          emit({ agent: "explorador", status: "ok", depth: 1, message: `Envío válido de "${action.label}" → ${page.url()}` });
          if (isLoginAction) authenticated = true;
        }
        continue;
      }

      if (isLoginAction && data === "valid") {
        const succeeded = await submitSucceeded(page, before, screen.signature, secrets);
        if (succeeded) {
          authenticated = true;
          emit({ agent: "explorador", status: "ok", depth: 1, message: `Envío válido de "${action.label}" (sin cambio de URL, sesión iniciada)` });
          continue;
        }
      }
```

(el resto de la función sigue igual: si no fue ese caso, cae a la captura de estado existente).

`submitSucceeded` necesita `screen.signature` como `loginSignature` aquí — es la firma de la propia pantalla de login antes del envío, que es exactamente lo que `screen.signature` contiene en este punto (el `screen` sobre el que se está iterando en `runWritePass` es la pantalla de login cuando `isLoginAction` es verdad).

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/appMap/realCrawler.write.test.ts`
Expected: PASS — incluye el test nuevo y todos los existentes de escritura/login.

- [ ] **Step 5: `tsc` de core**

Run: `npx tsc -p core/tsconfig.json --noEmit`

- [ ] **Step 6: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/__fixtures__/site/spa-login-only.html core/src/appMap/realCrawler.write.test.ts
git commit -m "fix(core): detect a successful SPA login by signature, not URL change"
```

---

### Task 6: `mergeScreenState` también funde `writeActions`

**Files:**
- Modify: `core/src/appMap/elementIdentity.ts:17-43`
- Test: `core/src/appMap/elementIdentity.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces:
  ```ts
  export function mergeScreenState(
    screen: Screen,
    state: { id: string; reachedBy: ScreenState["reachedBy"]; texts: string[]; locators: LocatorEntry[]; writeActions?: WriteAction[] }
  ): Screen
  ```
  Un formulario descubierto dentro de un estado (no solo en la captura base) ahora aparece en `screen.writeActions` — lo necesita la Tarea 8 (para explorar más allá) y la Tarea 10 (para que la aprobación incremental lo ofrezca).

- [ ] **Step 1: Test — un `writeActions` nuevo se añade sin duplicar uno existente**

En `core/src/appMap/elementIdentity.test.ts`, junto a los tests de `mergeScreenState`:

```ts
it("merges new writeActions without duplicating an existing one by locator", () => {
  const screen: Screen = {
    ...baseScreen, // el fixture base que ya use el fichero
    writeActions: [{ locator: "log_in_button_2", label: "Log in", kind: "submit", formFields: ["email_input", "password_input"] }],
  };
  const merged = mergeScreenState(screen, {
    id: "click-crear_bebe_button",
    reachedBy: { action: "click", locator: "crear_bebe_button", data: "none" },
    texts: [],
    locators: [],
    writeActions: [
      { locator: "log_in_button_2", label: "Log in", kind: "submit", formFields: ["email_input", "password_input"] }, // ya existe
      { locator: "crear_button", label: "Crear", kind: "submit", formFields: ["name_input", "birth_date_input"] }, // nuevo
    ],
  });
  expect(merged.writeActions).toHaveLength(2);
  expect(merged.writeActions.map((a) => a.locator)).toEqual(["log_in_button_2", "crear_button"]);
});

it("keeps writeActions unchanged when the merge doesn't pass any", () => {
  const screen: Screen = { ...baseScreen, writeActions: [] };
  const merged = mergeScreenState(screen, {
    id: "click-x", reachedBy: { action: "click", locator: "x", data: "none" }, texts: [], locators: [],
  });
  expect(merged.writeActions).toEqual([]);
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/elementIdentity.test.ts`
Expected: FAIL — `state.writeActions` no existe en el tipo del segundo parámetro, o el resultado no incluye `writeActions`.

- [ ] **Step 3: Implementar**

En `core/src/appMap/elementIdentity.ts`, añade `WriteAction` al import de `./schema.js` y cambia la firma y el cuerpo:

```ts
export function mergeScreenState(
  screen: Screen,
  state: {
    id: string;
    reachedBy: ScreenState["reachedBy"];
    texts: string[];
    locators: LocatorEntry[];
    writeActions?: WriteAction[];
  }
): Screen {
  const uniqueIncomingTexts = Array.from(new Set(state.texts));
  const newTexts = uniqueIncomingTexts.filter((text) => !screen.texts.includes(text));

  const existingLocatorNames = new Set(screen.locators.map((l) => l.name));
  const taggedLocators: LocatorEntry[] = state.locators
    .filter((locator) => !existingLocatorNames.has(locator.name))
    .map((locator) => ({ ...locator, stateId: state.id }));

  const existingActionLocators = new Set(screen.writeActions.map((a) => a.locator));
  const newWriteActions = (state.writeActions ?? []).filter((action) => !existingActionLocators.has(action.locator));

  return {
    ...screen,
    texts: [...screen.texts, ...newTexts],
    locators: [...screen.locators, ...taggedLocators],
    states: [...screen.states, { id: state.id, reachedBy: state.reachedBy, addsTexts: newTexts }],
    writeActions: [...screen.writeActions, ...newWriteActions],
  };
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/appMap/elementIdentity.test.ts`
Expected: PASS

- [ ] **Step 5: `tsc` de core**

Run: `npx tsc -p core/tsconfig.json --noEmit`

- [ ] **Step 6: Commit**

```bash
git add core/src/appMap/elementIdentity.ts core/src/appMap/elementIdentity.test.ts
git commit -m "feat(core): merge writeActions discovered inside a state, not just at capture"
```

---

### Task 7: `maxViewDepth` en `CrawlLimits` y `ProjectConfigSchema`

**Files:**
- Modify: `core/src/appMap/crawler.ts:9-15` (`CrawlLimits`)
- Modify: `core/src/config/projectConfig.ts:32-45` (bloque `crawl`)
- Test: `core/src/appMap/testUtils.test.ts`, tests de `projectConfig` (busca el fichero existente — probablemente `core/src/config/projectConfig.test.ts`)

**Interfaces:**
- Produces: `CrawlLimits.maxViewDepth: number` y `ProjectConfigSchema`'s `crawl.maxViewDepth`, default `4` en ambos.

- [ ] **Step 1: Test — el default de `crawl` incluye `maxViewDepth: 4`**

Busca el test existente que compara `ProjectConfigSchema.parse({})` (o equivalente) contra el objeto de defaults — probablemente en `core/src/config/projectConfig.test.ts`. Añade `maxViewDepth: 4` a la expectativa:

```ts
expect(ProjectConfigSchema.parse({ /* campos obligatorios mínimos */ }).crawl).toEqual({
  maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
  loopSuspicionThreshold: 3, excludeRoutes: [], maxViewDepth: 4,
});
```

Actualiza también cualquier otro literal `{ maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [] }` que aparezca en tests existentes (`testUtils.test.ts:16,27,39`, `cli/src/commands/init.test.ts`, `cli/src/commands/map.test.ts`) — añádeles `maxViewDepth: 4` (o el valor que cada test concreto necesite) para que sigan compilando y pasando.

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/config/projectConfig.test.ts`
Expected: FAIL — falta `maxViewDepth` en el resultado.

- [ ] **Step 3: Implementar**

En `core/src/appMap/crawler.ts:9-15`:

```ts
export interface CrawlLimits {
  maxScreens: number;
  maxDepth: number;
  maxDurationMinutes: number;
  loopSuspicionThreshold: number;
  excludeRoutes: string[];
  /** Cuántas acciones desde una pantalla direccionable explora el crawler dentro de una vista SPA. */
  maxViewDepth: number;
}
```

En `core/src/config/projectConfig.ts:32-45`:

```ts
  crawl: z
    .object({
      maxScreens: z.number().int().min(1).default(500),
      maxDepth: z.number().int().min(1).default(25),
      maxDurationMinutes: z.number().int().min(1).default(60),
      loopSuspicionThreshold: z.number().int().min(2).default(3),
      excludeRoutes: z.array(z.string()).default([]),
      maxViewDepth: z.number().int().min(0).default(4),
    })
    .default({
      maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
      loopSuspicionThreshold: 3, excludeRoutes: [], maxViewDepth: 4,
    }),
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/config/projectConfig.test.ts core/src/appMap/testUtils.test.ts`
Expected: PASS

- [ ] **Step 5: `tsc` de ambos paquetes**

Run: `npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: probablemente falle en `cli/src/commands/init.test.ts` y `cli/src/commands/map.test.ts` por los literales de `CrawlLimits` sin `maxViewDepth` — corrígelos aquí mismo (son el mismo tipo de arreglo mecánico que el Step 1).

- [ ] **Step 6: Re-run completo**

Run: `npx vitest run`
Expected: PASS en todo el repo (esta tarea no cambia comportamiento del crawler todavía, solo el tipo y su default).

- [ ] **Step 7: Commit**

```bash
git add core/src/appMap/crawler.ts core/src/config/projectConfig.ts core/src/config/projectConfig.test.ts core/src/appMap/testUtils.test.ts cli/src/commands/init.test.ts cli/src/commands/map.test.ts
git commit -m "feat(core): add maxViewDepth crawl limit, default 4"
```

---

### Task 8: Fixture SPA anidado — login sin URL + modal con input

**Files:**
- Create: `core/src/appMap/__fixtures__/site/spa-nested.html`

**Interfaces:**
- Produces: página estática que las Tareas 9 y 11 usan como base de sus tests de integración.

- [ ] **Step 1: Crear el fixture**

```html
<!doctype html>
<html lang="en">
  <!-- El caso completo que motiva esta funcionalidad: un login que no cambia
       la URL, seguido de un botón cuyo contenido revela un formulario real
       (con un input, no solo botones) — el equivalente en miniatura de
       "Log in" → dashboard → "Crear bebé" en la aplicación real medida. -->
  <head><meta charset="utf-8" /><title>Fixture · Nested SPA views</title></head>
  <body>
    <main id="app">
      <h1>Sign in</h1>
      <form id="login">
        <label>Email <input name="email" type="email" /></label>
        <label>Password <input name="password" type="password" /></label>
        <button type="submit">Log in</button>
      </form>
    </main>
    <script>
      document.getElementById("login").addEventListener("submit", (event) => {
        event.preventDefault();
        document.getElementById("app").innerHTML = `
          <h1>Dashboard</h1>
          <p>You have no baby yet.</p>
          <button type="button" id="create-baby">Create baby</button>
        `;
        document.getElementById("create-baby").addEventListener("click", () => {
          document.getElementById("app").innerHTML = `
            <h1>New baby</h1>
            <form id="baby-form">
              <label>Name <input name="name" type="text" /></label>
              <button type="submit">Create</button>
            </form>
          `;
        });
      });
    </script>
  </body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add core/src/appMap/__fixtures__/site/spa-nested.html
git commit -m "test(core): add a nested-SPA fixture (login + modal form) for walk tests"
```

---

### Task 9: Clasificación promoción-vs-estado (D1), función pura y testeable

**Files:**
- Modify: `core/src/appMap/realCrawler.ts` — nueva función junto a `currentSignature`/`screenIdentity` (`:764-777`)
- Test: `core/src/appMap/realCrawler.capture.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function classifyViewChange(newLocators: LocatorEntry[]): "promote" | "state";
  ```
  La usa la Tarea 10.

- [ ] **Step 1: Test**

En `core/src/appMap/realCrawler.capture.test.ts`, añade el import de `classifyViewChange` y:

```ts
describe("classifyViewChange", () => {
  it("promotes when a new input appears", () => {
    const locators = [{ name: "name_input", kind: "input" } as LocatorEntry];
    expect(classifyViewChange(locators)).toBe("promote");
  });

  it("promotes when a new select appears", () => {
    const locators = [{ name: "country_select", kind: "select" } as LocatorEntry];
    expect(classifyViewChange(locators)).toBe("promote");
  });

  it("stays a state when only buttons and links appear", () => {
    const locators = [
      { name: "send_reset_link_button", kind: "button" } as LocatorEntry,
      { name: "back_link", kind: "link" } as LocatorEntry,
    ];
    expect(classifyViewChange(locators)).toBe("state");
  });

  it("stays a state when nothing new appears", () => {
    expect(classifyViewChange([])).toBe("state");
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts -t classifyViewChange`
Expected: FAIL — la función no existe.

- [ ] **Step 3: Implementar**

En `core/src/appMap/realCrawler.ts`, junto a `screenIdentity`:

```ts
/**
 * D1: un campo rellenable (input o select) nuevo es un formulario real y se
 * promociona a pantalla propia. Un botón o enlace nuevo, por sí solo, se
 * queda como estado — un diálogo de confirmación o un menú desplegable no
 * merecen Page Object propio. Validado contra `state.html`: ese fixture
 * añade un botón sin ningún input y tres tests ya exigen que se quede estado.
 */
export function classifyViewChange(newLocators: LocatorEntry[]): "promote" | "state" {
  return newLocators.some((l) => l.kind === "input" || l.kind === "select") ? "promote" : "state";
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/appMap/realCrawler.capture.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/realCrawler.capture.test.ts
git commit -m "feat(core): classify a same-route DOM change as a promoted screen or a state"
```

---

### Task 10: Reescritura del bucle de exploración — cola por camino, promoción, y recursión a través de estados (D1+D2)

Esta es la tarea central del plan. Reescribe el bloque de clics de la primera pasada del walk (`realCrawler.ts:1508-1666` aprox.) para que:

1. La cola BFS mezcle elementos por URL y por camino.
2. Un clic que no cambia de ruta se clasifique con `classifyViewChange` (Tarea 9).
3. Si promociona: se captura una pantalla nueva completa (`captureScreen` + `collectWriteActions`), con su propio `reachedBy`.
4. Si no promociona: se funde como estado del ancestro (como hoy), pero usando la `mergeScreenState` extendida (Tarea 6) para no perder `writeActions` nuevos.
5. **En ambos casos**, los controles nuevos (botones, enlaces, y los del propio formulario si promocionó) se encolan con el camino extendido en un paso, mientras `path.length < maxViewDepth`.
6. Volver a un nodo con camino navega a la URL del ancestro y reproduce el camino, verificando la firma tras cada paso; una discrepancia aborta la rama (`complete: false`).
7. Al superar 10 vistas promocionadas bajo la misma pantalla base, se emite un aviso (spec, sección "Ruido en la promoción").

**Files:**
- Modify: `core/src/appMap/realCrawler.ts:1338` (tipo de `queue` y su primer valor), `:1357` y `:1666` (los otros `queue.push`), `:1369` (chequeo de `maxDepth`, que ahora solo aplica a items `kind: "url"`), `:1508-1666` (bloque de clics — la reescritura principal)
- Test: `core/src/appMap/realCrawler.walk.test.ts`

**Interfaces:**
- Consumes: `classifyViewChange` (Tarea 9), `mergeScreenState` extendida (Tarea 6), `screenIdentity` (Tarea 3), `CrawlLimits.maxViewDepth` (Tarea 7).
- Produces: el `AppMap` resultante contiene pantallas con `reachedBy` para toda vista promocionada, y sus `writeActions` propios.

- [ ] **Step 1: Test — el modal de crear bebé se promociona a pantalla con su camino**

En `core/src/appMap/realCrawler.walk.test.ts`, nuevo `describe`:

```ts
describe("a click inside a same-route login state that reveals a real form", () => {
  const crawlNestedFixture = () =>
    createRealCrawler().crawl({
      baseUrl: site.url.replace(/\/$/, "") + "/spa-nested.html",
      limits,
      credentials: { username: "user@example.test", password: "secret" },
      callbacks: { confirmContinueOnLoop: async () => false, approveWriteActions: async (pending) => pending.map((p) => ({ screenId: p.screenId, locator: p.action.locator })) },
      emit: () => {},
    });

  it("promotes the baby-creation form to its own screen with a reachedBy path", async () => {
    const result = await crawlNestedFixture();
    if (!result.ok) throw new Error(result.error);
    const babyScreen = result.map.screens.find((s) => s.reachedBy !== undefined);
    expect(babyScreen).toBeDefined();
    expect(babyScreen!.reachedBy).toEqual({
      entryScreenId: result.map.screens[0].id,
      path: [
        { action: "submit", locator: expect.any(String), data: "valid" },
        { action: "click", locator: "create_baby_button", data: "none" },
      ],
    });
    const nameInput = babyScreen!.locators.find((l) => l.kind === "input");
    expect(nameInput).toBeDefined();
  }, 20000);

  it("keeps screen count at 2: the login screen and the promoted baby-form screen", async () => {
    const result = await crawlNestedFixture();
    if (!result.ok) throw new Error(result.error);
    expect(result.map.screens).toHaveLength(2);
  }, 20000);
});
```

Ajusta los nombres exactos de locator (`create_baby_button`, etc.) tras correr el test una vez y leer lo que `captureScreen` deriva realmente del fixture — la convención de nombrado (`naming.ts`) ya existe y no la cambia este plan; el test debe reflejar el nombre real, no inventarlo.

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/realCrawler.walk.test.ts -t "reveals a real form"`
Expected: FAIL — `babyScreen` es `undefined` (todo sigue plano, sin promoción).

- [ ] **Step 3: Implementar — tipo de cola**

En `realCrawler.ts:1338`, reemplaza el tipo y el valor inicial:

```ts
      type PathStep = { action: "click" | "submit"; locator: string; data: "valid" | "invalid" | "none" };
      type WalkItem =
        | { kind: "url"; url: string; depth: number }
        | { kind: "path"; entryScreenId: string; path: PathStep[]; depth: number };
      const queue: WalkItem[] = [{ kind: "url", url: input.baseUrl, depth: 0 }];
```

En `:1357` (reencolar tras login que sí cambió de URL): `queue.push({ kind: "url", url: landed, depth: 0 });`

En `:1369` (chequeo de profundidad), sepáralo por tipo — un item `url` sigue usando `maxDepth`, un item `path` usa `maxViewDepth`:

```ts
          const next = queue.shift()!;
          if (next.kind === "url" && next.depth > input.limits.maxDepth) { complete = false; continue; }
          if (next.kind === "path" && next.path.length > input.limits.maxViewDepth) { complete = false; continue; }
```

- [ ] **Step 4: Implementar — bifurcar el procesamiento del item**

El cuerpo del `while` de `:1380` en adelante hoy asume siempre `next.url`/`next.depth` de un item de URL. Envuélvelo así: el bloque existente (captura de pantalla vía `page.goto` + `captureScreen`, deduplicación por firma/plantilla, `collectWriteActions`, y el bucle de clics) se convierte en la rama `next.kind === "url"`. Añade una rama hermana `next.kind === "path"` que:

```ts
          } else {
            // next.kind === "path": reproducir el camino sobre la URL del ancestro.
            const entry = screens.find((s) => s.id === next.entryScreenId);
            if (entry === undefined) continue; // no debería pasar: el ancestro siempre se captura antes de encolar un camino
            const entryUrl = concreteUrls.get(entry);
            if (entryUrl === undefined) continue;

            const replay = await replayPath(page, entryUrl, entry, next.path, input.credentials, emit);
            if (!replay.ok) {
              complete = false;
              emit({ agent: "explorador", status: "warn", depth: next.depth, message: `No se pudo reproducir el camino hasta ${next.path.map((s) => s.locator).join(" → ")}, se omite la rama` });
              continue;
            }

            const view = await captureScreen(page, { screenId: `${entry.id}~probe`, baseUrl: input.baseUrl, secrets, emit });
            const knownNames = new Set(entry.locators.map((l) => l.name));
            const newLocators = view.locators.filter((l) => !knownNames.has(l.name));
            const newWriteActions = await collectWriteActions(page, view, secrets);

            const lastStep = next.path[next.path.length - 1];
            const stateId = `path-${next.path.map((s) => s.locator).join("-")}`;

            if (classifyViewChange(newLocators) === "promote") {
              const promotedId = uniqueName(`${entry.id}~${lastStep.locator.replace(/_/g, "-")}`, assignedScreenIds);
              assignedScreenIds.add(promotedId);
              const promoted: Screen = {
                ...view,
                ...screenIdentity(promotedId),
                urlTemplate: entry.urlTemplate,
                reachedBy: { entryScreenId: entry.id, path: next.path },
                writeActions: newWriteActions,
              };
              concreteUrls.set(promoted, entryUrl);
              screens.push(promoted);
              promotedCountByAncestor.set(entry.id, (promotedCountByAncestor.get(entry.id) ?? 0) + 1);
              if ((promotedCountByAncestor.get(entry.id) ?? 0) > 10) {
                emit({
                  agent: "explorador", status: "warn", depth: next.depth,
                  message: `${entry.id} ya tiene más de 10 vistas promocionadas: probablemente hay un patrón repetitivo (acordeón, "cargar más"...). Considera bajar maxViewDepth o excluir esta ruta.`,
                });
              }
              emit({
                agent: "explorador", status: "ok", depth: next.depth,
                message: `${next.path.map((s) => s.locator).join(" → ")} revela un formulario nuevo: se promociona a ${promotedId}`,
              });
              enqueueChildren(promoted, next.path, next.depth);
            } else {
              Object.assign(
                entry,
                mergeScreenState(entry, {
                  id: stateId,
                  reachedBy: { action: lastStep.action, locator: lastStep.locator, data: lastStep.data },
                  texts: view.texts,
                  locators: newLocators,
                  writeActions: newWriteActions,
                })
              );
              enqueueChildren(entry, next.path, next.depth);
            }
          }
```

`enqueueChildren` es un helper local (declarado una vez, antes del `while`, con acceso a `queue`, `clickedElements`, `input.limits.maxViewDepth`) que factoriza EXACTAMENTE la misma lógica que hoy decide qué botones/enlaces pulsar — reutilízala en las dos ramas en vez de duplicar el bucle de `:1508-1660`. Esto incluye el cálculo de `twinIndex` (`:1499-1505` en el código actual): dos controles con el mismo `kind`+`accessibleName` en la misma pantalla (dos botones "Editar" en filas distintas de una tabla, por ejemplo) son elementos DISTINTOS, y `elementKey` los desambigua por posición — pasar siempre `index: 0` los trataría como el mismo elemento y solo se pulsaría uno de los dos, una regresión silenciosa sobre el comportamiento actual que probablemente rompería los tests de `attribute-siblings.html`:

```ts
      const promotedCountByAncestor = new Map<string, number>();

      function enqueueChildren(node: Screen, pathSoFar: PathStep[], depth: number): void {
        if (pathSoFar.length >= input.limits.maxViewDepth) return;
        const entryScreenId = node.reachedBy?.entryScreenId ?? node.id;

        // Misma lógica que la captura de arriba: qué copia es esta, de entre
        // los controles que comparten kind+accessibleName en esta pantalla.
        const twinIndex = new Map<string, number>();
        const seenNames = new Map<string, number>();
        for (const entry of node.locators) {
          const identity = `${entry.kind}|${entry.accessibleName ?? entry.name}`;
          const index = seenNames.get(identity) ?? 0;
          seenNames.set(identity, index + 1);
          twinIndex.set(entry.name, index);
        }

        for (const locator of node.locators.filter((l) => l.kind === "link" || l.kind === "button")) {
          if (node.writeActions.some((a) => a.locator === locator.name)) continue; // los submits los prueba runWritePass
          const key = elementKey({
            screenId: node.id,
            role: locator.kind,
            accessibleName: locator.accessibleName ?? locator.name,
            index: twinIndex.get(locator.name) ?? 0,
          });
          if (clickedElements.has(key)) continue;
          clickedElements.add(key);
          if (authenticated && LOGOUT_NAME.test(locator.accessibleName ?? "")) continue;
          queue.push({
            kind: "path",
            entryScreenId,
            path: [...pathSoFar, { action: "click", locator: locator.name, data: "none" }],
            depth: depth + 1,
          });
        }
      }
```

Nota de diseño: `enqueueChildren` sustituye, para el caso "sin camino previo" (una pantalla capturada normal, `pathSoFar = []`), al bucle de clics que hoy vive inline en `:1508-1660` — sustitúyelo por una llamada `enqueueChildren(screen, [], next.depth)` justo donde hoy empieza ese bucle (tras `screen.writeActions = await collectWriteActions(...)` y `screens.push(screen)`), y borra el cuerpo del bucle antiguo. Esto es lo que de verdad arregla el bug 2: antes, un botón revelado dentro de un estado JAMÁS entraba en la iteración (el `.filter()` se evaluaba una vez, antes de que el estado existiera); ahora, cualquier `enqueueChildren` posterior (desde la rama `path` de arriba) vuelve a mirar `node.locators` con los estados ya fundidos.

- [ ] **Step 5: Implementar — `replayPath`**

Nueva función, junto a `runWritePass`:

```ts
/**
 * Vuelve a un nodo sin URL propia reproduciendo la secuencia de acciones que
 * lo alcanzó, verificando la firma tras cada paso contra la que se registró
 * la primera vez que se recorrió ese mismo prefijo. Una discrepancia dice que
 * la aplicación no es determinista en ese punto — la rama se aborta en vez de
 * arriesgarse a construir el resto del mapa sobre un estado que no es el que
 * se cree que es.
 */
const knownPathSignatures = new Map<string, string>();

async function replayPath(
  page: Page,
  entryUrl: string,
  entry: Screen,
  path: { action: "click" | "submit"; locator: string; data: "valid" | "invalid" | "none" }[],
  credentials: CrawlCredentials | undefined,
  emit: EmitEvent
): Promise<{ ok: boolean }> {
  try {
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
  } catch {
    return { ok: false };
  }

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const locatorEntry = entry.locators.find((l) => l.name === step.locator);
    if (locatorEntry === undefined) return { ok: false };

    const role = locatorEntry.kind === "link" ? "link" : "button";
    const name = locatorEntry.accessibleName ?? "";
    const target = narrowedBy(page, scopedBy(page, locatorEntry).getByRole(role as never, { name, exact: true }), locatorEntry);

    if (step.action === "submit") {
      const action = entry.writeActions.find((a) => a.locator === step.locator);
      if (action === undefined) return { ok: false };
      for (const fieldName of action.formFields) {
        const field = entry.locators.find((l) => l.name === fieldName);
        if (field === undefined) continue;
        const fieldTarget = narrowedBy(page, scopedBy(page, field).getByRole("textbox", { name: field.accessibleName ?? "" }), field);
        await fieldTarget.fill(valueFor(field.accessibleName ?? "", step.data === "invalid" ? "invalid" : "valid", credentials)).catch(() => undefined);
      }
    }

    await target.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);

    const signature = await currentSignature(page, []);
    if (signature === null) return { ok: false };
    const prefixKey = `${entry.id}#${JSON.stringify(path.slice(0, i + 1))}`;
    const known = knownPathSignatures.get(prefixKey);
    if (known === undefined) {
      knownPathSignatures.set(prefixKey, signature);
    } else if (known !== signature) {
      emit({ agent: "explorador", status: "warn", depth: 1, message: `${prefixKey} produjo una firma distinta al reproducirlo: la aplicación no es determinista en ese punto` });
      return { ok: false };
    }
  }
  return { ok: true };
}
```

`valueFor` ya existe (`:886`); pásale `[]` como `secrets` en `currentSignature` aquí es deliberadamente laxo — la redacción de secretos ya ocurrió en la captura original que produjo `entry.locators`, y `replayPath` no llama a `captureScreen` (que sí redacta), solo compara firmas de una `ariaSnapshot` cruda. Si esto te preocupa en review, pásale los `secrets` reales (el llamador de `replayPath` en el Step 4 los tiene vía `input`) — ajusta la firma de la función para recibir `secrets: string[]` y pasarlos a `currentSignature`.

- [ ] **Step 6: Cablear `replayPath` en la rama `path` del Step 4**

Corrige la llamada del Step 4 para pasar `secrets`: `replayPath(page, entryUrl, entry, next.path, input.credentials, secrets, emit)` y añade el parámetro a la firma de la función.

- [ ] **Step 7: Verificar que el test de la Tarea pasa**

Run: `npx vitest run core/src/appMap/realCrawler.walk.test.ts -t "reveals a real form"`
Expected: PASS. Ajusta nombres de locator en el test si `captureScreen`/`naming.ts` los derivó distinto de lo asumido.

- [ ] **Step 8: Verificar que NADA existente se rompió**

Run: `npx vitest run core/src/appMap/realCrawler.walk.test.ts core/src/appMap/realCrawler.write.test.ts core/src/appMap/realCrawler.capture.test.ts`
Expected: PASS en el fichero completo — en particular los 3 tests de `state.html` (deben seguir viendo 1 pantalla, no 2) y todos los de navegación por URL normal (multipágina), que no deben cambiar de comportamiento en absoluto.

- [ ] **Step 9: `tsc` de core**

Run: `npx tsc -p core/tsconfig.json --noEmit`
Expected: limpio.

- [ ] **Step 10: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/realCrawler.walk.test.ts
git commit -m "feat(core): walk into SPA states and promote fillable-field views to screens

Fixes the walk's core blindness to in-place DOM changes: a state's own newly
revealed buttons were never clicked, because the click loop's locator list was
snapshotted once, before any state existed. The queue now carries either a
direct URL or a path of actions from an addressable ancestor, and every node —
promoted to a screen or merged as a state — re-enqueues its own new controls,
bounded by maxViewDepth."
```

---

### Task 11: Aprobación de escrituras incremental, por frontera (D4)

**Files:**
- Modify: `core/src/appMap/realCrawler.ts:1690-1696` (la llamada única a `approveWriteActions` al final del walk) — se mueve dentro del bucle principal, llamada una vez por cada tanda de `writeActions` nuevos que aparecen.
- Test: `core/src/appMap/realCrawler.walk.test.ts`

**Interfaces:**
- Consumes: `CrawlCallbacks.approveWriteActions` (sin cambios de firma, `crawler.ts:23`).
- Produces: el mismo comportamiento observable de aprobación, pero invocado en más de una ocasión durante un crawl con vistas anidadas.

- [ ] **Step 1: Test — se pregunta más de una vez cuando hay formularios en niveles distintos**

En `core/src/appMap/realCrawler.walk.test.ts`:

```ts
it("asks for write-action approval once per frontier, not once for the whole crawl", async () => {
  const approvalCalls: { screenId: string; action: { locator: string } }[][] = [];
  const result = await createRealCrawler().crawl({
    baseUrl: site.url.replace(/\/$/, "") + "/spa-nested.html", limits,
    credentials: { username: "user@example.test", password: "secret" },
    callbacks: {
      confirmContinueOnLoop: async () => false,
      approveWriteActions: async (pending) => {
        approvalCalls.push(pending);
        return pending.map((p) => ({ screenId: p.screenId, locator: p.action.locator }));
      },
    },
    emit: () => {},
  });
  if (!result.ok) throw new Error(result.error);
  expect(approvalCalls.length).toBeGreaterThan(1);
}, 20000);
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/realCrawler.walk.test.ts -t "once per frontier"`
Expected: FAIL — `approvalCalls.length` es `1` (o `0` si la promoción de la Tarea 10 encontró el formulario pero la aprobación sigue siendo la única llamada de después del `while`).

- [ ] **Step 3: Implementar**

En `realCrawler.ts`, sustituye el bloque único de `:1688-1696`:

```ts
        const pendingWriteActions = screens.flatMap((screen) =>
          screen.writeActions.map((action) => ({ screenId: screen.id, action }))
        );
        const approvedWriteActions = await input.callbacks.approveWriteActions(pendingWriteActions);
        const writeAuthenticated = await runWritePass(page, screens, approvedWriteActions, concreteUrls, input, emit);
        authenticated = authenticated || writeAuthenticated;
```

por una comprobación de frontera **dentro del `while (queue.length > 0)`**, justo antes de `const next = queue.shift()!;` — pregunta por lo nuevo cada vez que la cola está a punto de vaciarse en el nivel actual (es decir, cuando todo lo que queda en cola pertenece a una profundidad mayor que la del último nivel ya preguntado), o más simple y suficientemente correcto: pregunta cada vez que aparece un `writeActions` nuevo que nunca se ha ofrecido:

```ts
      const askedWriteActions = new Set<string>(); // `${screenId}|${locator}`

      async function approveNewWriteActions(): Promise<void> {
        const pending = screens.flatMap((screen) =>
          screen.writeActions
            .filter((action) => !askedWriteActions.has(`${screen.id}|${action.locator}`))
            .map((action) => ({ screenId: screen.id, action }))
        );
        if (pending.length === 0) return;
        for (const p of pending) askedWriteActions.add(`${p.screenId}|${p.action.locator}`);
        const approved = await input.callbacks.approveWriteActions(pending);
        const writeAuthenticated = await runWritePass(page, screens, approved, concreteUrls, input, emit);
        authenticated = authenticated || writeAuthenticated;
      }
```

Llama a `await approveNewWriteActions();` en dos sitios: (a) justo antes del `while (queue.length > 0) { const next = queue.shift()!; ... }` — no, más preciso: **al final de cada iteración del `while`**, justo antes de volver a comprobar la condición — así cada formulario nuevo descubierto en esa iteración (sea de una pantalla capturada por URL o de una vista/estado promocionados) se ofrece antes de seguir a la siguiente. Sustituye el cierre del `while` (la llave que hoy cierra directamente en `:1688` sin más código) por:

```ts
          await approveNewWriteActions();
        }
```

Y borra el bloque final único (ya no hace falta: la última vuelta del `while` ya lo cubrió). Si el `while` termina por `break` (límite de seguridad alcanzado), añade `await approveNewWriteActions();` también justo después del `while`, para no perder los formularios de la última iteración que rompió el bucle antes de llegar al final natural.

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run core/src/appMap/realCrawler.walk.test.ts`
Expected: PASS, incluido el test nuevo y todos los de aprobación de escritura existentes (revisa en particular los que comprueban que un formulario NO aprobado no se envía — deben seguir en verde sin cambios).

- [ ] **Step 5: `tsc` de core**

Run: `npx tsc -p core/tsconfig.json --noEmit`

- [ ] **Step 6: Commit**

```bash
git add core/src/appMap/realCrawler.ts core/src/appMap/realCrawler.walk.test.ts
git commit -m "feat(core): ask write-action approval once per frontier instead of once per crawl

Exploring a SPA in depth surfaces new forms mid-walk (a modal only reachable
after another form is approved and submitted) — a single end-of-walk approval
call could never have seen them."
```

---

### Task 12: `pageObjectEmitter` — `goto()` que reproduce un camino (D5, login)

**Files:**
- Modify: `core/src/appMap/pageObjectEmitter.ts` (toda la función `emitPageObject`, `:89-119`, y `pageObjectMethodNames`, `:77-82`)
- Test: `core/src/appMap/pageObjectEmitter.test.ts`

**Interfaces:**
- Consumes: `Screen.reachedBy` (Tarea 1), `hasPasswordField`/`looksLikeEmailField` (Tarea 4), necesita el `AppMap` completo (para resolver `entryScreenId` a su `Screen`) — cambia la firma de `emitPageObject`.
- Produces:
  ```ts
  export function emitPageObject(screen: Screen, map: AppMap): { path: string; content: string }
  export function pageObjectMethodNames(screen: Screen, map: AppMap): string[]
  ```
  Rompe a los dos llamadores existentes (`prompts/generador.ts:36`, y cualquier comando CLI que emita Page Objects — localízalo con `grep -rn "emitPageObject" cli/src core/src` antes de tocar la firma) — actualízalos para pasar el `map`.

- [ ] **Step 1: Test — `goto()` de una pantalla anidada tras login usa variables de entorno, sin parámetros**

En `core/src/appMap/pageObjectEmitter.test.ts`:

```ts
it("emits a goto() that replays a login-then-click path using env credentials, with no parameters", () => {
  const loginScreen: Screen = {
    id: "home", name: "home", className: "HomePage", urlTemplate: "/", signature: "s",
    requiresAuth: false, texts: [], probeValues: [],
    locators: [
      { name: "email_input", kind: "input", accessibleName: "Email", python: 'page.get_by_label("Email")', count: 1, verifiedAt: "2026-01-01" },
      { name: "password_input", kind: "input", accessibleName: "Password", python: 'page.get_by_label("Password")', count: 1, verifiedAt: "2026-01-01" },
      { name: "log_in_button", kind: "button", accessibleName: "Log in", python: 'page.get_by_role("button", name="Log in")', count: 1, verifiedAt: "2026-01-01" },
      { name: "crear_bebe_button", kind: "button", accessibleName: "Crear bebé", python: 'page.get_by_role("button", name="Crear bebé")', count: 1, verifiedAt: "2026-01-01", stateId: "path-log_in_button" },
    ],
    states: [], ambiguous: [], transitions: [],
    writeActions: [{ locator: "log_in_button", label: "Log in", kind: "submit", formFields: ["email_input", "password_input"] }],
  };
  const babyScreen: Screen = {
    id: "home~crear-bebe", name: "home~crear-bebe", className: "HomeCrearBebePage", urlTemplate: "/",
    signature: "s2", requiresAuth: true, texts: [], probeValues: [],
    locators: [{ name: "name_input", kind: "input", accessibleName: "Name", python: 'page.get_by_label("Name")', count: 1, verifiedAt: "2026-01-01" }],
    states: [], ambiguous: [], transitions: [], writeActions: [],
    reachedBy: {
      entryScreenId: "home",
      path: [
        { action: "submit", locator: "log_in_button", data: "valid" },
        { action: "click", locator: "crear_bebe_button", data: "none" },
      ],
    },
  };
  const map: AppMap = {
    schemaVersion: 2, appUrl: "https://example.test", createdAt: "2026-01-01", complete: true,
    authenticated: true, screens: [loginScreen, babyScreen], scenarios: [],
    stats: { screens: 2, locators: 5, ambiguous: 0, durationMs: 1 },
  };

  const { content } = emitPageObject(babyScreen, map);
  expect(content).toContain("def goto(self) -> None:");
  expect(content).toContain("entry = HomePage(self.page)");
  expect(content).toContain("entry.goto()");
  expect(content).toContain('entry.fill_email_input(os.environ["AGENTE_QA_TEST_USERNAME"])');
  expect(content).toContain('entry.fill_password_input(os.environ["AGENTE_QA_TEST_PASSWORD"])');
  expect(content).toContain("entry.click_log_in_button()");
  expect(content).toContain("entry.click_crear_bebe_button()");
  expect(content).not.toMatch(/def goto\(self, /); // sin parámetros
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/appMap/pageObjectEmitter.test.ts -t "replays a login-then-click"`
Expected: FAIL — `emitPageObject` no acepta un segundo argumento, y no genera ese `goto()`.

- [ ] **Step 3: Implementar**

En `core/src/appMap/pageObjectEmitter.ts`, añade a los imports:

```ts
import type { AppMap, LocatorEntry, Screen } from "./schema.js";
import { hasPasswordField, looksLikeEmailField } from "./credentialFields.js";
```

Nueva función, antes de `emitPageObject`:

```ts
/**
 * El cuerpo de `goto()` para una vista sin URL propia: instancia el Page
 * Object de la pantalla direccionable más cercana y reproduce, en orden, cada
 * paso del camino que la alcanzó. Un envío de login se rellena con las
 * variables de entorno de siempre y no añade parámetros a `goto()` — la
 * misma convención que ya usan los tests generados. Un envío que NO es login
 * no tiene ningún dato de qué escribir: sus campos se convierten en
 * parámetros de `goto()`, en el mismo orden que declara el formulario.
 */
function reachedByGoto(
  screen: Screen,
  map: AppMap
): { params: string[]; body: string } {
  const reachedBy = screen.reachedBy!;
  const entry = map.screens.find((s) => s.id === reachedBy.entryScreenId);
  if (!entry) throw new Error(`La pantalla de entrada "${reachedBy.entryScreenId}" no existe en el mapa.`);
  const entryModule = `${entry.id.replace(/-/g, "_").replace(/~/g, "_")}_page`;

  const lines: string[] = [`entry = ${entry.className}(self.page)`, "entry.goto()"];
  const params: string[] = [];

  for (const step of reachedBy.path) {
    if (step.action === "click") {
      lines.push(`entry.click_${step.locator}()`);
      continue;
    }
    const action = entry.writeActions.find((a) => a.locator === step.locator);
    if (!action) throw new Error(`El paso de envío "${step.locator}" no tiene un writeAction en "${entry.id}".`);
    const isLogin = hasPasswordField(entry, action);
    for (const fieldName of action.formFields) {
      const field = entry.locators.find((l) => l.name === fieldName);
      const isPassword = field?.accessibleName !== undefined && /password|contrasena|contraseña|clave/i.test(field.accessibleName);
      if (isLogin) {
        const envVar = isPassword ? "AGENTE_QA_TEST_PASSWORD" : "AGENTE_QA_TEST_USERNAME";
        lines.push(`entry.fill_${fieldName}(os.environ["${envVar}"])`);
      } else {
        params.push(fieldName);
        lines.push(`entry.fill_${fieldName}(${fieldName})`);
      }
    }
    lines.push(`entry.click_${step.locator}()`);
  }

  return {
    params,
    body: [`    from ${`pages.${entryModule}`} import ${entry.className}`, "", ...lines.map((l) => `    ${l}`)].join("\n"),
  };
}
```

Reescribe `emitPageObject`:

```ts
export function emitPageObject(screen: Screen, map: AppMap): { path: string; content: string } {
  const body = screen.locators.map(locatorMethods).join("\n\n");

  const templated = screen.urlTemplate.includes(":");
  let imports = "";
  let goto: string;

  if (screen.reachedBy) {
    const { params, body: gotoBody } = reachedByGoto(screen, map);
    const paramList = params.length > 0 ? `, ${params.map((p) => `${p}: str`).join(", ")}` : "";
    goto = `    def goto(self${paramList}) -> None:\n${gotoBody}`;
  } else if (templated) {
    goto = `    # Sin goto(): la ruta tiene segmentos variables (${screen.urlTemplate}).
    # Navega desde el test a la URL concreta que quieras probar.`;
  } else {
    imports = "import os\n\n";
    goto = `    def goto(self) -> None:
        base = os.environ["AGENTE_QA_APP_URL"].rstrip("/")
        self.page.goto(base + self.URL_TEMPLATE)`;
  }

  // Un goto() que reproduce un camino con un envío de login lee credenciales
  // de os.environ igual que el goto() de base — necesita el mismo import.
  if (screen.reachedBy && goto.includes("os.environ")) imports = "import os\n\n";

  const writesRealData = screen.reachedBy?.path.some((step) => step.action === "submit") ?? false;
  const writeWarning = writesRealData
    ? "# ATENCIÓN: goto() de esta pantalla envía un formulario real cada vez que se llama —\n# cada ejecución del test escribe datos nuevos en la aplicación bajo prueba.\n"
    : "";

  const content = `# GENERADO por agente-qa desde .agente-qa/map/map.json — NO EDITAR A MANO
# Las correcciones manuales van en .agente-qa/map/overrides.json
# Pantalla: ${screen.id}  ·  ruta: ${screen.urlTemplate}
${writeWarning}${imports}from playwright.sync_api import Locator, Page


class ${screen.className}:
    URL_TEMPLATE = ${pythonLiteral(screen.urlTemplate)}

    def __init__(self, page: Page):
        self.page = page

${goto}

${body}
`;
  return { path: `pages/${screen.id.replace(/-/g, "_").replace(/~/g, "_")}_page.py`, content };
}
```

Actualiza `pageObjectMethodNames` para reflejar la aridad de `goto` cuando lleva parámetros — el prompt del Generador (Tarea 13) lee esto:

```ts
export function pageObjectMethodNames(screen: Screen, map: AppMap): string[] {
  const templated = screen.urlTemplate.includes(":");
  let gotoMethod: string[] = [];
  if (screen.reachedBy) {
    const { params } = reachedByGoto(screen, map);
    gotoMethod = [params.length > 0 ? `goto(${params.map((p) => `${p}: str`).join(", ")})` : "goto"];
  } else if (!templated) {
    gotoMethod = ["goto"];
  }
  const locatorMethodNames = screen.locators.flatMap(pageObjectMethodNamesForLocator);
  return [...gotoMethod, ...locatorMethodNames];
}
```

- [ ] **Step 4: Actualizar los llamadores existentes**

Run: `grep -rn "emitPageObject\|pageObjectMethodNames(" core/src cli/src --include=*.ts | grep -v test`

Para cada resultado fuera de `pageObjectEmitter.ts` (previsiblemente `core/src/prompts/generador.ts:36` y algún comando de CLI que escribe `pages/*.py` a disco), añade el segundo argumento `map` en la llamada — el `map: AppMap` ya está disponible en cada uno de esos sitios (es la firma de entrada del comando/función que emite).

- [ ] **Step 5: Test — `goto()` con envío no-login lleva parámetros**

Añade a `pageObjectEmitter.test.ts`:

```ts
it("emits a goto() with a str parameter per field when the path's submit is not a login", () => {
  const listScreen: Screen = {
    id: "home", name: "home", className: "HomePage", urlTemplate: "/", signature: "s",
    requiresAuth: false, texts: [], probeValues: [],
    locators: [
      { name: "search_input", kind: "input", accessibleName: "Search", python: 'page.get_by_label("Search")', count: 1, verifiedAt: "2026-01-01" },
      { name: "search_button", kind: "button", accessibleName: "Search", python: 'page.get_by_role("button", name="Search")', count: 1, verifiedAt: "2026-01-01" },
    ],
    states: [], ambiguous: [], transitions: [],
    writeActions: [{ locator: "search_button", label: "Search", kind: "submit", formFields: ["search_input"] }],
  };
  const resultsScreen: Screen = {
    id: "home~search-results", name: "home~search-results", className: "HomeSearchResultsPage", urlTemplate: "/",
    signature: "s2", requiresAuth: false, texts: [], probeValues: [], locators: [],
    states: [], ambiguous: [], transitions: [], writeActions: [],
    reachedBy: { entryScreenId: "home", path: [{ action: "submit", locator: "search_button", data: "valid" }] },
  };
  const map: AppMap = {
    schemaVersion: 2, appUrl: "https://example.test", createdAt: "2026-01-01", complete: true,
    authenticated: false, screens: [listScreen, resultsScreen], scenarios: [],
    stats: { screens: 2, locators: 2, ambiguous: 0, durationMs: 1 },
  };

  const { content } = emitPageObject(resultsScreen, map);
  expect(content).toContain("def goto(self, search_input: str) -> None:");
  expect(content).toContain("entry.fill_search_input(search_input)");
  expect(content).not.toContain("os.environ");
});
```

- [ ] **Step 6: Verificar todo**

Run: `npx vitest run core/src/appMap/pageObjectEmitter.test.ts`
Expected: PASS en ambos tests nuevos y en todos los ya existentes del fichero (pantallas sin `reachedBy` deben emitir exactamente el mismo Python de siempre).

- [ ] **Step 7: `tsc` de ambos paquetes**

Run: `npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`

- [ ] **Step 8: Commit**

```bash
git add core/src/appMap/pageObjectEmitter.ts core/src/appMap/pageObjectEmitter.test.ts core/src/prompts/generador.ts
git commit -m "feat(core): emit goto() that replays a nested screen's reachedBy path"
```

---

### Task 13: El prompt del Generador describe un `goto()` parametrizado

**Files:**
- Modify: `core/src/prompts/generador.ts:78` (la regla "'goto' no reciben ningún argumento")
- Test: `core/src/prompts/generador.test.ts`

**Interfaces:**
- Consumes: `pageObjectMethodNames(screen, map)` (Tarea 12) — ya devuelve `"goto(search_input: str)"` en vez de `"goto"` cuando aplica; esta tarea solo corrige el texto fijo de la convención para que no contradiga esa lista.

- [ ] **Step 1: Test — el prompt no afirma que `goto` nunca lleva argumentos cuando la pantalla tiene uno parametrizado**

En `core/src/prompts/generador.test.ts`, localiza cómo el fichero ya construye un `AppMap`/`Screen` de prueba para `codeGenerationPrompt` y añade:

```ts
it("does not claim goto() takes no arguments when this screen's goto is parameterized", () => {
  const screen = { /* screen con reachedBy y un submit no-login, como en la Tarea 12 */ };
  const map = { /* map que incluye esa screen y su entryScreenId */ };
  const prompt = codeGenerationPrompt("Feature: x", map, screen.id, { slug: "x", featureFileName: "x.feature" });
  expect(prompt).toContain("goto(search_input: str)");
  expect(prompt).not.toMatch(/"goto" no reciben ningún argumento/);
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run core/src/prompts/generador.test.ts -t "does not claim goto"`
Expected: FAIL — la frase fija sigue ahí incondicionalmente.

- [ ] **Step 3: Implementar**

En `core/src/prompts/generador.ts:78`, la frase actual es parte de un párrafo fijo:

```
"fill_*" y "select_*" reciben un único argumento "value: str"; "click_*" y
"goto" no reciben ningún argumento.
```

Cámbiala para que remita a la lista de métodos en vez de afirmar una regla absoluta:

```ts
`Convención de cada método, según su prefijo: "get_*" devuelve un "Locator" y no actúa
sobre él; "fill_*" y "select_*" reciben un único argumento "value: str"; "click_*" no
recibe ningún argumento. "goto" normalmente tampoco, salvo que la lista de métodos de
más abajo lo muestre con parámetros entre paréntesis — en ese caso son "str", en el
mismo orden mostrado, y representan datos de un formulario que hace falta cruzar antes
de llegar a esta pantalla.`
```

Ajusta el texto exacto que rodea esa frase en el fichero (no está aislada en una constante; edítala en el lugar del template literal donde vive) manteniendo el resto del párrafo intacto.

- [ ] **Step 4: Corregir `moduleName` para un `screen.id` con `~`**

`codeGenerationPrompt` (`core/src/prompts/generador.ts:30`) deriva el nombre de módulo Python con:

```ts
const moduleName = `${screen.id.replace(/-/g, "_")}_page`;
```

Si la pantalla bajo prueba es ella misma una vista anidada (`screen.id === "home~crear-bebe"`), el `~` no se limpia y el `import` que el prompt le dicta al LLM (`from pages.home~crear-bebe_page import ...`, línea 65) sería Python inválido — la misma clase de fallo que la Tarea 3 ya corrigió en `screenIdentity` y la Tarea 12 en la ruta de fichero de `emitPageObject`. Corrige la línea:

```ts
const moduleName = `${screen.id.replace(/-/g, "_").replace(/~/g, "_")}_page`;
```

Añade un test en `core/src/prompts/generador.test.ts` junto al de arriba:

```ts
it("derives a valid Python module name for a nested screen id", () => {
  const screen = { ...baseNestedScreen, id: "home~crear-bebe" }; // reutiliza el fixture de la Tarea 12
  const map = { ...baseMap, screens: [homeScreen, screen] };
  const prompt = codeGenerationPrompt("Feature: x", map, screen.id, { slug: "x", featureFileName: "x.feature" });
  expect(prompt).toContain("from pages.home_crear_bebe_page import");
  expect(prompt).not.toContain("~");
});
```

- [ ] **Step 5: Verificar que pasa**

Run: `npx vitest run core/src/prompts/generador.test.ts`
Expected: PASS — incluidos los dos tests nuevos de este paso y del Step 1.

- [ ] **Step 6: `tsc` de core**

Run: `npx tsc -p core/tsconfig.json --noEmit`

- [ ] **Step 7: Commit**

```bash
git add core/src/prompts/generador.ts core/src/prompts/generador.test.ts
git commit -m "docs(core): teach the code-gen prompt that goto() can take form-field params"
```

---

### Task 14: Pregunta de configuración `maxViewDepth` en `agente-qa init`

**Files:**
- Modify: `cli/src/prompts/types.ts:3-10` (`InitPrompts`)
- Modify: `cli/src/prompts/inquirerPrompts.ts` (añade `inputMaxViewDepth`)
- Modify: `cli/src/commands/init.ts:25-36` (`runInit`)
- Test: `cli/src/commands/init.test.ts`

**Interfaces:**
- Produces: `InitPrompts.inputMaxViewDepth(): Promise<number>`, consumida por `runInit`, que pasa `crawl: { maxViewDepth }` a `saveProjectConfig` (el resto de `crawl` se completa con los defaults de `ProjectConfigSchema`, vía `z.input`).

- [ ] **Step 1: Test — `runInit` guarda el `maxViewDepth` respondido**

En `cli/src/commands/init.test.ts`, añade `inputMaxViewDepth: async () => 4` al helper `prompts(...)`, y un test:

```ts
it("saves the answered maxViewDepth into crawl config", async () => {
  await runInit(prompts({ inputMaxViewDepth: async () => 2 }), tmpProject);
  const config = await loadProjectConfig(tmpProject);
  expect(config!.crawl.maxViewDepth).toBe(2);
});
```

Actualiza también el test "saves the project config from the prompt answers" para que su `crawl` esperado incluya `maxViewDepth: 4` (el valor por defecto que da el helper `prompts()`).

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: FAIL — `InitPrompts` no tiene `inputMaxViewDepth`, `runInit` no la llama.

- [ ] **Step 3: Implementar — tipo**

En `cli/src/prompts/types.ts`, añade a `InitPrompts`:

```ts
  inputMaxViewDepth(): Promise<number>;
```

- [ ] **Step 4: Implementar — `runInit`**

En `cli/src/commands/init.ts:25-36`:

```ts
export async function runInit(prompts: InitPrompts, projectRoot: string): Promise<InitResult> {
  const testsDir = await prompts.inputTestsDir();
  const headedMode = await prompts.confirmHeadedMode();
  const appUrl = await prompts.inputAppUrl();
  const appLanguage = await prompts.selectAppLanguage();
  const homeRoute = await prompts.inputRoute("página principal (home)");
  const loginRoute = await prompts.inputRoute("login");
  const extraRoutes = await prompts.promptAdditionalRoutes();
  const maxViewDepth = await prompts.inputMaxViewDepth();
  const routes: Record<string, string> = { home: homeRoute, ...(loginRoute ? { login: loginRoute } : {}), ...extraRoutes };
  await saveProjectConfig(projectRoot, { testsDir, headedMode, appUrl, appLanguage, routes, crawl: { maxViewDepth } });
```

- [ ] **Step 5: Implementar — prompt real (inquirer)**

En `cli/src/prompts/inquirerPrompts.ts`, junto a `inputRoute`/`promptAdditionalRoutes`:

```ts
  async inputMaxViewDepth() {
    return input({
      message: "¿Cuántos niveles de vistas dentro de una misma pantalla (modales, pasos sin URL propia) explora el mapa?",
      default: "4",
      validate: (value) => (/^\d+$/.test(value) && Number(value) >= 0 ? true : "Introduce un número entero, 0 o mayor."),
    }).then(Number);
  },
```

- [ ] **Step 6: Verificar que pasa**

Run: `npx vitest run cli/src/commands/init.test.ts`
Expected: PASS

- [ ] **Step 7: `tsc` de cli**

Run: `npx tsc -p cli/tsconfig.json --noEmit`
Expected: limpio — revisa si `cli/src/menu.ts` o algún otro consumidor de `InitPrompts` necesita el nuevo campo en algún mock/stub de test.

- [ ] **Step 8: Commit**

```bash
git add cli/src/prompts/types.ts cli/src/prompts/inquirerPrompts.ts cli/src/commands/init.ts cli/src/commands/init.test.ts
git commit -m "feat(cli): ask maxViewDepth during init, default 4"
```

---

### Task 15: Verificación final del plan completo

**Files:** ninguno — solo comandos.

- [ ] **Step 1: Suite completa**

Run: `npx vitest run`
Expected: PASS en todo el repo, incluidos los tests que dependen de un Chromium real (`describe.skipIf(!chromium.executablePath())`) si el entorno lo tiene disponible.

- [ ] **Step 2: `tsc` de ambos paquetes**

Run: `npx tsc -p core/tsconfig.json --noEmit && npx tsc -p cli/tsconfig.json --noEmit`
Expected: limpio.

- [ ] **Step 3: Re-mapear BabIA manualmente (verificación fuera del repo, no automatizada)**

Si tienes acceso al proyecto `QA_Testing` usado durante el diseño: borra `.agente-qa/map/map.json` (schemaVersion 1, ya incompatible) y corre `agente-qa map` de nuevo. Confirma a mano que el mapa resultante trae `authenticated: true` y al menos una pantalla con `reachedBy` correspondiente al formulario de "Crear bebé". No es parte del suite automatizado — es la confirmación de que el bug original que abrió este plan queda cerrado.

- [ ] **Step 4: Reportar**

No hay commit en este paso — es la verificación de cierre del plan completo, con la salida de los Steps 1 y 2 como evidencia.
