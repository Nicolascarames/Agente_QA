import { describe, it, expect } from "vitest";
import { explorerActionPrompt } from "./explorer.js";

describe("explorerActionPrompt", () => {
  it("includes the feature text, current URL, and snapshot", () => {
    const prompt = explorerActionPrompt("Feature: Login\n", "https://example.com/login", 'textbox "Email"', true);
    expect(prompt).toContain("Feature: Login");
    expect(prompt).toContain("https://example.com/login");
    expect(prompt).toContain('textbox "Email"');
  });

  it("mentions fill_credential is available when credentials are present", () => {
    const prompt = explorerActionPrompt("Feature: x\n", "https://x.com", "", true);
    expect(prompt).toContain("fill_credential");
    expect(prompt).toContain('"username" o "password"');
  });

  it("tells the model not to request credentials when none are configured", () => {
    const prompt = explorerActionPrompt("Feature: x\n", "https://x.com", "", false);
    expect(prompt).toContain("No hay credenciales de prueba configuradas");
  });

  it("mentions the previous action's outcome when provided", () => {
    const prompt = explorerActionPrompt("Feature: x\n", "https://x.com", "", true, 'no se encontró ningún "button" con nombre "Enviar"');
    expect(prompt).toContain("La acción anterior no tuvo el efecto esperado");
    expect(prompt).toContain('no se encontró ningún "button" con nombre "Enviar"');
  });

  it("says nothing about a previous outcome when none is provided", () => {
    const prompt = explorerActionPrompt("Feature: x\n", "https://x.com", "", true);
    expect(prompt).not.toContain("La acción anterior");
  });
});
