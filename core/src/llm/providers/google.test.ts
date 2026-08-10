import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const googleModelMock = vi.fn((modelId: string) => ({ modelId }));
const createGoogleMock = vi.fn((..._args: unknown[]) => googleModelMock);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (...args: unknown[]) => createGoogleMock(...args),
}));

import { createGoogleProvider, GOOGLE_DEFAULT_MODEL } from "./google.js";
import { LLMRequestError } from "../errors.js";

describe("createGoogleProvider", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createGoogleMock.mockClear();
    googleModelMock.mockClear();
  });

  it("configures the Google client with the given API key", () => {
    createGoogleProvider("goog-test");
    expect(createGoogleMock).toHaveBeenCalledWith({ apiKey: "goog-test" });
  });

  it("calls generateText with the default model and returns the text", async () => {
    generateTextMock.mockResolvedValue({ text: "hola" });
    const provider = createGoogleProvider("goog-test");
    const result = await provider.generate([{ role: "user", content: "hi" }]);

    expect(googleModelMock).toHaveBeenCalledWith(GOOGLE_DEFAULT_MODEL);
    expect(generateTextMock).toHaveBeenCalledWith({
      model: { modelId: GOOGLE_DEFAULT_MODEL },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBe("hola");
  });

  it("wraps generateText failures in an LLMRequestError naming the provider", async () => {
    const originalError = new Error("network down");
    generateTextMock.mockRejectedValueOnce(originalError);
    const provider = createGoogleProvider("goog-test");

    const promise = provider.generate([{ role: "user", content: "hi" }]);
    await expect(promise).rejects.toBeInstanceOf(LLMRequestError);
    await expect(promise).rejects.toThrow(/Google/);
    await promise.catch((err: unknown) => {
      expect((err as { cause?: unknown }).cause).toBe(originalError);
    });
  });
});
