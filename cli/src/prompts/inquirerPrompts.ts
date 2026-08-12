import { select, input, checkbox } from "@inquirer/prompts";
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
    return input({ message: "¿En qué carpeta guardamos los tests? (relativa al proyecto)", default: "tests" });
  },
};

export const realMenuPrompts: MenuPrompts = {
  async selectMenuChoice() {
    return select<MenuChoice>({
      message: "¿Qué quieres hacer?",
      choices: [
        { name: "Crear plan de pruebas desde un texto", value: "create-plan" },
        { name: "Generar tests Playwright desde un plan aprobado", value: "generate-tests" },
        { name: "Ejecutar tests", value: "run-tests" },
        { name: "Ver/generar reportes", value: "reports" },
        { name: "Configuración", value: "config" },
        { name: "Salir", value: "exit" },
      ],
    });
  },
};

export function buildRealChatPrompts(): ChatPrompts {
  return {
    async inputInitialText() {
      return input({ message: "¿Qué quieres probar? (pega el texto o descríbelo)" });
    },
    async askUser(question) {
      return input({ message: question });
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
    async offerSavePattern() {
      const save = await select({
        message: "Esto parece un patrón reusable. ¿Lo guardo para la próxima vez?",
        choices: [
          { name: "Sí", value: true },
          { name: "No", value: false },
        ],
      });
      if (!save) return { save: false };
      const name = await input({ message: "Nombre del patrón:" });
      const description = await input({ message: "Descripción breve:" });
      return { save: true, name, description };
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
