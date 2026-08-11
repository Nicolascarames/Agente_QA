import ora from "ora";
import type { LLMProvider, Message, CodeChecker, CodeFile, CodeCheckResult } from "@agente-qa/core";

export function withLLMSpinner(provider: LLMProvider): LLMProvider {
  return {
    async generate(messages: Message[]): Promise<string> {
      const spinner = ora("Consultando al modelo...").start();
      try {
        const result = await provider.generate(messages);
        spinner.succeed("Modelo respondió.");
        return result;
      } catch (err) {
        spinner.fail("Fallo al consultar el modelo.");
        throw err;
      }
    },
  };
}

export function withCodeCheckerSpinner(checker: CodeChecker): CodeChecker {
  return {
    async check(files: CodeFile[]): Promise<CodeCheckResult> {
      const spinner = ora("Comprobando el código generado (ruff/py_compile)...").start();
      try {
        const result = await checker.check(files);
        if (result.ok) {
          spinner.succeed("Código comprobado sin errores.");
        } else {
          spinner.fail("El código generado tiene errores de lint/compilación.");
        }
        return result;
      } catch (err) {
        spinner.fail("Fallo al comprobar el código.");
        throw err;
      }
    },
  };
}
