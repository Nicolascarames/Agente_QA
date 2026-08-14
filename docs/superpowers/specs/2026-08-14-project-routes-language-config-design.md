# Configuración de rutas + idioma de la app bajo test — diseño

Fecha: 2026-08-14

## Problema

Hoy la única forma de decirle al motor dónde está la app bajo test es
`AGENTE_QA_APP_URL` en `.env` — sin idioma ni rutas conocidas de por medio.
Agente 1 (intake) escribe los mensajes/textos esperados de los escenarios sin
saber en qué idioma está la interfaz real; por defecto tiende a castellano
(mismo idioma de sus propios prompts), aunque la app esté en otro idioma.
Esto produjo un fallo real: `Pruebas/` (carpeta de pruebas manuales del propio
repo) genera tests en castellano contra `babia-nav.vercel.app`, cuya interfaz
está en inglés — 6 de 7 escenarios de login fallan porque el texto esperado
("Correo o contraseña incorrectos") no existe en la página (el texto real es
"Authentication failed. Please try again.").

Por otro lado, el Site Explorer (Agente 2) ya prueba rutas candidatas por
patrón (`Pattern.navigationHints.routeCandidates`, hardcoded en cada patrón
built-in: `/login`, `/signin`, etc.) pero no hay forma de que el usuario le
diga la ruta real de su propia app para acelerar/acertar ese paso, ni de
decirle a Agente 2 dónde está la página principal tras completar un flujo —
hoy el código generado asume la raíz de `appUrl` por defecto
(`app_url.rstrip('/') + '/'`), sin ninguna pista del proyecto.

## Diseño

### Ubicación

- `appUrl` se muda de `.env` (secreto) a `config.json` (no secreto, va a
  git) — corte limpio, mismo criterio que la spec de 2026-08-12 (fase
  temprana, pocos usuarios reales del paquete publicado, sin migración
  automática).
- `appLanguage` (`"es" | "en"`, default `"es"`) y `routes` (mapa
  nombre→ruta) son campos nuevos, también en `config.json`.
- `AGENTE_QA_TEST_USERNAME`/`AGENTE_QA_TEST_PASSWORD` **no se tocan**: siguen
  siendo secretos en `.env`, sin cambios.

### Schema (`core/src/config/projectConfig.ts`)

```ts
export const ProjectConfigSchema = z.object({
  testsDir: z.string().min(1),
  headedMode: z.boolean().default(false),
  appUrl: z.string().url(),
  appLanguage: z.enum(["es", "en"]).default("es"),
  routes: z.record(z.string()).default({}),
});
```

`routes` es un mapa libre nombre→ruta relativa (ej. `{ home: "/",
login: "/login", checkout: "/carrito" }`). Las claves `home`/`login` se
preguntan siempre en `init`/`config`; cualquier otra clave (incluidos los
nombres de los demás patrones built-in — `signup`, `logout`,
`password-reset` — o nombres libres) se añade solo si el usuario la agrega
explícitamente en el bucle de "rutas extra".

### `.env`: se quita `AGENTE_QA_APP_URL`

- `core/src/config/projectEnv.ts`: `ProjectEnvSchema` pierde `appUrl`;
  `ENV_VAR_KEYS` pierde la entrada `appUrl`; `ENV_TEMPLATE` quita el bloque
  "URL base de la app" (la sección "Aplicación bajo test" queda solo con
  usuario/contraseña de test).
- `requireAppUrl` y `testEnvVars` se mudan de `projectEnv.ts` a
  `projectConfig.ts` y pasan a operar sobre `ProjectConfig` en vez de
  `ProjectEnv`:
  - `requireAppUrl(config: ProjectConfig): string` — ya no puede fallar en la
    práctica (`appUrl` es obligatorio en el schema desde `loadProjectConfig`),
    pero se conserva como punto único de lectura por claridad y para no
    romper la firma que ya usan `generate.ts`/`execute.ts`.
  - `testEnvVars(config: ProjectConfig, env: ProjectEnv): Record<string,
    string>` — gana el parámetro `config`; sigue construyendo el mismo
    `Record` con `AGENTE_QA_APP_URL` (ahora desde `config.appUrl`) +
    `AGENTE_QA_TEST_USERNAME`/`AGENTE_QA_TEST_PASSWORD` (desde `env`, sin
    cambios) para inyectar como variables de entorno reales al subproceso
    `pytest` — el código Python generado sigue leyendo `os.environ` tal cual,
    no se toca nada de esa parte.

### Flujo `init`/`config` (`cli/src/commands/init.ts`, `runInit`)

Tras `headedMode`, prompts nuevos en este orden:

1. `inputAppUrl()` — URL obligatoria, valida formato (rechaza si no es una
   URL válida, reintenta).
2. `selectAppLanguage()` — `"es" | "en"`, default `"es"`.
3. `inputRoute("página principal (home)")` — default `"/"`.
4. `inputRoute("login")` — puede dejarse vacío; si está vacío, no se guarda
   esa clave (el Site Explorer sigue teniendo su vía agéntica de respaldo).
5. `promptAdditionalRoutes()` — bucle: confirm "¿añadir otra ruta?" → si sí,
   input nombre + input path, repite; si no, termina. Devuelve
   `Record<string, string>` con las rutas extra.

`InitPrompts` (`cli/src/prompts/types.ts`) gana:

```ts
inputAppUrl(): Promise<string>;
selectAppLanguage(): Promise<"es" | "en">;
inputRoute(label: string): Promise<string>;
promptAdditionalRoutes(): Promise<Record<string, string>>;
```

`routes` final = `{ home, ...(login ? { login } : {}), ...extra }`.
`runInit` llama `saveProjectConfig(projectRoot, { testsDir, headedMode,
appUrl, appLanguage, routes })`.

Nota: sigue sin haber ningún LLM de por medio en `init`/`config` — decisión
ya tomada en el chat, estos son prompts `inquirer` normales, igual que
`testsDir`/`headedMode` hoy. `config` sigue siendo el mismo comando que
`init` (`runInit`), reusado tal cual — sin comando nuevo.

### Consumo — `appUrl`

- `cli/src/commands/generate.ts` y `execute.ts`: dejan de llamar a
  `requireAppUrl(env, projectEnvPath(...))` — usan
  `requireAppUrl(projectConfig)` (o directamente `projectConfig.appUrl`, ya
  validado por el schema).
- `execute.ts` pasa `testEnvVars(projectConfig, env)` en vez de
  `testEnvVars(env)`.
- `chat.ts` no usa `appUrl` hoy, no cambia.

### Consumo — `appLanguage`

- `gherkinGenerationPrompt(text, matchedPattern, appLanguage)` y
  `codeGenerationPrompt(featureText, matchedPattern, naming, evidence,
  appLanguage, retry?)` ganan un parámetro nuevo. Instrucción añadida
  (mapeando `"es"→"español"`, `"en"→"inglés"`):

  > "La interfaz real de la aplicación bajo test está en {idioma}. Los
  > textos visibles que menciones o esperes (botones, mensajes, etiquetas,
  > validaciones) deben asumirse en ese idioma — no los traduzcas al
  > castellano aunque el resto de esta conversación esté en castellano."

- `generateGherkin`/`runIntake` (Agente 1) y `generateCode`/`runGenerador`
  (Agente 2) reciben `appLanguage: "es" | "en"` como parámetro nuevo y lo
  bajan al prompt correspondiente.
- `runCreatePlan` (`chat.ts`) y `runGenerateTests` (`generate.ts`) leen
  `projectConfig.appLanguage` y lo pasan hacia abajo.

### Consumo — `routes`

- **Rutas por patrón** (`routes[patternName]`, ej. `routes.login` cuando
  `matchedPattern.name === "login"`): en `runGenerador`, antes de llamar a
  `explorer.explore(...)`, si `config.routes[matchedPattern.name]` existe se
  antepone a `matchedPattern.navigationHints.routeCandidates` — se construye
  una copia local del patrón con `navigationHints` modificado, sin mutar el
  `Pattern` original importado desde `core/src/patterns/builtin/`.
  `exploreByHints` ya prueba candidatos en orden y para en el primero que
  funciona, así que anteponer es suficiente — no hace falta tocar
  `realSiteExplorer.ts`.
- **`routes.home`**: nuevo hecho explícito en `codeGenerationPrompt`, en una
  sección aparte que solo aparece si `routes.home` está definida:

  > "La página principal de la aplicación (tras completar flujos como
  > login) está en la ruta {home}; si el escenario verifica una redirección
  > a la página principal, usa esa ruta en vez de asumir la raíz de la URL
  > base."

- `runGenerador` gana dos parámetros nuevos: `appLanguage: "es" | "en"`,
  `routes: Record<string, string>`. `generate.ts` los pasa desde
  `projectConfig.appLanguage`/`projectConfig.routes`.

### Módulos nuevos/tocados

- `core/src/config/projectConfig.ts` — schema + `requireAppUrl` +
  `testEnvVars` (movidos desde `projectEnv.ts`).
- `core/src/config/projectEnv.ts` — pierde `appUrl`/`requireAppUrl`/
  `testEnvVars`, plantilla `.env` actualizada.
- `core/src/prompts/intake.ts` — `gherkinGenerationPrompt` gana
  `appLanguage`.
- `core/src/prompts/generador.ts` — `codeGenerationPrompt` gana
  `appLanguage` + sección opcional de `routes.home`.
- `core/src/agents/intake/gherkinGenerator.ts` (`generateGherkin`) y
  `runIntake.ts` — nuevo parámetro `appLanguage`.
- `core/src/agents/generador/codeGenerator.ts` (`generateCode`) y
  `runGenerador.ts` — nuevos parámetros `appLanguage`, `routes`.
- `cli/src/prompts/types.ts` — `InitPrompts` gana los 4 métodos nuevos.
- `cli/src/prompts/inquirerPrompts.ts` — implementación real de esos 4
  métodos en `realInitPrompts`.
- `cli/src/commands/init.ts` — `runInit` orquesta los prompts nuevos y
  guarda el `config.json` extendido.
- `cli/src/commands/generate.ts`, `execute.ts`, `chat.ts` — leen los campos
  nuevos de `projectConfig` y los pasan a `runGenerador`/`runIntake`.
- `README.md` — actualizar la sección de `init`/`config` (URL, idioma y
  rutas ya no van en `.env`, van en `config.json` vía prompts).

## Testing

- `projectConfig.test.ts`: schema acepta `appUrl`/`appLanguage`/`routes`,
  default `appLanguage="es"`, default `routes={}`, rechaza `appUrl` no-URL;
  `requireAppUrl`/`testEnvVars` movidos aquí con su nueva firma.
- `projectEnv.test.ts`: se quitan los tests de `appUrl`/`requireAppUrl`/
  `testEnvVars` (migran al archivo de arriba).
- `init.test.ts`: los prompts nuevos se llaman en el orden correcto: el
  `config.json` final incluye los 3 campos nuevos con los valores
  devueltos por los prompts.
- `gherkinGenerator.test.ts`: el prompt incluye la frase de idioma cuando
  `appLanguage="en"`.
- `codeGenerator.test.ts`: el prompt incluye la frase de idioma; incluye la
  sección de `routes.home` solo cuando está definida, ausente si no.
- `runGenerador.test.ts`: `config.routes[patternName]` se antepone a
  `routeCandidates` antes de llamar a `explorer.explore` (mock del
  explorer, comprobar el argumento recibido).

## Migración

Corte limpio: quien actualice a esta versión y no vuelva a ejecutar
`init`/`Configuración` verá `loadProjectConfig` fallar con un error de Zod
("appUrl Required") al intentar generar o ejecutar tests — mensaje ya
existente de "faltan campos", sin código de migración especial. No se lee
`AGENTE_QA_APP_URL` de `.env` como fallback en ningún caso.

## Fuera de alcance

- Verificar el texto exacto de la interfaz contra la app real durante
  Agente 1 (Site Explorer solo actúa en Agente 2 hoy) — `appLanguage` solo
  orienta el idioma de la conjetura del LLM, no garantiza que el texto
  literal coincida con la copia real de la app. Posible spec futura,
  separada.
- Interview conversacional con LLM durante `init`/`config` — se mantienen
  prompts fijos `inquirer`, igual que el resto del comando hoy.
- Preguntar por defecto las rutas de los otros 3 patrones built-in
  (`signup`, `logout`, `password-reset`) — solo se preguntan siempre
  `home`/`login`; el resto se añade a mano vía "rutas extra" si el
  proyecto las necesita.
- Locators auto-reparables cuando un test falla por un locator roto — tema
  totalmente aparte, con su propio brainstorming pendiente.
