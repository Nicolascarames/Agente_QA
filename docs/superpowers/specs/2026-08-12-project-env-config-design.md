# Configuración de proyecto vía `.env` — diseño

Fecha: 2026-08-12

## Problema

`agente-qa init` hoy pregunta proveedor/API key/URL base/modelo del LLM por
`inquirer` (guardados en `~/.agente-qa/credentials.json`, global, fuera del
repo) y `testsDir` (guardado en `<projectRoot>/.agente-qa/config.json`, en el
repo). No existe ningún concepto de "URL de la aplicación bajo test" ni de
"usuario/contraseña de prueba para login": el Agente 2 (generador de código)
inventa estos valores al generar los tests, típicamente cayendo en
`localhost`. Además, pedir la API key por un prompt interactivo de terminal
es una experiencia pobre para un secreto.

## Diseño

### Ubicación y protección

- Nuevo archivo `<projectRoot>/.agente-qa/.env`, junto al `config.json` ya
  existente ahí (que sigue guardando `testsDir`, sin cambios).
- Nuevo archivo `<projectRoot>/.agente-qa/.gitignore` con una sola línea:
  `.env`. No se toca el `.gitignore` raíz del usuario.
- El `.env` se crea con permisos `0600` (mismo criterio que hoy aplica
  `credentials.json`), por contener secretos.
- `init` **nunca sobrescribe** un `.env` ya existente — solo lo crea si
  falta, y en ese caso avisa al usuario de la ruta y de que debe rellenarlo
  a mano antes de usar el resto de comandos.
- `init` **no pregunta ningún valor de estos por chat** (ni siquiera la
  URL): solo escribe la plantilla vacía comentada. Todo el rellenado es
  manual, por diseño — evita que un secreto pase por un prompt de terminal.

### Variables y plantilla

Plantilla exacta que escribe `init` (valores vacíos, comentarios con
ejemplo de formato):

```
# .env de agente-qa para este proyecto.
# Este archivo NUNCA se sube a git (ver .agente-qa/.gitignore) — puedes guardar aquí
# datos sensibles (API keys, contraseñas de test) con tranquilidad.
# Rellena los valores que necesites y guarda el archivo. Las líneas que empiezan
# por "#" son solo explicación, no hace falta tocarlas.

# ── Aplicación bajo test ──────────────────────────────────────────────
# URL base de la app que vas a probar. Obligatoria para generar y ejecutar tests.
# Ejemplo: AGENTE_QA_APP_URL=https://staging.mi-app.com
AGENTE_QA_APP_URL=

# Usuario y contraseña de una cuenta de prueba, solo si vas a probar flujos de
# login. Opcional: si los dejas vacíos, no podrás generar/ejecutar escenarios
# que dependan de iniciar sesión.
# Ejemplo: AGENTE_QA_TEST_USERNAME=qa-tester@mi-app.com
AGENTE_QA_TEST_USERNAME=
# Ejemplo: AGENTE_QA_TEST_PASSWORD=Sup3rSecreta!
AGENTE_QA_TEST_PASSWORD=

# ── Proveedor LLM (genera y verifica los tests) ───────────────────────
# Uno de: anthropic | openai | google | openai-compatible
# Ejemplo: AGENTE_QA_LLM_PROVIDER=anthropic
AGENTE_QA_LLM_PROVIDER=

# Tu clave de API del proveedor elegido arriba. Obligatoria.
# Ejemplo: AGENTE_QA_LLM_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
AGENTE_QA_LLM_API_KEY=

# Solo si AGENTE_QA_LLM_PROVIDER=openai-compatible (Groq, Together, Ollama local...):
# Ejemplo: AGENTE_QA_LLM_BASE_URL=https://api.groq.com/openai/v1
AGENTE_QA_LLM_BASE_URL=
# Ejemplo: AGENTE_QA_LLM_MODEL=llama-3.3-70b-versatile
AGENTE_QA_LLM_MODEL=
```

Estas variables **sustituyen por completo** a `~/.agente-qa/credentials.json`
(proveedor, API key, baseURL, modelo), que deja de usarse. Corte limpio, sin
migración automática: es fase temprana, con pocos usuarios reales del
paquete publicado; si alguien tiene el `credentials.json` antiguo, se
ignora — tendrá que rellenar el `.env` nuevo del proyecto a mano.

### Validación por comando

El esquema de `ProjectEnv` es permisivo a nivel de parseo (campos
opcionales); cada comando exige solo lo que necesita, con un error en
castellano que nombra la variable exacta y la ruta del archivo:

- `chat` (crear plan) y `generate` (generar tests) llaman al LLM: exigen
  `AGENTE_QA_LLM_PROVIDER` + `AGENTE_QA_LLM_API_KEY` (y además
  `AGENTE_QA_LLM_BASE_URL` + `AGENTE_QA_LLM_MODEL` si el proveedor es
  `openai-compatible`, misma regla que tenía `CredentialsSchema` hoy).
- `run-tests` (Agente 3) exige `AGENTE_QA_APP_URL`.
  `AGENTE_QA_TEST_USERNAME`/`AGENTE_QA_TEST_PASSWORD` quedan opcionales a
  este nivel: si un escenario de login los necesita y están vacíos, el test
  Python generado falla con un `KeyError` que ya nombra la variable que
  falta — no se pre-valida esa combinación (evita complejidad innecesaria:
  no sabemos sin inspeccionar el código generado si un test concreto los
  usa).
- Si el archivo no existe en absoluto: error indicando que hay que ejecutar
  `agente-qa init` primero (igual que hoy con `config.json`).

### Módulos nuevos/tocados

- **`core/src/config/projectEnv.ts`** (nuevo, sustituye a
  `core/src/config/credentials.ts`, que se borra junto a su test):
  - `projectEnvPath(projectRoot)` → `<projectRoot>/.agente-qa/.env`.
  - `ensureProjectEnvTemplate(projectRoot): Promise<{ created: boolean; path: string }>`
    — crea `.env` + `.agente-qa/.gitignore` si faltan; nunca sobrescribe.
  - `loadProjectEnv(projectRoot): Promise<ProjectEnv | null>` — lee el
    archivo, parsea con `dotenv.parse()` (nueva dependencia, sin
    dependencias propias — usamos solo la función `parse`, nunca `config()`,
    para no mutar `process.env` global de forma implícita) y valida forma
    con Zod. `null` si el archivo no existe.
  - `requireLlmConfig(env, envPath)` / `requireAppUrl(env, envPath)` —
    helpers de validación con mensajes específicos, usados por los
    comandos que los necesitan.
  - `ProviderNameSchema`/`ProviderName` se mudan aquí desde
    `credentials.ts`.
- **`core/src/llm/factory.ts`**: `createProvider` importa el tipo de
  credenciales LLM desde `projectEnv.js` en vez de `credentials.js`.
- **`core/src/prompts/generador.ts`**: nueva instrucción en
  `codeGenerationPrompt` — la URL y las credenciales de test nunca se
  escriben literales en el código generado; siempre
  `os.environ["AGENTE_QA_APP_URL"]` /
  `os.environ["AGENTE_QA_TEST_USERNAME"]` /
  `os.environ["AGENTE_QA_TEST_PASSWORD"]`. Motivo también de seguridad:
  `tests/test_*.py` y `pages/*.py` se comitean al repo del usuario, así que
  ahí nunca puede aparecer un secreto en texto plano.
- **`core/src/testRun/testRunner.ts` + `realTestRunner.ts`**:
  `TestRunOptions` gana un campo `env?: Record<string, string>`; los
  `spawn()` internos pasan `{ ...process.env, ...runOptions.env }` en vez de
  heredar `process.env` sin más.
- **`core/src/agents/ejecutor/runEjecutor.ts`**: carga `loadProjectEnv`,
  valida `AGENTE_QA_APP_URL` con `requireAppUrl`, construye el `env` a pasar
  al runner con las 3 variables `AGENTE_QA_APP_URL` /
  `AGENTE_QA_TEST_USERNAME` / `AGENTE_QA_TEST_PASSWORD` (las que estén
  presentes).
- **CLI**:
  - `InitPrompts` pierde `selectProvider`/`inputApiKey`/`inputBaseURL`/
    `inputModel` — solo queda `inputTestsDir()`. Sus implementaciones en
    `inquirerPrompts.ts` se borran.
  - `runInit(prompts, projectRoot)` deja de recibir `homeDir`. Tras guardar
    `testsDir`, llama a `ensureProjectEnvTemplate` e informa por consola si
    el `.env` se acaba de crear (ruta + aviso de rellenarlo) o si ya
    existía.
  - `homeDir` desaparece en cascada de `runCreatePlan`, `runGenerateTests`,
    `MenuDeps` y `bin/agente-qa.ts` (deja de tener ningún consumidor tras
    este cambio).
- **`README.md`**: actualizar la sección de `init` para reflejar el nuevo
  flujo (ya no pregunta proveedor/API key/URL por chat; documentar la
  plantilla del `.env`).

## Fuera de alcance

- Migración automática desde `~/.agente-qa/credentials.json` — decisión
  explícita del usuario, corte limpio.
- Validar en `init`/`run-tests` que `AGENTE_QA_TEST_USERNAME`/
  `AGENTE_QA_TEST_PASSWORD` estén rellenos cuando el plan de pruebas
  incluye login — se deja fallar con el `KeyError` de Python.
- Mover `testsDir`/`config.json` al mismo mecanismo — no es secreto, sigue
  como está hoy (en el repo, trackeado en git).
