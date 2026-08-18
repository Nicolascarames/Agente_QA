import { select, input, checkbox } from "@inquirer/prompts";
import { pageObjectMethodNamesForLocator } from "@agente-qa/core";
import type {
  InitPrompts,
  MenuPrompts,
  MenuChoice,
  ChatPrompts,
  GeneratorPrompts,
  ExecutorPrompts,
  ReportesPrompts,
} from "./types.js";

export const realInitPrompts: InitPrompts = {
  async inputTestsDir() {
    return input({
      message: "¿En qué carpeta guardamos los tests? (relativa al proyecto)",
      // Default inside .agente-qa/ so everything this tool owns lives in one
      // folder: config, credentials, the map, the emitted Page Objects and the
      // generated tests. pytest never sees the leading dot — runEjecutor runs
      // with cwd set to this directory, so the dotted segment is above cwd and
      // `norecursedirs` (which skips `.*`) does not apply.
      default: ".agente-qa/tests",
    });
  },
  async confirmHeadedMode() {
    return select<boolean>({
      message: "¿Ejecutar los tests con el navegador visible?",
      choices: [
        { name: "No, en segundo plano (recomendado)", value: false },
        { name: "Sí, ver el navegador mientras corren", value: true },
      ],
      default: false,
    });
  },
  async inputAppUrl() {
    return input({
      message: "¿Cuál es la URL de la aplicación que vas a probar?",
      validate: (value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return "Introduce una URL válida (ej. https://mi-app.com)";
        }
        if (url.username !== "" || url.password !== "") {
          return 'La URL no puede incluir usuario/contraseña (ej. "https://usuario:clave@host"). Ese archivo se sube a git: guarda las credenciales de test en el .env del proyecto, no aquí.';
        }
        return true;
      },
    });
  },
  async selectAppLanguage() {
    return select<"es" | "en">({
      message: "¿En qué idioma está la interfaz de la aplicación?",
      choices: [
        { name: "Español", value: "es" },
        { name: "Inglés", value: "en" },
      ],
      default: "es",
    });
  },
  async inputRoute(label) {
    return input({ message: `¿Cuál es la ruta de ${label}? (relativa, ej. /login — déjalo vacío si no lo sabes)`, default: label.includes("home") ? "/" : "" });
  },
  async promptAdditionalRoutes() {
    const routes: Record<string, string> = {};
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const addMore = await select<boolean>({
        message: Object.keys(routes).length === 0 ? "¿Quieres añadir alguna otra ruta?" : "¿Añadir otra ruta más?",
        choices: [
          { name: "No", value: false },
          { name: "Sí", value: true },
        ],
        default: false,
      });
      if (!addMore) break;
      const name = await input({ message: "Nombre de la ruta (ej. checkout, dashboard):" });
      const routePath = await input({ message: `¿Cuál es la ruta de "${name}"?` });
      routes[name] = routePath;
    }
    return routes;
  },
  async selectGitignoreEntries(candidates) {
    return checkbox({
      message: "¿Qué añado al .gitignore del proyecto?",
      choices: candidates.map((entry) => ({ name: entry, value: entry, checked: true })),
    });
  },
};

export const realMenuPrompts: MenuPrompts = {
  async selectMenuChoice() {
    return select<MenuChoice>({
      message: "¿Qué quieres hacer?",
      choices: [
        { name: "Mapear aplicación (Agente 1)", value: "map" },
        { name: "Crear plan de pruebas desde un texto (Agente 2)", value: "create-plan" },
        { name: "Generar tests Playwright desde un plan aprobado (Agente 3)", value: "generate-tests" },
        { name: "Ejecutar tests (Agente 4)", value: "run-tests" },
        { name: "Ver/generar reportes (Agente 5)", value: "reports" },
        { name: "Configuración", value: "config" },
        { name: "Salir", value: "exit" },
      ],
    });
  },
};

export function buildRealChatPrompts(): ChatPrompts {
  return {
    async inputInitialText() {
      return input({ message: "¿Qué quieres probar? (pega el texto o descríbelo, o déjalo vacío para elegir entre las sugerencias del mapa)" });
    },
    async askUser(question) {
      return input({ message: question });
    },
    async chooseScenario(candidates) {
      const WRITE_OWN = "__write_own__";
      const choice = await select<string>({
        message: "El mapa sugiere estos escenarios. ¿Cuál usamos?",
        choices: [
          ...candidates.map((c) => ({ name: `${c.title} — ${c.rationale}`, value: c.id })),
          { name: "Prefiero escribir mi propia petición", value: WRITE_OWN },
        ],
      });
      if (choice === WRITE_OWN) return null;
      return candidates.find((c) => c.id === choice) ?? null;
    },
    async presentForApproval(featureText) {
      console.log(`\n${featureText}\n`);
      const approved = await select({
        message: "¿Apruebas este plan?",
        choices: [
          { name: "Sí, aprobar", value: true },
          { name: "No, pedir cambios", value: false },
        ],
      });
      if (approved) return { approved: true };
      const feedback = await input({ message: "¿Qué cambios quieres?" });
      return { approved: false, feedback };
    },
    async confirmOverwrite(filePath) {
      return select({
        message: `Ya existe un archivo en ${filePath}. ¿Lo sobrescribo?`,
        choices: [
          { name: "Sí", value: true },
          { name: "No", value: false },
        ],
      });
    },
  };
}

export function buildRealGeneratorPrompts(): GeneratorPrompts {
  return {
    async selectFeatureFile(files) {
      if (files.length === 1) return files[0];
      return select({
        message: "¿Qué plan de pruebas (.feature) quieres convertir en tests?",
        choices: files.map((f) => ({ name: f, value: f })),
      });
    },
    async confirmOverwrite(filePath) {
      return select({
        message: `Ya existe un archivo en ${filePath}. ¿Lo sobrescribo?`,
        choices: [
          { name: "Sí", value: true },
          { name: "No", value: false },
        ],
      });
    },
    async onStaleLocator(stale) {
      const [item] = stale;
      // count === 0 here is never "matches 0 elements" (that is a WARNING, not
      // a stale-locator failure — see checkMapFreshness) — it means the
      // verifier's failure text carried no count at all (a navigation error, a
      // traceback), so "ya no es único: coincide con 0 elementos" would be
      // self-contradictory. Word the zero case as what it actually is.
      const description =
        item.count === 0
          ? "ya no se ha podido resolver en la aplicación real"
          : `ya no es único en la aplicación real: ahora coincide con ${item.count} elemento(s)`;
      console.log(`\n⚠ El localizador "${item.name}" de la pantalla "${item.screenId}" ${description}.`);
      const action = await select<"remap" | "override">({
        message: "¿Cómo lo solucionamos?",
        choices: [
          { name: "Volver a mapear la aplicación (agente-qa map)", value: "remap" },
          { name: "Escribir yo mismo la expresión Playwright correcta", value: "override" },
        ],
      });
      if (action === "remap") return { action: "remap" };
      const python = await input({
        message: `Expresión Playwright para "${item.name}" (ej. page.get_by_test_id("login-submit")):`,
      });
      return { action: "override", python };
    },
    async onAmbiguousLocator(step) {
      console.log(
        `\n⚠ El texto "${step.quoted}" de la pantalla "${step.screenName}" coincide con ${step.candidates.length} elementos del mapa. Elige a cuál se refiere el paso.`
      );
      // Read-only dump: the user decides with every fact the map holds, and
      // nothing here edits map.json or the Page Object.
      for (const candidate of step.candidates) {
        // The method list comes from pageObjectMethodNamesForLocator (core), the
        // same function emitPageObject uses to decide what to emit — never a
        // hardcoded get_/click_ pair, which would lie for an input (fill_, not
        // click_) or a text/heading (get_ only, no click_ at all).
        const methods = pageObjectMethodNamesForLocator(candidate)
          .map((name) => `${name}()`)
          .join(" / ");
        console.log(`\n  ${candidate.name}   →   Page Object: ${methods}`);
        console.log(`    kind:            ${candidate.kind}`);
        console.log(`    accessibleName:  ${JSON.stringify(candidate.accessibleName ?? null)}`);
        console.log(`    python:          ${candidate.python}`);
        console.log(`    count:           ${candidate.count}`);
        console.log(`    disambiguatedBy: ${candidate.disambiguatedBy ?? "(ninguno)"}`);
        console.log(`    attributes:      ${JSON.stringify(candidate.attributes ?? {})}`);
        console.log(`    verifiedAt:      ${candidate.verifiedAt}`);
        if (candidate.stateId) console.log(`    stateId:         ${candidate.stateId}`);
      }
      const name = await select<string>({
        message: `¿A cuál se refiere "${step.quoted}"?`,
        choices: step.candidates.map((c) => ({ name: c.name, value: c.name })),
      });
      return step.candidates.find((c) => c.name === name)!;
    },
  };
}

export function buildRealExecutorPrompts(): ExecutorPrompts {
  return {
    async selectTags(availableTags) {
      return checkbox({
        message: "¿Qué tags quieres lanzar? (marca todos para lanzar todo)",
        choices: availableTags.map((tag) => ({ name: tag, value: tag })),
        required: true,
      });
    },
    async selectCaptureMode() {
      return select<"off" | "only-on-failure" | "always">({
        message: "¿Capturas de pantalla y vídeo?",
        choices: [
          { name: "Solo en fallo (recomendado)", value: "only-on-failure" },
          { name: "Siempre", value: "always" },
          { name: "Nunca", value: "off" },
        ],
        default: "only-on-failure",
      });
    },
  };
}

export function buildRealReportesPrompts(): ReportesPrompts {
  return {
    async selectDetailLevel() {
      return select<"resumen" | "completo">({
        message: "¿Qué nivel de detalle quieres en el resumen?",
        choices: [
          { name: "Resumen (conteos + fallos)", value: "resumen" },
          { name: "Completo (+ listado de tests pasados)", value: "completo" },
        ],
        default: "resumen",
      });
    },
  };
}
