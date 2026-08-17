import type { LLMProvider } from "../../llm/provider.js";
import type { AppMap } from "../../appMap/schema.js";
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

  if (files.length !== 1) {
    throw new Error(
      `La respuesta del modelo generó ${files.length} archivo(s) en vez del único esperado (step definitions bajo "tests/"): ${cleaned.slice(0, 80)}...`
    );
  }

  const [file] = files;
  if (!file.path.startsWith("tests/")) {
    throw new Error(
      `La respuesta del modelo generó el archivo "${file.path}" fuera de "tests/" en vez del único esperado (step definitions bajo "tests/"): ${cleaned.slice(0, 80)}...`
    );
  }

  return files;
}

export async function generateCode(
  featureText: string,
  llm: LLMProvider,
  map: AppMap,
  screenId: string,
  naming: CodeGenerationNaming,
  retry?: CodeGenerationRetry
): Promise<GeneratedFile[]> {
  const raw = await llm.generate([
    {
      role: "system",
      content: "Eres un ingeniero de QA experto en Playwright, Python y pytest-bdd.",
    },
    { role: "user", content: codeGenerationPrompt(featureText, map, screenId, naming, retry) },
  ]);

  return parseGeneratedFiles(raw);
}
