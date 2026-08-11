import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMProvider, Message } from "../provider.js";
import { splitSystemMessage } from "../provider.js";
import { LLMRequestError } from "../errors.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5.1";

export function createOpenAIProvider(
  apiKey: string,
  model: string = OPENAI_DEFAULT_MODEL,
  baseURL?: string
): LLMProvider {
  const openai = createOpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      const { instructions, rest } = splitSystemMessage(messages);
      try {
        const result = await generateText({ model: openai(model), instructions, messages: rest });
        return result.text;
      } catch (err) {
        throw new LLMRequestError(
          `Fallo al llamar al modelo (OpenAI): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    },
  };
}
