import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const anthropicModelMock = vi.fn((modelId: string) => ({ modelId }));
const createAnthropicMock = vi.fn((..._args: unknown[]) => anthropicModelMock);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: (...args: unknown[]) => createAnthropicMock(...args),
}));

import { createAnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "./anthropic.js";

describe("createAnthropicProvider", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createAnthropicMock.mockClear();
    anthropicModelMock.mockClear();
  });

  it("configures the Anthropic client with the given API key", () => {
    createAnthropicProvider("sk-ant-test");
    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: "sk-ant-test" });
  });

  it("calls generateText with the default model and returns the text", async () => {
    generateTextMock.mockResolvedValue({ text: "hola" });
    const provider = createAnthropicProvider("sk-ant-test");
    const result = await provider.generate([{ role: "user", content: "hi" }]);

    expect(anthropicModelMock).toHaveBeenCalledWith(ANTHROPIC_DEFAULT_MODEL);
    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: ANTHROPIC_DEFAULT_MODEL },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBe("hola");
  });
});
