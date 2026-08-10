import { describe, it, expect, vi, beforeEach } from "vitest";

const createAnthropicProviderMock = vi.fn((apiKey: string) => ({ generate: vi.fn() }));
const createOpenAIProviderMock = vi.fn((apiKey: string) => ({ generate: vi.fn() }));
const createGoogleProviderMock = vi.fn((apiKey: string) => ({ generate: vi.fn() }));

vi.mock("./providers/anthropic.js", () => ({
  createAnthropicProvider: (apiKey: string) => createAnthropicProviderMock(apiKey),
}));
vi.mock("./providers/openai.js", () => ({
  createOpenAIProvider: (apiKey: string) => createOpenAIProviderMock(apiKey),
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
});
