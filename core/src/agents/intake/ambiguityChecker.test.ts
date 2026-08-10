import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { checkAmbiguity } from "./ambiguityChecker.js";

describe("checkAmbiguity", () => {
  it("returns ambiguous=false with no questions when the model says so", async () => {
    const llm = new FakeLLMProvider(['{"ambiguous": false, "questions": []}']);
    const result = await checkAmbiguity("Probar el login con usuario y contraseña válidos", llm);
    expect(result).toEqual({ ambiguous: false, questions: [] });
  });

  it("returns the clarifying questions when the model flags ambiguity", async () => {
    const llm = new FakeLLMProvider([
      '{"ambiguous": true, "questions": ["¿Qué navegador?", "¿Qué URL?"]}',
    ]);
    const result = await checkAmbiguity("Probar que funciona", llm);
    expect(result.ambiguous).toBe(true);
    expect(result.questions).toEqual(["¿Qué navegador?", "¿Qué URL?"]);
  });

  it("sends the text inside the prompt to the model", async () => {
    const llm = new FakeLLMProvider(['{"ambiguous": false, "questions": []}']);
    await checkAmbiguity("mi petición concreta", llm);
    const userMessage = llm.receivedCalls[0].find((m) => m.role === "user");
    expect(userMessage?.content).toContain("mi petición concreta");
  });
});
