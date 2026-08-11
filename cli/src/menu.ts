import type {
  MenuPrompts,
  ChatPrompts,
  InitPrompts,
  GeneratorPrompts,
  ExecutorPrompts,
} from "./prompts/types.js";
import { runCreatePlan } from "./commands/chat.js";
import { runInit } from "./commands/init.js";
import { runGenerateTests } from "./commands/generate.js";
import { runExecuteTests } from "./commands/execute.js";

export interface MenuDeps {
  menuPrompts: MenuPrompts;
  chatPrompts: ChatPrompts;
  initPrompts: InitPrompts;
  generatorPrompts: GeneratorPrompts;
  executorPrompts: ExecutorPrompts;
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
        try {
          const filePath = await runCreatePlan(deps.chatPrompts, deps.homeDir, deps.projectRoot);
          console.log(`Plan guardado en ${filePath}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "generate-tests": {
        try {
          const writtenPaths = await runGenerateTests(deps.generatorPrompts, deps.homeDir, deps.projectRoot);
          console.log(`Tests generados:\n${writtenPaths.join("\n")}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "run-tests": {
        try {
          const result = await runExecuteTests(deps.executorPrompts, deps.projectRoot);
          let status: string;
          switch (result.exitCode) {
            case 0:
              status = "Todos los tests pasaron.";
              break;
            case 1:
              status = "Algunos tests fallaron.";
              break;
            case 5:
              status = "No se ejecutó ningún test (revisa el filtro de tags seleccionado).";
              break;
            default:
              status = `La ejecución de pytest no se completó correctamente (código de salida ${result.exitCode}).`;
              break;
          }
          console.log(`${status} Resultados en ${result.junitXmlPath}`);
          if (result.browserSetupWarning) {
            console.log(result.browserSetupWarning);
          }
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "config": {
        try {
          await runInit(deps.initPrompts, deps.homeDir, deps.projectRoot);
          console.log("Configuración actualizada.");
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "reports":
        console.log("Todavía no implementado en esta versión.");
        break;
      case "exit":
        running = false;
        break;
    }
  }
}
