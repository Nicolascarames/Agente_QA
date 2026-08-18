import type { EmitEvent } from "../events/agentEvent.js";
import type { AppMap, WriteAction } from "./schema.js";

export interface CrawlCredentials {
  username: string;
  password: string;
}

export interface CrawlLimits {
  maxScreens: number;
  maxDepth: number;
  maxDurationMinutes: number;
  loopSuspicionThreshold: number;
  excludeRoutes: string[];
  /** Cuántas acciones desde una pantalla direccionable explora el crawler dentro de una vista SPA. */
  maxViewDepth: number;
}

export interface CrawlCallbacks {
  /**
   * Called when N consecutive screens share a signature. Answering false prunes
   * that branch only; the crawl continues elsewhere.
   */
  confirmContinueOnLoop(context: { urlTemplate: string; repeats: number }): Promise<boolean>;
  /** The user picks which write actions the second pass may execute. Never bypassable. */
  approveWriteActions(actions: { screenId: string; action: WriteAction }[]): Promise<{ screenId: string; locator: string }[]>;
}

export interface CrawlInput {
  baseUrl: string;
  credentials?: CrawlCredentials;
  limits: CrawlLimits;
  headed?: boolean;
  callbacks: CrawlCallbacks;
  emit: EmitEvent;
}

export type CrawlResult = { ok: true; map: AppMap } | { ok: false; error: string };

export interface Crawler {
  crawl(input: CrawlInput): Promise<CrawlResult>;
}

export class MissingCrawlerToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCrawlerToolError";
  }
}
