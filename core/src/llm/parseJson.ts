import type { ZodType } from "zod";

export class LLMResponseParseError extends Error {}

export function parseJsonResponse<T>(schema: ZodType<T>, raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    throw new LLMResponseParseError(`La respuesta del modelo no es JSON válido: ${cleaned}`);
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw new LLMResponseParseError(`La respuesta del modelo no cumple el esquema esperado: ${result.error.message}`);
  }
  return result.data;
}
