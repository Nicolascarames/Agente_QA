import { confirm, checkbox } from "@inquirer/prompts";
import {
  createRealCrawler, runExplorador as runExploradorReal,
  loadProjectConfig, loadProjectEnv, type AgentEvent, type LLMProvider,
} from "@agente-qa/core";
import { formatAgentEvent } from "../util/renderEvent.js";
import { buildLlm as buildLlmReal } from "../util/buildLlm.js";

export interface MapCommandDeps {
  runExplorador: typeof runExploradorReal;
  loadConfig: typeof loadProjectConfig;
  loadEnv: typeof loadProjectEnv;
  buildLlm: (projectRoot: string) => Promise<LLMProvider>;
  log: (message: string) => void;
}

const realDeps: MapCommandDeps = {
  runExplorador: runExploradorReal,
  loadConfig: loadProjectConfig,
  loadEnv: loadProjectEnv,
  buildLlm: buildLlmReal,
  log: (message) => console.log(message),
};

export async function runMapCommand(projectRoot: string, deps: MapCommandDeps = realDeps): Promise<void> {
  try {
    const config = await deps.loadConfig(projectRoot);
    if (!config) {
      deps.log("No hay configuración de proyecto. Ejecuta 'agente-qa init' primero.");
      return;
    }
    const env = await deps.loadEnv(projectRoot);

    deps.log("\nMapeo de la aplicación (Agente 1)");
    deps.log("Usa SIEMPRE una cuenta de pruebas: el recorrido autenticado captura lo que esa");
    deps.log("cuenta ve, y el mapa se guarda en el git del proyecto.\n");

    const result = await deps.runExplorador({
      crawler: createRealCrawler(),
      llm: await deps.buildLlm(projectRoot),
      projectRoot,
      testsDir: config.testsDir,
      baseUrl: config.appUrl,
      limits: config.crawl,
      credentials:
        env?.testUsername && env?.testPassword
          ? { username: env.testUsername, password: env.testPassword }
          : undefined,
      headed: config.headedMode,
      callbacks: {
        confirmContinueOnLoop: async ({ urlTemplate, repeats }) => {
          return confirm({
            default: false,
            message: `"${urlTemplate}" se repite ${repeats} veces con la misma estructura. ¿Sigo explorando por ahí?`,
          });
        },
        approveWriteActions: async (actions) => {
          if (actions.length === 0) return [];
          const elegidas = await checkbox<string>({
            message: "Estas acciones envían formularios y pueden modificar datos. ¿Cuáles puedo ejecutar?",
            choices: actions.map((a) => ({ name: `${a.screenId} · ${a.action.label}`, value: `${a.screenId}::${a.action.locator}` })),
          });
          return elegidas.map((value) => {
            const [screenId, locator] = value.split("::");
            return { screenId, locator };
          });
        },
        confirmOverwrite: async (filePath) => {
          return confirm({
            default: true,
            message: `Ya existe ${filePath}. ¿Lo sobrescribo?`,
          });
        },
        onOrphanOverride: (override) => {
          deps.log(`  ⚠ Corrección manual huérfana: ${override.screenId}.${override.name} ya no existe en el mapa.`);
        },
      },
      emit: (event: AgentEvent) => deps.log(formatAgentEvent(event)),
    });
    deps.log(`\nMapa listo: ${result.mapPath}`);
    deps.log(`Page Objects escritos: ${result.writtenPaths.length}`);
  } catch (err) {
    deps.log(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  }
}
