import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const openaiModelMock = vi.fn((modelId: string) => ({ modelId }));
const createOpenAIMock = vi.fn((..._args: unknown[]) => openaiModelMock);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (...args: unknown[]) => createOpenAIMock(...args),
}));

import { createOpenAIProvider, OPENAI_DEFAULT_MODEL } from "./openai.js";
import { LLMRequestError } from "../errors.js";

describe("createOpenAIProvider", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createOpenAIMock.mockClear();
    openaiModelMock.mockClear();
  });

  it("configures the OpenAI client with the given API key", () => {
    createOpenAIProvider("sk-oa-test");
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "sk-oa-test" });
  });

  it("configures the OpenAI client with a custom baseURL when given (for OpenAI-compatible providers)", () => {
    createOpenAIProvider("sk-oa-test", OPENAI_DEFAULT_MODEL, "https://api.groq.com/openai/v1");
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "sk-oa-test",
      baseURL: "https://api.groq.com/openai/v1",
    });
  });

  it("calls generateText with the default model and returns the text", async () => {
    generateTextMock.mockResolvedValue({ text: "hola" });
    const provider = createOpenAIProvider("sk-oa-test");
    const result = await provider.generate([{ role: "user", content: "hi" }]);

    expect(openaiModelMock).toHaveBeenCalledWith(OPENAI_DEFAULT_MODEL);
    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: OPENAI_DEFAULT_MODEL },
      instructions: undefined,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBe("hola");
  });

  it("passes a leading system message as instructions instead of inside messages", async () => {
    generateTextMock.mockResolvedValue({ text: "hola" });
    const provider = createOpenAIProvider("sk-oa-test");
    await provider.generate([
      { role: "system", content: "Eres un asistente útil." },
      { role: "user", content: "hi" },
    ]);

    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: OPENAI_DEFAULT_MODEL },
      instructions: "Eres un asistente útil.",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("wraps generateText failures in an LLMRequestError naming the provider", async () => {
    const originalError = new Error("network down");
    generateTextMock.mockRejectedValueOnce(originalError);
    const provider = createOpenAIProvider("sk-oa-test");

    const promise = provider.generate([{ role: "user", content: "hi" }]);
    await expect(promise).rejects.toBeInstanceOf(LLMRequestError);
    await expect(promise).rejects.toThrow(/OpenAI/);
    await promise.catch((err: unknown) => {
      expect((err as { cause?: unknown }).cause).toBe(originalError);
    });
  });
});
