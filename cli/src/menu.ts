import type {
  MenuPrompts,
  ChatPrompts,
  InitPrompts,
  GeneratorPrompts,
  ExecutorPrompts,
  ReportesPrompts,
} from "./prompts/types.js";
import { runCreatePlan } from "./commands/chat.js";
import { runInit } from "./commands/init.js";
import { runGenerateTests } from "./commands/generate.js";
import { runExecuteTests } from "./commands/execute.js";
import { runGenerateReports } from "./commands/reports.js";
import { runMapCommand } from "./commands/map.js";

export interface MenuDeps {
  menuPrompts: MenuPrompts;
  chatPrompts: ChatPrompts;
  initPrompts: InitPrompts;
  generatorPrompts: GeneratorPrompts;
  executorPrompts: ExecutorPrompts;
  reportesPrompts: ReportesPrompts;
  projectRoot: string;
}

export async function runMenuLoop(deps: MenuDeps): Promise<void> {
  console.log("Soy Agente_QA. ¿Qué quieres hacer?");
  let running = true;

  while (running) {
    const choice = await deps.menuPrompts.selectMenuChoice();

    switch (choice) {
      case "map": {
        await runMapCommand(deps.projectRoot);
        break;
      }
      case "create-plan": {
        try {
          const filePath = await runCreatePlan(deps.chatPrompts, deps.projectRoot);
          console.log(`Plan guardado en ${filePath}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "generate-tests": {
        try {
          const writtenPaths = await runGenerateTests(deps.generatorPrompts, deps.projectRoot);
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
      case "reports": {
        try {
          const result = await runGenerateReports(deps.reportesPrompts, deps.projectRoot);
          console.log(
            `Resumen: ${result.passed} pasados, ${result.failed} fallidos, ${result.skipped} omitidos (${result.totalTests} en total).`
          );
          console.log(`Resumen Markdown: ${result.summaryPath}`);
          console.log(`Reporte extendido (HTML): ${result.htmlReportPath}`);
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "config": {
        try {
          const result = await runInit(deps.initPrompts, deps.projectRoot);
          console.log("Configuración de tests guardada.");
          if (result.envCreated) {
            console.log(
              `Se ha creado ${result.envPath} — rellena las variables a mano antes de usar el resto de comandos.`
            );
          } else {
            console.log(`Ya existía ${result.envPath} — revísalo si quieres cambiar algo.`);
          }
          if (result.gitignoreEntriesAdded.length > 0) {
            console.log(`Añadido al .gitignore: ${result.gitignoreEntriesAdded.join(", ")}`);
          }
        } catch (err) {
          console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "exit":
        running = false;
        break;
    }
  }
}
