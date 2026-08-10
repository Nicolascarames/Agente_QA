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

  it("calls generateText with the default model and returns the text", async () => {
    generateTextMock.mockResolvedValue({ text: "hola" });
    const provider = createOpenAIProvider("sk-oa-test");
    const result = await provider.generate([{ role: "user", content: "hi" }]);

    expect(openaiModelMock).toHaveBeenCalledWith(OPENAI_DEFAULT_MODEL);
    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: OPENAI_DEFAULT_MODEL },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBe("hola");
  });
});
