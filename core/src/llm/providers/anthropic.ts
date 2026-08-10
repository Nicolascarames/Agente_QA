import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LLMProvider, Message } from "../provider.js";
import { LLMRequestError } from "../errors.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";

export function createAnthropicProvider(apiKey: string, model: string = ANTHROPIC_DEFAULT_MODEL): LLMProvider {
  const anthropic = createAnthropic({ apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      try {
        const result = await generateText({ model: anthropic(model), messages });
        return result.text;
      } catch (err) {
        throw new LLMRequestError(
          `Fallo al llamar al modelo (Anthropic): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    },
  };
}
