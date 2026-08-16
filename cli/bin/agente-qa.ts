#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "../src/commands/init.js";
import { runMapCommand } from "../src/commands/map.js";
import { runMenuLoop } from "../src/menu.js";
import {
  realInitPrompts,
  realMenuPrompts,
  buildRealChatPrompts,
  buildRealGeneratorPrompts,
  buildRealExecutorPrompts,
  buildRealReportesPrompts,
} from "../src/prompts/inquirerPrompts.js";

const program = new Command();
program.name("agente-qa").description("Asistente agéntico de automatización de QA");

program
  .command("init")
  .description("Configura las preferencias del proyecto y crea la plantilla de .env si falta")
  .action(async () => {
    const result = await runInit(realInitPrompts, process.cwd());
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
  });

program
  .command("map")
  .description("Mapea la aplicación y genera Page Objects (Agente 1)")
  .action(async () => {
    await runMapCommand(process.cwd());
  });

program
  .command("chat")
  .description("Inicia la conversación con Agente_QA")
  .action(async () => {
    await runMenuLoop({
      menuPrompts: realMenuPrompts,
      chatPrompts: buildRealChatPrompts(),
      initPrompts: realInitPrompts,
      generatorPrompts: buildRealGeneratorPrompts(),
      executorPrompts: buildRealExecutorPrompts(),
      reportesPrompts: buildRealReportesPrompts(),
      projectRoot: process.cwd(),
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
