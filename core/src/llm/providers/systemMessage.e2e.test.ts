import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

// Only the provider SDK's client factory is mocked (to avoid a real network call) —
// `ai`'s own `generateText` runs for real here, so its prompt validation (the thing
// that broke in production: a role:"system" message embedded in `messages` throws
// "System messages are not allowed..." unless passed via `instructions` instead)
// actually executes against our code, unlike the other provider tests in this
// directory, which mock `generateText` itself and can't catch this class of bug.

const MOCK_RESULT: LanguageModelV3GenerateResult = {
  finishReason: { unified: "stop", raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
  content: [{ type: "text", text: "hola" }],
  warnings: [],
};

function makeMockModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => MOCK_RESULT,
  });
}

const anthropicModelFactory = vi.fn();
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => anthropicModelFactory,
}));

const openaiModelFactory = vi.fn();
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => openaiModelFactory,
}));

const googleModelFactory = vi.fn();
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => googleModelFactory,
}));

describe("system message handling against the real ai SDK (not mocked)", () => {
  beforeEach(() => {
    anthropicModelFactory.mockReset().mockReturnValue(makeMockModel());
    openaiModelFactory.mockReset().mockReturnValue(makeMockModel());
    googleModelFactory.mockReset().mockReturnValue(makeMockModel());
  });

  it("Anthropic: a system + user message no longer throws InvalidPromptError", async () => {
    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider("sk-ant-test");

    const result = await provider.generate([
      { role: "system", content: "Eres un asistente útil." },
      { role: "user", content: "hi" },
    ]);

    expect(result).toBe("hola");
  });

  it("OpenAI: a system + user message no longer throws InvalidPromptError", async () => {
    const { createOpenAIProvider } = await import("./openai.js");
    const provider = createOpenAIProvider("sk-oa-test");

    const result = await provider.generate([
      { role: "system", content: "Eres un asistente útil." },
      { role: "user", content: "hi" },
    ]);

    expect(result).toBe("hola");
  });

  it("Google: a system + user message no longer throws InvalidPromptError (this is the exact bug the user hit)", async () => {
    const { createGoogleProvider } = await import("./google.js");
    const provider = createGoogleProvider("goog-test");

    const result = await provider.generate([
      { role: "system", content: "Eres un asistente útil." },
      { role: "user", content: "hi" },
    ]);

    expect(result).toBe("hola");
  });
});
