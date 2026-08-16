import type { AgentEvent } from "@agente-qa/core";

const MARKS: Record<AgentEvent["status"], string> = {
  start: "·",
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  info: "·",
};

export function formatAgentEvent(event: AgentEvent): string {
  const indent = "  ".repeat(event.depth + 1);
  const detail = event.detail ? ` — ${event.detail}` : "";
  const duration = event.durationMs === undefined ? "" : ` · ${(event.durationMs / 1000).toFixed(1)}s`;
  return `${indent}${MARKS[event.status]} ${event.message}${detail}${duration}`;
}
