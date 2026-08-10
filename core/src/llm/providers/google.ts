import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LLMProvider, Message } from "../provider.js";

export const GOOGLE_DEFAULT_MODEL = "gemini-3-pro";

export function createGoogleProvider(apiKey: string, model: string = GOOGLE_DEFAULT_MODEL): LLMProvider {
  const google = createGoogleGenerativeAI({ apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      const result = await generateText({ model: google(model), messages });
      return result.text;
    },
  };
}
