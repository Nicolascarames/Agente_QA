import ora from "ora";
import type {
  LLMProvider,
  Message,
  CodeChecker,
  CodeFile,
  CodeCheckResult,
  TestRunner,
  TestRunOptions,
  TestRunResult,
} from "@agente-qa/core";

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

export function withTestRunnerSpinner(runner: TestRunner): TestRunner {
  return {
    async run(options: TestRunOptions): Promise<TestRunResult> {
      const spinner = ora("Ejecutando tests...").start();
      let spinnerStopped = false;
      const wrappedOnOutput = (chunk: string): void => {
        if (!spinnerStopped) {
          spinnerStopped = true;
          spinner.stop();
        }
        options.onOutput(chunk);
      };
      try {
        const result = await runner.run({ ...options, onOutput: wrappedOnOutput });
        if (!spinnerStopped) {
          spinner.stop();
        }
        return result;
      } catch (err) {
        if (!spinnerStopped) {
          spinner.fail("Fallo al ejecutar los tests.");
        }
        throw err;
      }
    },
  };
}
