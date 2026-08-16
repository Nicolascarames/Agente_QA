import { describe, it, expect } from "vitest";
import { noopEmit, type AgentEvent } from "./agentEvent.js";

describe("noopEmit", () => {
  it("accepts an event and returns undefined", () => {
    const event: AgentEvent = { agent: "explorador", status: "ok", depth: 0, message: "listo" };
    expect(noopEmit(event)).toBeUndefined();
  });
});
