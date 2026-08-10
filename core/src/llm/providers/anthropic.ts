import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LLMProvider, Message } from "../provider.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";

export function createAnthropicProvider(apiKey: string, model: string = ANTHROPIC_DEFAULT_MODEL): LLMProvider {
  const anthropic = createAnthropic({ apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      const result = await generateText({ model: anthropic(model), messages });
      return result.text;
    },
  };
}
