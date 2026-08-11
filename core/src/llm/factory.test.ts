import { describe, it, expect, vi, beforeEach } from "vitest";

const createAnthropicProviderMock = vi.fn((apiKey: string) => ({ generate: vi.fn() }));
const createOpenAIProviderMock = vi.fn((..._args: unknown[]) => ({ generate: vi.fn() }));
const createGoogleProviderMock = vi.fn((apiKey: string) => ({ generate: vi.fn() }));

vi.mock("./providers/anthropic.js", () => ({
  createAnthropicProvider: (apiKey: string) => createAnthropicProviderMock(apiKey),
}));
vi.mock("./providers/openai.js", () => ({
  createOpenAIProvider: (...args: unknown[]) => createOpenAIProviderMock(...args),
}));
vi.mock("./providers/google.js", () => ({
  createGoogleProvider: (apiKey: string) => createGoogleProviderMock(apiKey),
}));

import { createProvider } from "./factory.js";

describe("createProvider", () => {
  beforeEach(() => {
    createAnthropicProviderMock.mockClear();
    createOpenAIProviderMock.mockClear();
    createGoogleProviderMock.mockClear();
  });

  it("dispatches to the Anthropic adapter", () => {
    createProvider({ provider: "anthropic", apiKey: "k" });
    expect(createAnthropicProviderMock).toHaveBeenCalledWith("k");
  });

  it("dispatches to the OpenAI adapter", () => {
    createProvider({ provider: "openai", apiKey: "k" });
    expect(createOpenAIProviderMock).toHaveBeenCalledWith("k");
  });

  it("dispatches to the Google adapter", () => {
    createProvider({ provider: "google", apiKey: "k" });
    expect(createGoogleProviderMock).toHaveBeenCalledWith("k");
  });

  it("dispatches to the OpenAI adapter with the custom model and baseURL for openai-compatible", () => {
    createProvider({
      provider: "openai-compatible",
      apiKey: "k",
      baseURL: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    });
    expect(createOpenAIProviderMock).toHaveBeenCalledWith(
      "k",
      "llama-3.3-70b-versatile",
      "https://api.groq.com/openai/v1"
    );
  });

  it("throws a clear error if openai-compatible credentials are missing baseURL or model", () => {
    expect(() => createProvider({ provider: "openai-compatible", apiKey: "k" })).toThrow(/baseURL|model/);
  });
});
