import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMProvider, Message } from "../provider.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5.1";

export function createOpenAIProvider(apiKey: string, model: string = OPENAI_DEFAULT_MODEL): LLMProvider {
  const openai = createOpenAI({ apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      const result = await generateText({ model: openai(model), messages });
      return result.text;
    },
  };
}
