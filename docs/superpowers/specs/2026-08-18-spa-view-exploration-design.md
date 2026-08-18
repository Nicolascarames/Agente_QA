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

Regla determinista: **una vista que añade un campo rellenable (`input` o
`select`) es una pantalla; una que solo añade botones, enlaces o texto es un
estado.** Un botón nuevo, por sí solo, nunca promueve — un diálogo de
confirmación o un menú desplegable siguen siendo estado exactamente como hoy.

Contrastada contra el mapa real medido y el fixture existente:

| Acción | Qué añade | Clasificación |
|---|---|---|
| Envío inválido de "Log in" | solo `"Authentication failed. Please try again."` | estado (igual que hoy) |
| "Forgot password?" (medido: sin input nuevo, solo botones/heading/texto) | `Send reset link`, `Back to log in`, heading, texto | estado |
| `state.html` — "Forgot password?" del fixture | un botón `Send reset link`, sin input | estado (ya cubierto por 3 tests existentes) |
| Envío válido de "Log in" | el dashboard entero, sin campos rellenables propios | estado — pero D2 sigue explorando dentro, ver más abajo |
| "Crear bebé", pulsado dentro de ese estado | input Nombre, input Fecha de nacimiento, botón Crear | pantalla, alcanzada con el camino `[submit log_in_button_2 válido, click crear_bebe_button]` |

Se comprobó contra `core/src/appMap/__fixtures__/site/state.html` y sus tres
tests en `realCrawler.walk.test.ts` (líneas 292-317): ese fixture añade un
botón sin ningún input, y los tests ya afirman que debe quedar como estado.
Una primera redacción de esta regla ("cualquier localizador interactivo
promueve") entraba en conflicto directo con ese suite ya validado. La versión
final — solo campos rellenables — es coherente con él sin tocar sus
expectativas.

La alternativa considerada — "sustituye vs añade" — se descarta: un modal se
superpone sin retirar nada del DOM, y clasificaría el formulario de crear bebé
como estado, que es justo el caso que motiva el trabajo.

Límite conocido y aceptado: si una vista nueva reutiliza el mismo nombre de
locator que uno ya existente en la pantalla (p. ej. un input "Email" propio de
un panel de reset que se llama igual que el "Email" del login), `mergeScreenState`
lo descarta por nombre duplicado antes de que esta regla pueda verlo, y la vista
se queda como estado aunque tuviera un campo propio. Es una limitación
preexistente de la deduplicación por nombre, no algo que este trabajo resuelva.

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

**Corrección importante, encontrada al planificar la implementación:** D1
decide si una vista tiene Page Object propio, pero por sí sola NO decide si el
walk sigue explorando más allá de esa vista. Con la regla de arriba, el
dashboard post-login se queda como estado (solo añade botones). Un estado es
hoy terminal — nada dentro de él se pulsa. Sin corregir esto, `crear_bebe_button`
seguiría sin explorarse nunca, que es exactamente el bug que motiva todo este
trabajo: la promoción por sí sola no lo resuelve.

Por eso D2 (más abajo) explora dentro de un estado igual que dentro de una
pantalla promocionada: la única diferencia entre ambos es si el nodo obtiene
Page Object propio, nunca si se sigue explorando desde él. El campo `path` de
`reachedBy` ya lo soporta sin cambios de esquema — un paso del camino puede ser
un hop que solo produjo un estado, no una pantalla.

### D2 — Se vuelve a una vista reproduciendo su camino, promocionada o no

Ni una pantalla promocionada ni un estado son direccionables: no existe
`page.goto()` que lleve al modal de crear bebé, y tampoco lo hay para "el
dashboard tras un login válido". Cada nodo — promocionado o no — guarda la URL
de entrada más direccionable (la del ancestro `Screen` real) y la secuencia de
acciones que lleva hasta él. Para explorar dentro de cualquiera de los dos, el
crawler navega a esa URL y reproduce el camino, **verificando la firma después
de cada paso**. Si una firma no coincide con la registrada, la rama se aborta,
se emite aviso y el mapa queda `complete: false`.

El walk trata la cola BFS de forma uniforme: cada elemento es un camino (posiblemente
vacío, para las pantallas direccionables de siempre). Al procesar uno, se enumeran
los controles nuevos que el DOM ofrece en ese punto — vengan de la captura base o de
un estado — y cada uno que no se haya pulsado ya se encola con el camino extendido en
un paso, sin importar si el hop anterior produjo pantalla o solo estado. `maxViewDepth`
acota la longitud del camino, no si hubo promoción por el medio.

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

`ScreenState` amplía su significado: hoy son cambios que solo añaden texto;
pasan a admitir también botones y enlaces nuevos, siempre que ningún campo
rellenable aparezca — el caso que D1 sigue clasificando como estado.

### Recorrido (`core/src/appMap/realCrawler.ts`)

Las vistas y los estados entran en la misma cola BFS que las URLs. Un elemento
de la cola pasa a ser `{ url, depth }` (pantalla direccionable, camino vacío) o
`{ path, depth }` (todo lo demás — pantalla promocionada o estado, sin
distinción a efectos de cola).

Al detectar que un clic no cambió de ruta, el crawler compara los localizadores
capturados con los ya conocidos en ese punto del árbol. Si hay un campo
rellenable (`input`/`select`) nuevo, se promociona a pantalla con su propio
`reachedBy`; si no, se funde como estado del ancestro más cercano, igual que
hoy. **En ambos casos** los controles nuevos que ese punto revela se encolan
con el camino extendido en un paso — un estado ya no es un punto final, solo
un punto sin Page Object propio.

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

### Ruido en la promoción (D1) fuera de SPA con modales

D1 generaliza bien a modales, paneles y pasos de asistente, pero la regla
"añade localizadores interactivos ⇒ pantalla" también dispara en patrones que no
deberían convertirse en pantallas propias: un acordeón que despliega un botón, un
"cargar más" que añade filas con acciones, un menú desplegable. En una aplicación
con muchos de estos patrones el mapa se llenaría de pantallas triviales, sin que
D1 tenga forma de distinguirlas de un modal real.

No se afina la regla con heurísticas nuevas — no hay casos reales delante para
validarlas. En su lugar, cuando una misma pantalla base acumula más de 10 vistas
promovidas, el walk emite un aviso: probablemente hay un patrón repetitivo, y
conviene bajar `maxViewDepth` o excluir la ruta con `excludeRoutes`. El umbral no
bloquea el crawl ni cuenta contra `maxScreens`; solo hace visible un fallo que de
otro modo sería silencioso.

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
