# Anclaje del Gherkin en la app real y cierre del bucle de verificación

Fecha: 2026-08-15
Estado: aprobado, pendiente de plan de implementación

## 1. Problema

Los tests generados por el pipeline contra `https://babia-nav.vercel.app/` fallan 5 de 5.
El informe (`tests/results/latest.html`, 14-ago-2026) da tres síntomas distintos y, tras
investigarlos con `systematic-debugging`, tres causas raíz independientes.

### 1.1 Evidencia

Fallos 1 y 2 — literal esperado inexistente en la aplicación:

```
E  waiting for get_by_role("heading", name="Dream and Growth")
E  - heading "Sueño y crecimiento" [level=1]        <- lo que la app dice de verdad

E  waiting for get_by_text("Invalid email or password")
E  - text: Authentication failed. Please try again.  <- lo que la app dice de verdad
```

Fallos 3, 4 y 5 — el step no existe para valores vacíos:

```
E  pytest_bdd.exceptions.StepDefinitionNotFoundError: Step definition is not found:
   When "introduzco el correo electrónico "" y la contraseña "ValidPassword123""
```

### 1.2 Causa raíz A — `parsers.parse` no matchea la cadena vacía

`parse` compila `{x}` a `.+?`: mínimo un carácter. Cualquier `Scenario Outline` con una
celda vacía en `Examples` — el caso central de "validación de campos obligatorios" — no
encuentra step. Comprobado contra el intérprete real del proyecto consumidor:

```
parsers.parse(...).is_matching(<valor no vacío>)  -> True
parsers.parse(...).is_matching(<valor vacío>)     -> False
parsers.re(r'"(?P<email>[^"]*)"').is_matching(<valor vacío>) -> True
```

Es determinista y no depende del LLM. `ruff` y `py_compile` no pueden verlo: el código es
sintácticamente válido.

### 1.3 Causa raíz B — Agente 1 inventa los literales de la interfaz

`gherkinGenerationPrompt` recibe la petición del usuario, el patrón y `appLanguage`, y
ninguna evidencia de la aplicación real. El LLM rellena los huecos: `"Dream and Growth"`,
`"Invalid email or password"`, `"Email is required"`. Ninguno existe.

Agente 2 no puede corregirlo, y hace bien: su prompt le exige pasar el valor del step sin
transformar, porque la verificación de locators depende de poder seguir ese rastro. El
código generado es correcto; el `.feature` es el que miente.

`appLanguage` tampoco salva el caso: la app bajo test es bilingüe (login en inglés,
panel en español, con conmutador `en`/`es`). Un único valor global no puede acertar.

### 1.4 Causa raíz C — el bucle de verificación está abierto por diseño

- `runGenerador.ts` calcula `verificationUrl = evidence[0]?.url` y descarta el resto de
  pantallas capturadas. Con el patrón `login` (`requiresLogin: true`) el explorador captura
  dos: login y post-login. Verificamos el panel contra la pantalla de login.
- `count === 0` es aviso, nunca fallo (decisión correcta el 14-ago con la información de
  entonces: sin evidencia multipantalla no se podía distinguir "no existe" de "aparece más
  tarde"). Resultado: el sistema sabía que `"Dream and Growth"` daba 0 elementos, lo avisó
  y escribió el código igualmente.

### 1.5 Lección de proceso

Tres rondas de correcciones consecutivas trabajaron sobre `locatorVerify` — la capa
equivocada. La causa raíz estaba aguas arriba, en Agente 1, anotada como "fuera de alcance"
en la spec de rutas+idioma del 14-ago. No era una mejora opcional: era el bug.

## 2. Decisiones

| Decisión | Elección | Alternativas descartadas |
|---|---|---|
| Literales que solo existen tras una acción fallida | Sonda negativa declarada por patrón | Paso sin literal (aserción más débil); preguntar al usuario en cada intake |
| Cuándo explora Agente 1 | Siempre, con caché reutilizada por Agente 2 | Siempre sin caché (dos exploraciones por flujo); solo bajo confirmación (reabre el bug si el usuario dice que no) |
| Literal ausente de toda la evidencia | Error bloqueante con el texto real en el feedback de reintento | Bloquear solo si hubo exploración; aviso visible y escribir igual (comportamiento de hoy) |
| Forma del parser en los steps generados | `parsers.re` siempre para parámetros entrecomillados | `parsers.re` solo cuando el `.feature` tiene celdas vacías (regla condicional, más frágil) |
| `appLanguage` | Se mantiene para la redacción de los pasos; deja de ser fuente de verdad del texto esperado | Eliminarlo (rompe la configuración existente sin ganancia) |

## 3. Diseño

Cuatro fases independientes en orden de entrega. La Fase 0 no depende de ninguna otra y
desbloquea 3 de los 5 fallos por sí sola.

### 3.1 Fase 0 — `parsers.re` para valores entrecomillados

**Lint nuevo.** `core/src/codeCheck/stepParserLint.ts`, función pura
`checkStepParsers(files: GeneratedFile[]): string[]`, fusionada en `createRealCodeChecker`
igual que `checkLocatorPatterns`. Regla: un `@given`/`@when`/`@then` con
`parsers.parse(...)` donde un `{param}` esté pegado a comillas produce error, con el
reemplazo exacto en el mensaje:

```
tests/test_x.py:22 — parsers.parse no matchea valores vacíos ({param} exige >=1 carácter):
un Scenario Outline con una celda vacía en Examples dará StepDefinitionNotFoundError.
Usa: @when(parsers.re(r'introduzco el correo electrónico "(?P<email>[^"]*)"'))
```

El lint ignora las líneas cuyo texto recortado empieza por `#`. Esto no es opcional: al
nombrar `parsers.parse` en el prompt para advertir contra él, el modelo tiende a citarlo en
comentarios y el lint lo marcaría igual — el mismo fallo en agregado ya ocurrido con
`.or_()` el 14-ago.

**Prompt.** Regla equivalente en `codeGenerationPrompt`, con el ejemplo completo.

**Extractor de locators.** `STEP_DEF_PATTERN` en `extractLocatorChecks.ts` solo reconoce
`parsers.parse(...)` y literales planos, y `templateToRegex` solo traduce `{name}`. Migrar
a `parsers.re` sin enseñarle `(?P<name>...)` deja la verificación muda **en silencio**.
Se extrae un `parseStepTemplate(template, kind)` que cubre las tres formas — literal plano,
`parse` con `{name}`, `re` con `(?P<name>...)` — y devuelve `{ regex, paramNames }`.

### 3.2 Fase 1 — Agente 1 anclado en la aplicación real

**Sonda negativa.** `NavigationHintsSchema` gana `negativeProbe` opcional:

```ts
negativeProbe: z.object({ kind: z.literal("invalid-credentials") }).optional()
```

Declarada solo en el patrón incorporado `login`. Cuando está presente y hay credenciales,
`realSiteExplorer` intercala, entre la captura de la pantalla inicial y el login real: un
intento con la contraseña incorrecta (constante fija del módulo, nunca derivada de la real
ni registrada en ningún sitio), captura de la pantalla resultante como evidencia adicional
(`stepText: "tras un intento de inicio de sesión con credenciales incorrectas"`), y recarga
antes del login válido. **Un solo intento, nunca en bucle.** Riesgo asumido y documentado:
aplicaciones con bloqueo de cuenta tras N fallos — por eso se declara por patrón y no de
forma global. La redacción de credenciales ya está centralizada en `captureEvidence`, así
que la evidencia de la sonda la hereda sin cambios.

**Exploración en el intake.** `runIntake` pasa de 7 parámetros posicionales a un objeto
`RunIntakeOptions` (mismo movimiento que `RunGeneradorOptions` el 14-ago) y gana
`explorer: SiteExplorer`, `baseUrl`, `credentials` y `routes`. Explora tras resolver el
patrón y antes de generar el Gherkin. `IntakeCallbacks` gana `onExplorationStep`.
Si la exploración falla, el intake continúa sin evidencia y lo avisa: el `.feature` sigue
siendo revisable por el usuario, y la Fase 2 bloqueará después si los literales no cuadran.

**Prompt.** `gherkinGenerationPrompt` recibe las pantallas y una regla dura: todo texto
entrecomillado en un `Then` debe aparecer literal en algún snapshot; si no aparece, se
escribe el paso sin literal (p. ej. "veo un mensaje de error") en vez de inventarlo.

**Caché.** `core/src/siteExplorer/evidenceCache.ts`, fichero
`.agente-qa/cache/exploration-<hash>.json`, clave = hash de `appUrl` + nombre del patrón +
`routes`, TTL 30 minutos vía `capturedAt` almacenado. `runGenerador` la lee antes de
explorar: el flujo completo sigue costando una exploración, no dos. El directorio se crea
con permisos 0700 y los ficheros con 0600, igual que `.env` — un snapshot de accesibilidad
contiene datos reales de la aplicación del usuario aunque las credenciales estén redactadas
— y la propia función de escritura deja un `.gitignore` con `*` dentro de la carpeta de
caché. Se hace así, y no añadiendo una línea al `.agente-qa/.gitignore` desde `init`, porque
un proyecto ya inicializado no vuelve a pasar por `init`: la evidencia acabaría en git hasta
que el usuario lo re-ejecutase.

### 3.3 Fase 2 — cierre del bucle de verificación

**Pre-chequeo offline** (sin navegador, puro, barato):
`core/src/locatorVerify/checkExpectedLiterals.ts` cruza cada `LocatorCheck` con todos los
`ScreenEvidence`. Comparación por subcadena sobre texto normalizado (espacios colapsados,
sin distinguir mayúsculas) — las mismas semánticas que usa Playwright para `get_by_text` y
para el nombre accesible de `get_by_role` con `exact=False`, que es como `"Log In"` del
`.feature` casa con el botón real `"Log in"`. Si no hubo evidencia ninguna (exploración
fallida), el pre-chequeo se salta — no hay nada contra lo que comparar — y la verificación
en navegador sigue siendo la única puerta. Un literal ausente de todas las pantallas
capturadas es error, y el mensaje incluye el
candidato real más parecido, extraído de los nombres accesibles y las líneas `text:` del
snapshot, con una función de similitud propia (sin dependencia nueva):

```
El feature espera el título "Dream and Growth", que no aparece en ninguna pantalla
verificada. El texto real más parecido es "Sueño y crecimiento".
```

Ese mensaje **aborta la generación de inmediato**, sin consumir ningún reintento. El bucle
de reintento regenera código Python, y el literal vive en el `.feature`: el argumento del
check sería idéntico en los cuatro intentos. Peor, la única forma que tendría el modelo de
"aprobar" es dejar de pasar el literal a un método `get_*` — debilitar la aserción para
pasar la verificación. El mensaje remite al usuario a corregir el `.feature` o a regenerar
el plan, que con la Fase 1 ya sale anclado.

**Verificación multipantalla.** `LocatorVerifier.verify` cambia `baseUrl: string` por
`urls: string[]` y comprueba cada check contra todas las pantallas capturadas. Un check
pasa si cuenta >= 1 en al menos una. Cuenta >= 2 en cualquiera sigue siendo error de
ambigüedad, como hoy. `runGenerador` deja de usar `evidence[0].url` y pasa las URLs de
todas las pantallas.

**`count === 0` vuelve a ser fallo.** Con la Fase 1 anclando los literales y el
pre-chequeo cubriendo el caso offline, ya no es ambiguo. Agotados los 4 intentos, se aborta
y no se escribe ningún fichero.

**`networkidle` con timeout corto**, tragándose el error (pendiente aparcado el 14-ago,
mismo patrón que `realSiteExplorer` ya usa): en aplicaciones con conexión persistente puede
colgar hasta el timeout de 30 s de Playwright y gastar los 4 intentos por una puerta que el
detector de "faltan navegadores" no reconoce.

### 3.4 Fase 3 — credenciales de prueba sin literales que mienten

El Page Object generado hoy contiene:

```python
actual_email = os.environ.get("AGENTE_QA_TEST_USERNAME", email) if email == "user@example.com" else email
```

El `.feature` dice una cosa y el test hace otra, en silencio. Se sustituye por una
convención explícita: para credenciales válidas, Agente 1 escribe un paso **sin literal**
(`When introduzco las credenciales de la cuenta de prueba`) y el Page Object lee
`os.environ` directamente. Las credenciales inválidas sí se escriben literales — una
contraseña incorrecta no es un secreto. Regla en ambos prompts y lint
`checkCredentialSubstitution` que marca cualquier lectura de `os.environ` condicionada por
una comparación con un literal.

## 4. Seguridad

- La evidencia cacheada en disco es contenido real de la aplicación del usuario: directorio
  0700, ficheros 0600, gitignored. La redacción de credenciales ya existente en
  `captureEvidence` es la única puerta por la que se construye `ScreenEvidence`, y la sonda
  negativa entra por ella.
- La contraseña de la sonda negativa es una constante fija del módulo, nunca derivada de la
  real, nunca registrada.
- Antes de publicar cualquiera de estas fases en npm, pasa la skill `seguridad-seo` (regla
  del proyecto, sin cambios).

## 5. Pruebas

- Puras y unitarias: `checkStepParsers`, `parseStepTemplate`, `checkExpectedLiterals` y la
  función de similitud, `evidenceCache` (con `fs.mkdtemp` real, sin mockear `fs`).
- `runIntake` con un `FakeSiteExplorer`, igual que `runGenerador` hoy.
- Lo que toca navegador real queda gated (`describe.skipIf`), como los tests existentes.
- **Condición de "hecho" del conjunto:** regenerar los tests de `C:\GitHub\QA_Testing`
  contra `babia-nav.vercel.app` y obtener 5/5 en verde, o un bloqueo explícito que nombre
  el escenario que la aplicación no puede satisfacer. La prueba es ese `pytest`, no
  `vitest`.

Advertencia honesta registrada en la spec: si la app valida los campos obligatorios con la
validación nativa del navegador (sin texto en el DOM), el resultado correcto de la Fase 1 es
que Agente 1 **no escriba** ese escenario con literal, no que los 5 pasen a la fuerza.

## 6. Fuera de alcance

- Replay completo del escenario en el verificador (ya descartado el 14-ago: efectos reales
  repetidos).
- Eliminar `appLanguage` de la configuración.
- Recargar el `config.json` existente antes de re-preguntar en `init` (pendiente del
  14-ago, independiente).
- Cualquier cambio en Agente 3 y Agente 4.
