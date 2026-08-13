import { describe, it, expect } from "vitest";
import { ExplorerActionSchema } from "./explorerAction.js";

describe("ExplorerActionSchema", () => {
  it("accepts each valid action shape", () => {
    const valid = [
      { action: "goto", target: "/login" },
      { action: "click", role: "button", name: "Iniciar sesión" },
      { action: "fill_credential", labelText: "Email", field: "username" },
      { action: "done" },
      { action: "fail", reason: "no se encuentra el formulario" },
    ];
    for (const candidate of valid) {
      expect(ExplorerActionSchema.safeParse(candidate).success).toBe(true);
    }
  });

  it("rejects a click action with a role outside the known clickable set", () => {
    const result = ExplorerActionSchema.safeParse({ action: "click", role: "heading", name: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown action name", () => {
    const result = ExplorerActionSchema.safeParse({ action: "scroll" });
    expect(result.success).toBe(false);
  });
});
