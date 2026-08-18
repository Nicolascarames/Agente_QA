# Exploración de vistas SPA en el Explorador

Fecha: 2026-08-18

## Problema

El Explorador usa "la URL cambió" como sinónimo de "pasó algo". En una
aplicación de página única la URL no cambia nunca, así que el crawler es ciego a
todo lo que ocurre después del primer clic.

El defecto se midió sobre una aplicación real (BabIA). El mapa resultante
contiene **una sola pantalla**, `authenticated: false`, y `transitions: []`, pese
a que el login funcionó y el mapa sí recoge localizadores de la zona privada.

Son dos fallos encadenados.

**Fallo 1 — el login no se detecta.** `attemptLogin` decide el éxito con
`page.url() !== before`. En una SPA el envío válido deja la URL idéntica, así que
la sesión se da por fallida y **el recorrido entero corre deslogueado**. Lo que
el mapa recoge de la zona privada no lo trajo el walk: lo trajo `runWritePass`,
que corre después, envía el formulario y — al ver que la URL no cambió — guarda
el dashboard completo como un estado plano de la pantalla de login. `runWritePass`
repite el mismo error de detección para marcar `authenticated`.

**Fallo 2 — los estados son terminales.** Tras capturar un estado, el walk vuelve
a la base con `page.goto(next.url)` y nunca pulsa los controles que **solo existen
dentro de ese estado**. En el mapa medido, `crear_bebe_button` está etiquetado
`stateId: valid-submit-log_in_button_2`: vive dentro del estado, así que jamás se
pulsa y el formulario de creación de bebé no existe para el sistema.

Consecuencia aguas abajo, que es como se detectó el problema: el Agente 1 recibe
peticiones que no puede satisfacer ("pincha en crear bebé, rellena nombre y fecha,
pulsa crear") y devuelve un plan casi idéntico al anterior sin explicar por qué.
El modelo se comporta correctamente — la regla 2 de `gherkinGenerationPrompt` le
prohíbe citar textos que no estén en el mapa, y `checkFeatureLiterals` rechazaría
el plan si lo hiciera. El fallo es del crawler, no del LLM.

## Objetivo

Que el mapa cubra las vistas que una SPA presenta sin cambiar de ruta, hasta una
profundidad configurable, y que el código generado sepa alcanzarlas.

## No objetivos

- Selección de pantalla en el intake. Hoy una petición libre se ancla siempre a
  `map.screens[0]`; con muchas más pantallas eso empeora, pero es un defecto
  preexistente y se aborda aparte.
- Exploración desatendida con escritura. Ningún formulario se envía sin
  aprobación explícita del usuario.

## Decisiones

### D1 — Una vista SPA se promueve a pantalla

Regla determinista: **una vista que añade localizadores interactivos
(`input`, `button`, `select`) es una pantalla; una que solo añade texto es un
estado.**

Contrastada contra el mapa real medido:

| Acción | Qué añade | Clasificación |
|---|---|---|
| Envío inválido de "Log in" | solo `"Authentication failed. Please try again."` | estado (igual que hoy) |
| "Forgot password?" | inputs y botones del panel de reset | pantalla |
| Envío válido de "Log in" | el dashboard entero | pantalla |
| "Crear bebé" | Nombre, Fecha de nacimiento, botón Crear | pantalla |

La alternativa considerada — "sustituye vs añade" — se descarta: un modal se
superpone sin retirar nada del DOM, y clasificaría el formulario de crear bebé
como estado, que es justo el caso que motiva el trabajo.

El motivo de promover en vez de anidar estados no es estético. El prompt del
intake vuelca **todos** los literales de una pantalla en una lista plana
(`screenLiterals`), y `checkFeatureLiterals` valida contra esa misma lista. La
pantalla `home` medida ya tiene 49 localizadores y 45 textos con un solo nivel;
a cuatro niveles serían cientos, mezclando el login con el formulario de sueño, y
el gate daría por bueno afirmar un texto del formulario de comidas dentro de un
escenario de login. Promoviendo, cada vista trae su propio ámbito de literales y
el problema desaparece sin tocar los consumidores.

Coste aceptado: se rompe el invariante "un Page Object por ruta". En una SPA ese
invariante ya no describe nada — la ruta no identifica lo que se ve.

### D2 — Se vuelve a una vista reproduciendo su camino

Una vista no es direccionable: no existe `page.goto()` que lleve al modal de
crear bebé. Cada vista guarda la URL de entrada y la secuencia de acciones que
lleva hasta ella. Para explorar dentro, el crawler navega a la URL de entrada y
reproduce el camino, **verificando la firma después de cada paso**. Si una firma
no coincide con la registrada, la rama se aborta, se emite aviso y el mapa queda
`complete: false`.

La alternativa — seguir explorando in situ en profundidad, sin volver a la base —
gasta muchas menos acciones, pero deja al crawler sin saber dónde está tras un
clic fallido y basta un modal que no cierre para varar el recorrido. Se descarta
por fiabilidad.

### D3 — La detección de sesión deja de mirar la URL

Un envío se considera exitoso cuando **la URL cambió, o la firma dejó de ser la
de la pantalla de login y ya no queda ningún campo de contraseña**. Comparar solo
firmas no vale: un login fallido también cambia la firma al pintar el error.

### D4 — La aprobación de escrituras se vuelve incremental

Explorar en profundidad es, literalmente, escribir datos: no hay forma de ver el
formulario de sueño sin haber creado antes un bebé. `approveWriteActions` se
llama hoy una sola vez, con todo lo que el walk descubrió de golpe; con
exploración en profundidad aparecen formularios nuevos a mitad del recorrido.

Pasa a llamarse **una vez por frontera**: al terminar cada nivel se agrupan los
formularios nuevos y se pregunta. Un formulario no aprobado no se envía y su rama
termina ahí, con un aviso explícito de que el mapa no cubre lo que hay detrás.
Las lecturas nunca preguntan.

### D5 — El código generado sabe navegar hasta una vista

`pageObjectEmitter` emite un Page Object por vista, y su `goto()` reproduce el
camino llamando a los Page Objects de los ancestros. Sin esto el mapa mejoraría y
los planes Gherkin serían correctos, pero el Python generado no podría alcanzar
ninguna de las pantallas nuevas.

## Diseño

### Esquema (`core/src/appMap/schema.ts`)

`ScreenSchema` gana un campo opcional:

```
reachedBy?: {
  entryScreenId: string
  path: Array<{ action: "click" | "submit", locator: string, data: "valid" | "invalid" | "none" }>
}
```

Ausente en pantallas direccionables por URL; presente en toda vista promovida.
`schemaVersion` sube a `2`. Un mapa de versión 1 se rechaza al cargar con un
mensaje que pide volver a ejecutar `agente-qa map`; no se migra, porque un mapa
viejo de una SPA es precisamente el mapa incompleto que este trabajo arregla.

`Screen.id` de una vista se compone del identificador del padre más el
localizador que lleva a ella, en kebab-case: `home`, `home~log-in`,
`home~log-in~crear-bebe`. Ante colisión se sufija un índice. El separador `~` se
elige porque no puede aparecer dentro de un segmento en kebab-case, a diferencia
de `-`, que haría el identificador ambiguo.

Ese separador obliga a dos ajustes que, omitidos, rompen el sistema en silencio:

- `SCREEN_TAG` en `checkFeatureLiterals.ts` es `/@screen:([\p{L}\p{N}_-]+)/u` y
  **no admite `~`**. Sin ampliarla, la etiqueta `@screen:home~log-in` capturaría
  solo `home`, y el gate validaría los literales contra la pantalla equivocada —
  exactamente el fallo que ese gate existe para impedir.
- `Screen.className` se deriva del id y acaba siendo un nombre de clase Python.
  `screenIdentity` debe convertir `~` en un separador válido (`HomeLogInPage`),
  igual que ya hace con los demás caracteres de ruta.

`urlTemplate` sigue siendo la ruta donde la vista se renderiza, de modo que
varias pantallas comparten valor. Eso obliga a arreglar la resolución de
`toScreenId` al final del walk, que hoy busca por `urlTemplate` y pasaría a ser
ambigua: debe resolver a la pantalla **base** de la ruta, nunca a una vista.

`ScreenState` conserva su significado actual: cambios que solo añaden texto.

### Recorrido (`core/src/appMap/realCrawler.ts`)

Las vistas entran en la misma cola BFS que las URLs. Un elemento de la cola pasa
a ser `{ url, depth }` o `{ path, depth }`.

Al detectar que un clic no cambió de ruta, el crawler compara los localizadores
capturados con los de la vista de origen. Si hay localizadores interactivos
nuevos, encola una pantalla nueva con su camino; si no, registra un estado como
hoy.

La reproducción de un camino reutiliza el localizador ya validado en captura
(`scopedBy` / `narrowedBy`), nunca vuelve a resolver el nombre accesible desde
cero — la misma razón por la que el walk actual lo hace así. Los pasos `submit`
rellenan con los mismos datos que registró el descubrimiento.

Nuevo límite `maxViewDepth` sobre la longitud del camino. `maxScreens` y
`maxDurationMinutes` siguen siendo la red de seguridad global.

`requiresAuth` de una vista no se sondea: `derivePrivateScreens` necesita una URL
que pedir sin sesión, y una vista no la tiene. Una vista cuyo camino cruza un
envío de login es `requiresAuth: true` por construcción.

### Configuración

`ProjectConfigSchema.crawl.maxViewDepth`, entero, mínimo 0, **por defecto 4**.
Se propaga por `CrawlLimits` igual que los demás límites. `agente-qa init` añade
la pregunta correspondiente en castellano, con 4 como valor propuesto.

Cuatro es el número que cubre el caso medido: nivel 1 dashboard, nivel 2 modal de
crear bebé, nivel 3 dashboard con bebé creado, nivel 4 formularios de sueño,
comida y peso — que solo aparecen una vez existe un bebé, como demuestra el
estado vacío del mapa actual.

### Emisión de Page Objects (`core/src/appMap/pageObjectEmitter.ts`)

Para una pantalla con `reachedBy`, `goto()` navega a la URL de entrada y
reproduce el camino invocando métodos de los Page Objects ancestros, no
localizadores crudos.

Los pasos `submit` necesitan datos, y el emisor no inventa ninguno:

- Un envío de login se resuelve con `os.environ["AGENTE_QA_TEST_USERNAME"]` y
  `os.environ["AGENTE_QA_TEST_PASSWORD"]`, la misma fuente que ya usa el código
  generado hoy.
- Cualquier otro envío convierte los campos del formulario en **parámetros de
  `goto()`**, de modo que el valor lo aporta el escenario.

`pageObjectMethodNames` refleja la firma resultante: es el contrato que se le
pasa al LLM del Generador, y una aridad incorrecta ahí produce código que no
compila.

Un `goto()` que atraviesa un envío de creación **escribe datos reales en la
aplicación cada vez que el test se ejecuta**. El Page Object emitido lo declara
en un comentario de cabecera. No se oculta ni se evita: probar una aplicación
exige escribir.

Se conserva la excepción actual: si el camino no es reproducible — ruta con
segmentos variables en la entrada — no se emite `goto()` y se explica por qué en
un comentario, como ya se hace hoy.

## Verificación

Los tests del crawler usan páginas falsas a través de `testUtils.ts`; los casos
nuevos van a los ficheros de test existentes de cada módulo, no a ficheros
nuevos por tarea.

Casos que el trabajo debe cubrir:

- Un envío válido que no cambia la URL marca `authenticated: true`.
- Un envío inválido que no cambia la URL no lo marca.
- Un clic que añade solo texto sigue produciendo un estado.
- Un clic que añade un input produce una pantalla con su camino.
- Reproducir un camino cuya firma intermedia cambió aborta la rama y deja
  `complete: false`.
- `maxViewDepth: 0` reproduce exactamente el comportamiento por niveles de hoy.
- Un formulario no aprobado no se envía y su rama no aparece en el mapa.
- `goto()` de una vista tras login lee las credenciales de `os.environ`.
- `goto()` de una vista tras un envío no-login expone los campos como parámetros.

Cierre: `tsc --noEmit` limpio en ambos paquetes y `vitest run` en verde.

## Riesgo conocido

El coste del recorrido crece con el producto de controles por profundidad, y cada
nivel se paga en reproducciones de camino. El crawl medido tardó 27 segundos con
una pantalla; con cuatro niveles de vista será de otro orden. `maxDurationMinutes`
(60 por defecto) es el tope real, y un crawl que lo alcance devuelve
`complete: false` en vez de fallar — comportamiento ya existente que aquí importa
más que antes.
