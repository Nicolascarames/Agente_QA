import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LLMProvider, Message } from "../provider.js";
import { LLMRequestError } from "../errors.js";

export const GOOGLE_DEFAULT_MODEL = "gemini-3-pro";

export function createGoogleProvider(apiKey: string, model: string = GOOGLE_DEFAULT_MODEL): LLMProvider {
  const google = createGoogleGenerativeAI({ apiKey });
  return {
    async generate(messages: Message[]): Promise<string> {
      try {
        const result = await generateText({ model: google(model), messages });
        return result.text;
      } catch (err) {
        throw new LLMRequestError(
          `Fallo al llamar al modelo (Google): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    },
  };
}
