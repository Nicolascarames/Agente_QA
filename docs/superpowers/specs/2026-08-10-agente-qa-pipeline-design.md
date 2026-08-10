# Agente_QA — Diseño del sistema agéntico de QA (v1)

Fecha: 2026-08-10
Estado: Aprobado para pasar a plan de implementación

## 1. Objetivo

Sistema agéntico que automatiza el ciclo completo de QA: desde una descripción en lenguaje natural de qué hay que probar, hasta un reporte de ejecución. Cuatro agentes especializados, con lógica compartida, distribuibles de dos formas distintas (plugin de Claude Code y CLI npm standalone) para que "cualquier persona" pueda instalarlo sin depender de una plataforma concreta.

### No objetivos de v1 (explícitamente fuera de alcance)

- Intake desde GitHub Issues o Jira (solo texto plano/`.txt` en v1; queda como adaptador futuro).
- Adaptadores de suscripción para proveedores distintos de Claude (Copilot, Codex, Gemini...). Solo se investigó y confirmó viable el de Claude.
- Librería de patrones compartida entre instalaciones/proyectos (requeriría backend + revisión humana de contenido autogenerado). El aprendizaje de patrones en v1 es local al repo de cada proyecto.
- Estructuras de test alternativas a Page Object Model (queda fijada como única convención en v1).

## 2. Por qué dos formas de instalación (y por qué no se puede evitar)

Investigación confirmada (ver fuentes citadas en la conversación de diseño): ningún proveedor de LLM permite reutilizar los tokens de una suscripción de chat (Claude Pro/Max, etc.) desde una aplicación externa vía SDK/API — política de Anthropic actualizada el 19 de febrero de 2026 lo prohíbe explícitamente para el Agent SDK, y es la norma general del sector, no una particularidad de Claude.

Consecuencia de diseño: para poder ofrecer *ambas* cosas — libertad multi-LLM, y aprovechar una suscripción Claude ya pagada sin coste extra de API — el sistema necesita dos superficies de entrada distintas sobre el mismo motor:

- **CLI standalone (npm)**: siempre vía API key propia (Anthropic, OpenAI o Google). Portable, corre en cualquier terminal o pipeline de CI, sin depender de Claude Code.
- **Plugin de Claude Code**: corre dentro de una sesión Claude Code real, usa la suscripción ya activa (Pro/Max/Team/Enterprise) sin configuración de key. Limitado a modelos Claude.

## 3. Estructura del repositorio

Un solo repositorio (monorepo). Separar en dos repos obligaría a publicar y versionar el motor compartido como dependencia externa consumida por ambas superficies, sin beneficio real en esta etapa.

```
Agente_QA/
  core/                     # motor compartido, sin dependencia de CLI ni de Claude Code
    prompts/                # prompts de los 4 agentes
    schemas/                # contratos de datos entre agentes (ver sección 5)
    generators/             # generación de .feature y de tests Playwright/POM
    patterns/               # librería de patrones incorporada (ver sección 6)
  cli/                      # entry point npm standalone
    bin/
    src/
    package.json
  plugin/                   # entry point Claude Code Plugin
    plugin.json
    agents/                 # 4 subagents (uno por agente del pipeline)
    skills/                 # skill que orquesta la conversación y el menú
    commands/                # slash commands de entrada
  docs/
    superpowers/specs/      # specs de diseño (este documento y los siguientes)
  README.md
```

Nombres definitivos de paquete npm (`agente-qa` es el nombre de trabajo, pendiente de comprobar disponibilidad en el registro) y del identificador del plugin en marketplace se resuelven durante la implementación, no bloquean el diseño.

## 4. Autenticación y configuración

| | CLI (npm) | Plugin (Claude Code) |
|---|---|---|
| Auth | API key propia, proveedor a elegir (Anthropic / OpenAI / Google) | Automática, sesión Claude Code ya logueada |
| Dónde vive la key | `~/.agente-qa/credentials.json` (global, fuera de cualquier repo, nunca se commitea) | N/A |
| Preferencias de proyecto | `<proyecto>/.agente-qa/config.json` (estructura, capturas por defecto — sin secretos, sí commiteable) | Igual, mismo archivo y formato |

Separar credenciales (globales, secretas) de preferencias de proyecto (locales, compartibles en equipo) evita que una API key acabe commiteada por error y evita pedir la key en cada proyecto nuevo.

## 5. Pipeline de 4 agentes

Cada agente tiene una entrada y salida bien definidas; el siguiente agente no arranca sin que la salida del anterior esté aprobada donde así se especifica.

### Agente 1 — Intake (texto → plan Gherkin)

- **Entrada**: texto pegado en conversación, o ruta a un `.txt`/`.md`.
- **Comportamiento**: si el texto es ambiguo o incompleto, pregunta antes de asumir (no genera un plan sobre una interpretación adivinada). Antes de generar desde cero, comprueba si la petición encaja con algún patrón conocido (ver sección 6) — incorporado o aprendido en ese proyecto — y si encaja, lo ofrece como punto de partida pidiendo solo los datos específicos del proyecto (URL, selectores, campos, credenciales de prueba).
- **Salida**: uno o más ficheros `.feature` en Gherkin estándar (Given/When/Then, tags `@smoke`/`@regression`/etc. según corresponda).
- **Checkpoint**: el usuario debe aprobar explícitamente el `.feature` (o pedir cambios) antes de que el Agente 2 arranque.

### Agente 2 — Generador (Gherkin aprobado → tests Playwright)

- **Entrada**: `.feature` aprobado por el Agente 1.
- **Convención fija**: Page Object Model — `tests/` (specs pytest-bdd/pytest-playwright), `pages/` (una clase por pantalla), `conftest.py` (fixtures).
- **Comportamiento**: si el Agente 1 identificó un patrón, reutiliza también el esqueleto de Page Object correspondiente. Autochequeo antes de presentar resultado: el código generado debe compilar/lintar limpio (si no, el agente lo corrige antes de mostrarlo).
- **Salida**: ficheros Python (`tests/*.py`, `pages/*.py`) en la estructura acordada en `config.json` del proyecto.
- Tras generar con éxito, si el caso no encajaba en un patrón existente, el agente **pregunta** si se guarda como patrón nuevo reusable para ese proyecto (ver sección 6) — nunca se guarda en silencio.

### Agente 3 — Ejecutor (selecciona y lanza)

- **Entrada**: conjunto de tests disponibles en el proyecto.
- **Selección**: por tags Gherkin (el agente lista los tags detectados en los `.feature` del proyecto y el usuario marca cuáles lanzar; seleccionar todos los tags equivale a "lanzar todo").
- **Capturas/vídeo**: se pregunta en cada ejecución (sugerencia por defecto: solo en fallo — `retain-on-failure` nativo de Playwright — pero la decisión es del usuario en cada lanzamiento, no queda fija en config).
- **Salida**: resultados de ejecución (formato `junit-xml` de pytest) que alimentan al Agente 4.

### Agente 4 — Reportes

- **Entrada**: resultados de la ejecución del Agente 3.
- **Reporte extendido**: generado con `pytest-html` — un único `.html` autocontenido, embebe capturas/vídeo por test, sin dependencias externas al ecosistema pip (a diferencia de Allure, que exigiría instalar un commandline aparte, fricción no deseable para "cualquier persona" instalando el sistema).
- **Reporte resumen**: generado por el propio agente (Markdown), con conteo pass/fail, duración total y listado de fallos principales.

## 6. Librería de patrones reusables

Objetivo: no partir de cero en casos que se repiten en casi cualquier proyecto (login es el caso universal), e ir creciendo con el uso sin necesidad de curar todo de antemano.

### Dos niveles

- **Incorporada** (`core/patterns/`, viene con el sistema): set inicial v1 = login, logout, registro/signup, recuperación de contraseña. Cada patrón es una pareja Gherkin (parametrizado, sin datos concretos de ningún proyecto) + esqueleto de Page Object correspondiente.
- **Aprendida por proyecto** (`<proyecto>/.agente-qa/templates/`): cuando el Agente 1 recibe una petición que no encaja en ningún patrón conocido (ni incorporado ni ya aprendido en ese proyecto) y el Agente 2 la resuelve con éxito, el sistema pregunta si se guarda como patrón nuevo para ese proyecto. Si se acepta, queda disponible para la próxima iteración — y entra en el control de versiones del propio proyecto del usuario, como cualquier otro archivo generado.

### Explícitamente fuera de v1

Que los patrones aprendidos en un proyecto se compartan de vuelta a la librería incorporada (beneficiando a todas las instalaciones) requeriría un backend/registro central y revisión humana antes de aceptar contenido autogenerado en una librería pública — se descarta para v1, queda como idea futura.

## 7. Menú de apertura y flujo conversacional

Ambas superficies (CLI y plugin) comparten el mismo motor de conversación: siempre arrancan con una presentación y un menú, tanto en la primera instalación (`init`/onboarding) como en cada uso posterior.

Menú principal (tras onboarding):

```
Soy Agente_QA. ¿Qué quieres hacer?
 1. Crear plan de pruebas desde un texto
 2. Generar tests Playwright desde un plan aprobado
 3. Ejecutar tests
 4. Ver/generar reportes
 5. Configuración
 0. Salir
```

Acepta selección por número o por lenguaje natural — no es un parser rígido, es una conversación con un LLM detrás.

### Onboarding — CLI (`agente-qa init`)

1. Presentación y bienvenida.
2. Modo de auth: elegir proveedor (Anthropic/OpenAI/Google) y pegar API key → se guarda en `~/.agente-qa/credentials.json`.
3. Carpeta destino del proyecto de tests (por defecto, directorio actual).
4. Confirmación de convención fija (Page Object Model) y de herramienta de reporte (pytest-html) — informativo, no son preguntas abiertas en v1.
5. Guarda `<proyecto>/.agente-qa/config.json` y muestra el menú principal.

### Onboarding — Plugin (Claude Code)

1. Presentación (al invocar el skill por primera vez en un repo).
2. Carpeta destino del proyecto de tests dentro del repo actual.
3. Sin paso de auth (usa la sesión Claude Code ya iniciada).
4. Guarda `<proyecto>/.agente-qa/config.json` y muestra el menú principal.

## 8. Manejo de errores

- **Fallo de LLM/API** (rate limit, red, key inválida): mensaje claro, opción de reintentar, sin dejar archivos a medio escribir.
- **Playwright/navegadores no instalados**: aviso explícito apuntando a `playwright install`.
- **Fallos de test individuales**: no se tratan como error del sistema — es resultado normal de una ejecución de QA, va al reporte del Agente 4.
- **Código generado por el Agente 2 no compila/lint falla**: el propio agente lo corrige antes de presentar el resultado al usuario (no se expone código roto como si fuera el resultado final).

## 9. Validación durante la implementación

El pipeline completo se validará contra un sitio de prueba fijo (p. ej. una demo pública de Playwright o TodoMVC) como fixture de desarrollo. El detalle de estas pruebas se define en el plan de implementación (writing-plans), no en este documento de diseño.

## 10. Puntos abiertos para specs futuras

- Nombre definitivo del paquete npm y del identificador de plugin en marketplace.
- Adaptador de intake para GitHub Issues / Jira.
- Adaptadores de suscripción adicionales (Copilot, Codex, Gemini) — sujeto a investigar viabilidad y ToS de cada uno.
- Mecanismo, si algún día se decide construir, para compartir patrones aprendidos entre proyectos/instalaciones.
