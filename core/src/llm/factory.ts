import type { Credentials } from "../config/credentials.js";
import type { LLMProvider } from "./provider.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createGoogleProvider } from "./providers/google.js";

export function createProvider(credentials: Credentials): LLMProvider {
  switch (credentials.provider) {
    case "anthropic":
      return createAnthropicProvider(credentials.apiKey);
    case "openai":
      return createOpenAIProvider(credentials.apiKey);
    case "google":
      return createGoogleProvider(credentials.apiKey);
    case "openai-compatible": {
      if (!credentials.baseURL || !credentials.model) {
        throw new Error(
          "Faltan 'baseURL' o 'model' en las credenciales del proveedor 'openai-compatible'. Ejecuta 'agente-qa init' de nuevo."
        );
      }
      return createOpenAIProvider(credentials.apiKey, credentials.model, credentials.baseURL);
    }
  }
}
