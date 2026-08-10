import { describe, it, expect } from "vitest";
import * as core from "./index.js";

describe("@agente-qa/core public API", () => {
  it("exports the config functions", () => {
    expect(typeof core.saveCredentials).toBe("function");
    expect(typeof core.loadCredentials).toBe("function");
    expect(typeof core.saveProjectConfig).toBe("function");
    expect(typeof core.loadProjectConfig).toBe("function");
  });

  it("exports the LLM provider factory and fake test double", () => {
    expect(typeof core.createProvider).toBe("function");
    expect(typeof core.FakeLLMProvider).toBe("function");
  });

  it("exports LLMRequestError", () => {
    expect(typeof core.LLMRequestError).toBe("function");
  });

  it("exports the pattern registry", () => {
    expect(typeof core.loadAllPatterns).toBe("function");
    expect(typeof core.saveProjectPattern).toBe("function");
  });

  it("exports the intake orchestrator", () => {
    expect(typeof core.runIntake).toBe("function");
  });
});
