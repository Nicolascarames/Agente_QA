export type AgentId = "explorador" | "intake" | "generador" | "ejecutor" | "reportes";

/** `start` opens a step, `ok`/`fail` close one, `warn`/`info` stand alone. */
export type EventStatus = "start" | "ok" | "fail" | "warn" | "info";

export interface AgentEvent {
  agent: AgentId;
  status: EventStatus;
  /** Indentation level. 0 is a top-level step of the agent. */
  depth: number;
  message: string;
  detail?: string;
  durationMs?: number;
}

/**
 * The channel is one-way: it carries progress OUT of core and never asks
 * anything. Questions keep crossing each agent's own callbacks, which are
 * bidirectional by nature.
 */
export type EmitEvent = (event: AgentEvent) => void;

export const noopEmit: EmitEvent = () => {};
