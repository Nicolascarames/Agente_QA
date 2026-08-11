import type { LLMProvider } from "../../llm/provider.js";
import type { Pattern } from "../../schemas/pattern.js";
import {
  codeGenerationPrompt,
  type CodeGenerationNaming,
  type CodeGenerationRetry,
} from "../../prompts/generador.js";

export interface GeneratedFile {
  path: string;
  content: string;
}

function parseGeneratedFiles(raw: string): GeneratedFile[] {
  const cleaned = raw.trim();
  const parts = cleaned.split(/^# FILE: (.+)$/m).slice(1);

  const files: GeneratedFile[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const filePath = parts[i].trim();
    const content = `${parts[i + 1].trim()}\n`;
    files.push({ path: filePath, content });
  }

  if (files.length === 0) {
    throw new Error(
      `La respuesta del modelo no contiene ningún bloque "# FILE: <ruta>": ${cleaned.slice(0, 80)}...`
    );
  }

  if (files.length !== 2) {
    throw new Error(
      `La respuesta del modelo generó ${files.length} archivo(s) en vez de los 2 esperados (step definitions y Page Object): ${cleaned.slice(0, 80)}...`
    );
  }

  return files;
}

export async function generateCode(
  featureText: string,
  llm: LLMProvider,
  matchedPattern: Pattern | null,
  naming: CodeGenerationNaming,
  retry?: CodeGenerationRetry
): Promise<GeneratedFile[]> {
  const raw = await llm.generate([
    {
      role: "system",
      content: "Eres un ingeniero de QA experto en Playwright, Python, pytest-bdd y Page Object Model.",
    },
    { role: "user", content: codeGenerationPrompt(featureText, matchedPattern, naming, retry) },
  ]);

  return parseGeneratedFiles(raw);
}
