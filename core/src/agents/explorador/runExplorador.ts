import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmitEvent } from "../../events/agentEvent.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { Crawler, CrawlCallbacks, CrawlCredentials, CrawlLimits } from "../../appMap/crawler.js";
import type { AppMap, LocatorOverride } from "../../appMap/schema.js";
import { saveAppMap } from "../../appMap/mapStore.js";
import { applyOverrides, loadOverrides } from "../../appMap/overrides.js";
import { redactMap } from "../../appMap/redact.js";
import { emitPageObject } from "../../appMap/pageObjectEmitter.js";
import { generateScenarioCandidates } from "./scenarioCandidates.js";

export interface ExploradorCallbacks extends CrawlCallbacks {
  confirmOverwrite(filePath: string): Promise<boolean>;
  onOrphanOverride(override: LocatorOverride): void;
}

export interface RunExploradorOptions {
  crawler: Crawler;
  llm: LLMProvider;
  projectRoot: string;
  testsDir: string;
  baseUrl: string;
  limits: CrawlLimits;
  credentials?: CrawlCredentials;
  headed?: boolean;
  callbacks: ExploradorCallbacks;
  emit: EmitEvent;
}

export interface ExploradorResult {
  map: AppMap;
  mapPath: string;
  writtenPaths: string[];
}

export async function runExplorador(options: RunExploradorOptions): Promise<ExploradorResult> {
  const { crawler, llm, projectRoot, testsDir, baseUrl, limits, credentials, headed, callbacks, emit } = options;

  emit({ agent: "explorador", status: "start", depth: 0, message: "Mapeo de la aplicación" });

  const crawled = await crawler.crawl({
    baseUrl, credentials, limits, headed,
    callbacks: {
      confirmContinueOnLoop: callbacks.confirmContinueOnLoop,
      approveWriteActions: callbacks.approveWriteActions,
    },
    emit,
  });
  if (!crawled.ok) throw new Error(`No se pudo mapear la aplicación: ${crawled.error}`);

  const scenarios = await generateScenarioCandidates(crawled.map, llm);
  emit({ agent: "explorador", status: "ok", depth: 1, message: `${scenarios.length} escenario(s) candidato(s)` });

  const secrets = credentials ? [credentials.username, credentials.password] : [];
  const withScenarios: AppMap = { ...crawled.map, scenarios };
  const { map: patched, orphans } = applyOverrides(withScenarios, await loadOverrides(projectRoot));
  for (const orphan of orphans) callbacks.onOrphanOverride(orphan);

  const safe = redactMap(patched, secrets);
  const mapPath = await saveAppMap(projectRoot, safe);
  emit({ agent: "explorador", status: "ok", depth: 1, message: `Mapa guardado en ${mapPath}` });

  const writtenPaths: string[] = [];
  for (const screen of safe.screens) {
    const emitted = emitPageObject(screen);
    const target = path.join(projectRoot, testsDir, emitted.path);
    const exists = await fs.access(target).then(() => true, () => false);
    if (exists && !(await callbacks.confirmOverwrite(target))) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, emitted.content, "utf-8");
    writtenPaths.push(target);
  }

  emit({
    agent: "explorador", status: "ok", depth: 0,
    message: `${safe.stats.screens} pantalla(s) · ${safe.stats.locators} localizador(es) · ${safe.stats.ambiguous} ambiguo(s)`,
    durationMs: safe.stats.durationMs,
  });

  return { map: safe, mapPath, writtenPaths };
}
