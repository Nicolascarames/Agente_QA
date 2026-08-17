# Identidad de localizador y desambiguación del paso Gherkin

Fecha: 2026-08-17
Estado: aprobado, sin implementar

## 1. El problema

Una pantalla real con dos controles que comparten nombre accesible destapó tres
defectos encadenados. El caso concreto: la pantalla `home` de una app con un
botón «Log in» que alterna entre login y signup (`type="button"`) y otro botón
«Log in» que envía el formulario (`type="submit"`).

El crawler los desambigua bien y los dos entran al mapa con `count: 1`:

```json
{ "name": "log_in_button",   "disambiguatedBy": "attribute:[type='button']"  }
{ "name": "log_in_button_2", "disambiguatedBy": "attribute:[type='submit']" }
```

### Defecto 1 — el Python emitido no se puede ejecutar

Al desambiguar por atributo, la expresión guardada contiene **dos** referencias
a `page`:

```
page.get_by_role("button", name="Log in", exact=True).and_(page.locator("[type='button']"))
```

`pageObjectEmitter.ts` emite `return self.${locator.python}`, que solo convierte
el **primer** `page.` en `self.page.`. El de dentro de `.and_(...)` se queda
desnudo, y dentro de un método de clase no existe ningún `page`:

```
NameError: name 'page' is not defined
```

`mapFreshness.ts` arrastra el mismo defecto por su cuenta: su
`toSelfPageExpression` hace idéntica reescritura de solo-el-prefijo. Su script
de verificación lanza, el `except` de cada check lo registra como error, y el
CLI acaba diciendo «el localizador ya no se ha podido resolver en la aplicación
real» — culpando a la app de un fallo del emisor.

El crawler lo había validado como `count: 1` porque valida en **Node**, donde
`page` sí está en ámbito (`form.build(page).and(page.locator(selector))`). La
misma familia que la corrección del 2026-08-16 sobre `exact: true`: se valida
una forma y se ejecuta otra, y nadie compara las dos.

### Defecto 2 — el nombre depende del orden del recorrido

`uniqueName` resuelve la colisión con un contador: el segundo que se encuentre
es `_2`. Ese nombre acaba siendo el sufijo del método Python
(`click_log_in_button_2`). Dos consecuencias: no dice nada sobre qué distingue a
ese localizador, y **cambia si cambia el orden del crawl**, de modo que
cualquier referencia externa a ese nombre se rompe en silencio.

### Defecto 3 — el paso Gherkin elige el primero que casa

`locatorsUsedBy` resuelve el texto entrecomillado del paso primero por
`accessibleName` y luego por `name`, con `.find()`: **el primero del array**.
Los dos botones tienen `accessibleName: "Log in"`, así que
`When I click "Log in"` siempre resuelve al de `type="button"` y nunca al
submit, sin aviso. Un escenario de login puede generarse pulsando el botón
equivocado y pasar por bueno.

## 2. Alcance

Entra:

1. Una única reescritura compartida de `page.` a `self.page.`, consumida por el
   emisor y por el verificador de frescura.
2. Nombres de localizador derivados del hecho que los desambiguó, nunca de un
   contador.
3. Desambiguación del paso: cuando el texto entrecomillado casa con más de un
   localizador, el Generador pregunta al usuario, le enseña los datos del mapa
   de cada candidato, y **reescribe el paso en el `.feature`** con el nombre del
   localizador elegido.

No entra, por decisión explícita del usuario:

- **Renombrar localizadores a mano.** No se añade `rename` a `LocatorOverride`,
  ni entradas de revisión pre-rellenadas, ni comentarios `# REVISAR` en el Page
  Object. El usuario no quiere renombrar; quiere arreglar el clic.
- **Un campo de descripción legible en el mapa.** Descartado: el identificador
  mecánico debe cargar el significado él solo.
- **Preguntar durante el `map`.** El recorrido sigue desatendido de principio a
  fin.
- **Enseñar al prompt de Intake a citar el nombre del localizador cuando hay
  colisión.** Evitaría la pregunta en el caso común, pero es una instrucción a
  un LLM y por tanto una tendencia, no una garantía; el flujo de pregunta ya
  cubre el caso de forma determinista, y añadirlo crea un segundo sitio donde la
  regla puede divergir.

## 3. Diseño 1 — la reescritura compartida

Una función pura, con un único dueño, usada por `pageObjectEmitter.ts` y por
`mapFreshness.ts`:

```ts
/** Toda referencia a `page` pasa a `self.page` — no solo la primera. */
export function toSelfPageExpression(python: string): string {
  return python.replace(/\bpage\./g, "self.page.");
}
```

`\b` no casa dentro de `login_page.` porque `_` es carácter de palabra, así que
una expresión que ya referencie un Page Object no se corrompe.

La razón de que sea **una** función y no dos idénticas es directa: hoy la regla
está duplicada y las dos copias están mal a la vez. Un único dueño es lo que
impide que vuelvan a divergir.

## 4. Diseño 2 — el nombre sale del desambiguador

`disambiguatedBy` tiene hoy tres formas: `attribute:[k='v']`, `region:<rol>` y
`selector:<css>`. El sufijo del nombre se deriva de ella:

| `disambiguatedBy` | token | nombre |
|---|---|---|
| `attribute:[type='submit']` | `submit` | `log_in_button_submit` |
| `attribute:[type='button']` | `button` → redundante | `log_in_button` |
| `attribute:[data-testid='login-submit']` | `login_submit` | `log_in_button_login_submit` |
| `region:banner` | `banner` | `log_in_button_banner` |
| `selector:form` | `form` | `log_in_button_form` |

Reglas, en orden:

1. El token sale del **valor** en `attribute:`, del **rol** en `region:` y del
   selector saneado en `selector:`, pasado por `pythonIdentifier`.
2. Si el token ya es la última palabra del nombre base, **se suprime** — salvo
   que suprimirlo provoque colisión con otro localizador de la misma pantalla,
   en cuyo caso se conserva.
3. Si no se puede derivar ningún token no vacío, se usa el `disambiguatedBy`
   entero saneado.
4. Si aun así dos localizadores de una pantalla colisionan, el desempate es un
   hash corto y estable de su `python`. **Nunca un contador de orden.**

La propiedad que hay que preservar, y que los tests deben ejercitar
explícitamente: **el nombre depende solo de hechos del elemento, jamás del orden
en que el crawler lo encontró.** Recorrer la misma app dos veces produce los
mismos nombres.

Un localizador sin `disambiguatedBy` (el caso común, sin colisión) conserva su
nombre base como hoy.

## 5. Diseño 3 — desambiguación del paso

### 5.1 La función pura deja de decidir

`locatorsUsedBy` no puede preguntar: es pura y `core/src` no hace I/O de
terminal. Deja de resolver la ambigüedad y la **reporta**: cuando un texto
entrecomillado casa con más de un localizador de la pantalla, devuelve esa
entrada marcada con todos sus candidatos en vez de quedarse con el primero.

### 5.2 El agente pregunta

`GeneratorCallbacks` gana un miembro:

```ts
onAmbiguousLocator(
  quoted: string,
  screenId: string,
  candidates: LocatorEntry[]
): Promise<LocatorEntry>;
```

No admite «ninguno»: la ambigüedad tiene que resolverse para poder generar. Si
el usuario cancela, se aborta la corrida con un mensaje accionable, igual que
hace hoy la salida `remap` de `onStaleLocator`.

### 5.3 Qué se le enseña al usuario

Antes de la pregunta, el CLI imprime la **entrada completa del mapa** de cada
candidato — `name`, `kind`, `accessibleName`, `python`, `count`,
`disambiguatedBy`, `attributes`, `verifiedAt` y `stateId` si lo tiene — junto al
nombre del método del Page Object que le corresponde. Solo lectura, en la
terminal: no se abre ni se modifica ningún fichero.

### 5.4 La elección se escribe en el `.feature`

Elegido el localizador, el Generador **reescribe ese paso** en el fichero
`.feature`:

```gherkin
When I click "Log in"                    →  When I click "log_in_button_submit"
```

Qué se reescribe exactamente, para que no quede a interpretación:

- Los pasos afectados son `I click "<x>"` y `I fill "<x>" with "<y>"`. En el
  segundo solo el **primer** grupo entrecomillado nombra un localizador; el
  segundo es dato de prueba y no se toca nunca.
- Se pregunta **una vez por par (pantalla, texto entrecomillado)**, no una vez
  por paso: si tres pasos bajo el mismo `@screen:` citan `"Log in"`, todos
  quieren decir el mismo elemento. La respuesta se aplica a los tres.
- La reescritura se limita a los escenarios bajo esa etiqueta `@screen:`. El
  mismo texto en otra pantalla es otra pregunta, porque es otro mapa de
  localizadores.

Esto ocurre antes del chequeo de frescura, de modo que la frescura verifica
exactamente lo que el `.feature` ya dice. El fichero reescrito se anuncia por
`emit`, nombrando el fichero y el cambio: el usuario aprobó ese plan y tiene
derecho a enterarse de que se ha tocado.

Tres propiedades que esto compra:

- **Termina.** En la siguiente corrida, `locatorsUsedBy` resuelve
  `log_in_button_submit` por el camino de `name` — único por construcción — y no
  vuelve a preguntar.
- **El modelo no puede equivocarse.** El paso nombra el localizador exacto, así
  que el prompt de generación ya no ofrece una elección que el LLM pueda fallar.
- **Queda en git.** La decisión vive en el artefacto que el usuario versiona y
  revisa, no en un fichero lateral invisible.

`checkFeatureLiterals` **no** cambia: solo lo invoca `runIntake`, sobre planes
recién generados. Nada vuelve a lintear el `.feature` después de la reescritura.

## 6. Ficheros

| Fichero | Cambio |
|---|---|
| `core/src/appMap/pythonExpression.ts` (nuevo) | Dueño único de `toSelfPageExpression` |
| `core/src/appMap/pageObjectEmitter.ts` | Consume la función compartida |
| `core/src/locatorVerify/mapFreshness.ts` | Consume la función compartida; `locatorsUsedBy` reporta la ambigüedad |
| `core/src/appMap/naming.ts` | Derivación del sufijo desde el desambiguador; fuera el contador |
| `core/src/appMap/realCrawler.ts` | Pasa el desambiguador al nombrar |
| `core/src/agents/generador/runGenerador.ts` | Pregunta, reescribe el paso, emite el aviso |
| `cli/src/prompts/types.ts`, `inquirerPrompts.ts` | Prompt nuevo con el volcado del mapa |

## 7. Verificación

Además de los tests por tarea:

- **Prueba por mutación obligatoria** en los tres defectos. Revertir cada
  arreglo tiene que poner en rojo su test. El defecto 1 en particular necesita
  un test que ejecute de verdad la expresión emitida, no que la compare como
  cadena: comparar cadenas es exactamente lo que dejó pasar el `NameError`.
- **Test de estabilidad del nombre**: nombrar la misma pantalla con los
  localizadores en orden invertido produce los mismos nombres.
- **Test de terminación**: un `.feature` ya reescrito no vuelve a disparar la
  pregunta.

## 8. Límites conocidos

- `locatorsUsedBy` descarta en silencio un texto entrecomillado que no resuelve
  a ningún localizador. Preexistente, misma familia de fallo silencioso que esta
  spec corrige en otro punto; queda fuera de alcance y anotado.
- Un `.feature` escrito a mano que cite un nombre de localizador inexistente cae
  en ese mismo hueco: la frescura lo salta y el fallo aparece en pytest.
- Los mapas y Page Objects ya existentes se regeneran con `agente-qa map`. No
  hay migración: los nombres cambian, y con ellos los métodos del Page Object.
