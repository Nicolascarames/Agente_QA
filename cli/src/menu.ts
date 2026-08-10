import type { MenuPrompts, ChatPrompts, InitPrompts } from "./prompts/types.js";
import { runCreatePlan } from "./commands/chat.js";
import { runInit } from "./commands/init.js";

export interface MenuDeps {
  menuPrompts: MenuPrompts;
  chatPrompts: ChatPrompts;
  initPrompts: InitPrompts;
  homeDir: string;
  projectRoot: string;
}

export async function runMenuLoop(deps: MenuDeps): Promise<void> {
  console.log("Soy Agente_QA. ¿Qué quieres hacer?");
  let running = true;

  while (running) {
    const choice = await deps.menuPrompts.selectMenuChoice();

    switch (choice) {
      case "create-plan": {
        const filePath = await runCreatePlan(deps.chatPrompts, deps.homeDir, deps.projectRoot);
        console.log(`Plan guardado en ${filePath}`);
        break;
      }
      case "config": {
        await runInit(deps.initPrompts, deps.homeDir, deps.projectRoot);
        console.log("Configuración actualizada.");
        break;
      }
      case "generate-tests":
      case "run-tests":
      case "reports":
        console.log("Todavía no implementado en esta versión.");
        break;
      case "exit":
        running = false;
        break;
    }
  }
}
