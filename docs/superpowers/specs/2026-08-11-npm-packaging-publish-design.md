# Empaquetado y publicación npm de Agente_QA — Diseño

Fecha: 2026-08-11
Estado: Aprobado para pasar a plan de implementación
Depende de: `docs/superpowers/specs/2026-08-10-agente-qa-pipeline-design.md` (§3 estructura del repositorio, §10 deja "nombre definitivo del paquete npm" como punto abierto — este documento lo cierra).

## 1. Objetivo

Cerrar los hallazgos de empaquetado npm aparcados en `memory.md` desde la review final de Plan 1 y publicar por primera vez `@agente-qa/core` y `agente-qa` (CLI) en el registro público de npm, con los 4 agentes ya completos en `main`.

### No objetivos de este documento

- Superficie de plugin de Claude Code — sigue como plan futuro independiente, no se toca aquí.
- Tooling de versionado multi-paquete (changesets, lerna) — con solo dos paquetes y una dependencia interna, coordinar versiones a mano es suficiente para v1. YAGNI.
- Automatizar `npm login`/`npm publish` en CI — este documento cubre el primer publish manual desde esta máquina, no un pipeline de release continuo.

## 2. Contexto y decisiones ya tomadas

- Nombres de paquete confirmados y libres en el registro (comprobado con `npm view`, 404 en ambos): `agente-qa` (CLI) y `@agente-qa/core` (motor).
- Versión de publicación: `0.1.0`, ya presente en ambos `package.json` — primer publish.
- No hay sesión npm activa en esta máquina ni cuenta documentada en el vault del usuario. El `npm login` (flujo OAuth en navegador) lo hace el usuario; no es algo que este sistema pueda o deba iniciar por su cuenta.

## 3. Empaquetado: qué viaja en el tarball

### 3.1 `files` en `package.json`

Ambos `core/package.json` y `cli/package.json` añaden `"files": ["dist"]`. Sin este campo, `npm publish` incluye por defecto todo el árbol del paquete no cubierto por `.gitignore` (código fuente TypeScript, tests, configs) — ruido innecesario en el tarball publicado.

### 3.2 Excluir `*.test.ts` del build sin perder typecheck

Los `tsconfig.json` actuales de `core`/`cli` no excluyen ficheros de test de su `include`, así que `tsc -p <paquete>/tsconfig.json` (usado tanto para `npm run build` como para el `--noEmit` de typecheck que se ejecuta en todo el flujo de este proyecto) compila también los `*.test.ts` a `dist/`.

**Decisión**: separar "qué se typechea" de "qué se compila para publicar":

- Nuevo `core/tsconfig.build.json` y `cli/tsconfig.build.json`, cada uno `"extends"` su `tsconfig.json` existente añadiendo `"exclude": ["src/**/*.test.ts", "**/*.test.ts"]`.
- El script `"build"` de cada `package.json` pasa de `tsc -p tsconfig.json` a `tsc -p tsconfig.build.json`.
- `tsconfig.json` (el general) no se toca — sigue siendo el que usan `npx tsc -p <paquete>/tsconfig.json --noEmit` y cualquier editor/IDE, así que los tests se siguen typechecando exactamente igual que hoy. Solo cambia qué se emite a `dist/`.

### 3.3 Rango de la dependencia interna

`cli/package.json` tiene hoy `"@agente-qa/core": "*"` (cualquier versión, incluida ninguna — demasiado laxo para un paquete publicado). Pasa a `"^0.1.0"`, la versión real que se publica de `@agente-qa/core` en el mismo momento. npm workspaces sigue resolviendo la dependencia al símlink local en desarrollo sin importar el rango exacto; el rango solo importa una vez el tarball de `cli` vive fuera del monorepo, consumido como paquete normal.

**Nota para memoria**: si `@agente-qa/core` sube de versión en el futuro, hay que recordar subir este rango en `cli/package.json` a mano — no hay tooling automático de coordinación entre los dos paquetes en v1.

## 4. Permisos de `~/.agente-qa/credentials.json`

`core/src/config/credentials.ts` hoy escribe el fichero de credenciales (API key en texto plano) sin `mode` explícito — hereda el umask del sistema, típicamente legible por el grupo/otros en Linux/Mac.

**Decisión**:
- `fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })` — directorio `~/.agente-qa/` solo accesible por el dueño.
- `fs.writeFile(filePath, ..., { mode: 0o600 })` — fichero solo legible/escribible por el dueño.

En Windows esto es best-effort (NTFS no usa bits de permiso POSIX; Node lo aplica igualmente sin fallar, simplemente no tiene el mismo efecto de seguridad). Como el paquete se publica para que lo instale cualquiera — incluidos usuarios de Mac/Linux, donde sí protege de verdad — el cambio se hace incondicionalmente, sin rama por sistema operativo.

## 5. Auditoría de seguridad obligatoria

Por `CLAUDE.md` ("Seguridad y producción"): tras tocar el manejo de credenciales/API keys y antes de publicar en npm, toca la skill `seguridad-seo` y resolver sus hallazgos — sin auditoría no hay publish. Se ejecuta después de implementar las secciones 3 y 4 de este documento (empaquetado + permisos), antes de cualquier `npm publish` real.

## 6. Mecánica del publish real

1. `npm run build` desde la raíz (compila `core` antes que `cli`, orden ya establecido en el script raíz).
2. Verificación final: `npx vitest run` + `tsc --noEmit` en ambos paquetes en verde (mismo criterio de "hecho" que el resto del proyecto).
3. El usuario ejecuta `npm login` en su propia terminal (flujo OAuth de navegador) — fuera del control de este sistema.
4. Publicar `@agente-qa/core` primero (`npm publish --workspace=core --access public`, el scope `@agente-qa` es público por defecto en un plan gratuito solo si se pasa `--access public` explícitamente — si el scope no existe todavía en la cuenta del usuario, npm puede pedir crear la organización correspondiente en npmjs.com; eso lo resuelve el usuario en el momento, no es algo que se pueda anticipar desde código).
5. Publicar `agente-qa` (CLI) después, una vez `@agente-qa/core@0.1.0` ya está en el registro y el rango `^0.1.0` en `cli/package.json` puede resolverse contra una versión real publicada.
6. Antes de cada uno de los dos `npm publish`, se pide confirmación explícita al usuario en el momento — acción pública e irreversible (no hay "despublicar" real en npm pasadas 72 horas), mismo criterio que ya se usa para `git push` a `origin/main`.

## 7. Manejo de errores

- Fallo de `npm publish` por nombre ya tomado (carrera con otro publisher entre la comprobación y el publish real): se informa al usuario, no se reintenta con un nombre distinto sin preguntar.
- Fallo por scope/organización no autorizada: se informa al usuario con el mensaje real de npm, que ya indica el siguiente paso (crear la org en npmjs.com) — no se intenta automatizar esa creación.
- Cualquier hallazgo de la auditoría `seguridad-seo` bloquea el publish hasta resolverse; no hay "publish con hallazgos pendientes".

## 8. Testing

- Los cambios de `tsconfig.build.json` se verifican ejecutando `npm run build` desde la raíz y comprobando que `dist/` de cada paquete no contiene ningún `*.test.js`/`*.test.d.ts`.
- Los cambios de `credentials.ts` se verifican con un test que, en un entorno POSIX, comprueba el modo real del fichero/directorio creado (`fs.stat(...).mode`); en Windows este test se gatea (`describe.skipIf`) igual que otros tests dependientes de entorno en este proyecto, porque el resultado no es significativo ahí.
- No hay test automatizado posible para el `npm publish` real en sí — es una acción manual, fuera del alcance de la suite.

## 9. Puntos abiertos para specs futuras

- Superficie de plugin de Claude Code (Plan 2) — spec propia cuando se aborde.
- Tooling de versionado coordinado entre `core` y `cli` si el proyecto crece más allá de estos dos paquetes.
- Automatización de release (CI que publique en tag) — no se aborda en v1, publish manual por ahora.
