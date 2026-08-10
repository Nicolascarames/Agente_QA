#!/usr/bin/env node
import { Command } from "commander";
import os from "node:os";
import { runInit } from "../src/commands/init.js";
import { runMenuLoop } from "../src/menu.js";
import { realInitPrompts, realMenuPrompts, buildRealChatPrompts } from "../src/prompts/inquirerPrompts.js";

const program = new Command();
program.name("agente-qa").description("Asistente agéntico de automatización de QA");

program
  .command("init")
  .description("Configura credenciales y preferencias del proyecto")
  .action(async () => {
    await runInit(realInitPrompts, os.homedir(), process.cwd());
    console.log("Configuración guardada.");
  });

program
  .command("chat")
  .description("Inicia la conversación con Agente_QA")
  .action(async () => {
    await runMenuLoop({
      menuPrompts: realMenuPrompts,
      chatPrompts: buildRealChatPrompts(),
      initPrompts: realInitPrompts,
      homeDir: os.homedir(),
      projectRoot: process.cwd(),
    });
  });

program.parseAsync(process.argv);
