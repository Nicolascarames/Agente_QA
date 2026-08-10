import { select, input, password } from "@inquirer/prompts";
import type { ProviderName } from "@agente-qa/core";
import type { InitPrompts, MenuPrompts, MenuChoice, ChatPrompts } from "./types.js";

export const realInitPrompts: InitPrompts = {
  async selectProvider() {
    return select<ProviderName>({
      message: "¿Qué proveedor de LLM quieres usar?",
      choices: [
        { name: "Anthropic (Claude)", value: "anthropic" },
        { name: "OpenAI", value: "openai" },
        { name: "Google", value: "google" },
      ],
    });
  },
  async inputApiKey(provider) {
    return password({ message: `Pega tu API key de ${provider}:` });
  },
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
  };
}
