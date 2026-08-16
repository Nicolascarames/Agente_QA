import { describe, it, expect } from "vitest";
import { formatAgentEvent } from "./renderEvent.js";

describe("formatAgentEvent", () => {
  it("marks a successful step with a check and no indentation at depth 0", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "ok", depth: 0, message: "Navegador abierto" }))
      .toBe("  ✓ Navegador abierto");
  });

  it("indents two extra spaces per depth level", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "ok", depth: 2, message: "6 textos anotados" }))
      .toBe("      ✓ 6 textos anotados");
  });

  it("uses a cross for failures and a warning sign for warnings", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "fail", depth: 0, message: "roto" })).toContain("✗ roto");
    expect(formatAgentEvent({ agent: "explorador", status: "warn", depth: 0, message: "ojo" })).toContain("⚠ ojo");
  });

  it("appends the duration in seconds when present", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "ok", depth: 0, message: "Ruta 1", durationMs: 900 }))
      .toBe("  ✓ Ruta 1 · 0.9s");
  });

  it("appends the detail after the message when present", () => {
    expect(formatAgentEvent({ agent: "explorador", status: "warn", depth: 1, message: "Ambiguo", detail: "2 elementos" }))
      .toBe("    ⚠ Ambiguo — 2 elementos");
  });
});
