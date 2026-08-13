import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, Message, CodeChecker, CodeFile, TestRunner, TestRunOptions } from "@agente-qa/core";

const spinnerInstance = {
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
  stop: vi.fn(),
};
spinnerInstance.start.mockReturnValue(spinnerInstance);

const oraFactory = vi.fn((_text: string) => spinnerInstance);

vi.mock("ora", () => ({
  default: (text: string) => oraFactory(text),
}));

import { withLLMSpinner, withCodeCheckerSpinner, withTestRunnerSpinner } from "./spinner.js";

describe("withLLMSpinner", () => {
  beforeEach(() => {
    oraFactory.mockClear();
    spinnerInstance.start.mockClear();
    spinnerInstance.succeed.mockClear();
    spinnerInstance.fail.mockClear();
    spinnerInstance.stop.mockClear();
  });

  it("returns the wrapped provider's result unchanged", async () => {
    const provider: LLMProvider = { generate: vi.fn().mockResolvedValue("respuesta del modelo") };
    const wrapped = withLLMSpinner(provider);

    const result = await wrapped.generate([{ role: "user", content: "hola" }]);

    expect(result).toBe("respuesta del modelo");
  });

  it("passes the exact same messages array through to the wrapped provider", async () => {
    const generate = vi.fn().mockResolvedValue("ok");
    const provider: LLMProvider = { generate };
    const wrapped = withLLMSpinner(provider);
    const messages: Message[] = [{ role: "user", content: "hola" }];

    await wrapped.generate(messages);

    expect(generate).toHaveBeenCalledWith(messages);
  });

  it("starts a spinner before calling the provider and marks it as succeeded after", async () => {
    const provider: LLMProvider = { generate: vi.fn().mockResolvedValue("ok") };
    const wrapped = withLLMSpinner(provider);

    await wrapped.generate([{ role: "user", content: "hola" }]);

    expect(oraFactory).toHaveBeenCalledWith("Consultando al modelo...");
    expect(spinnerInstance.start).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.succeed).toHaveBeenCalledTimes(1);
  });

  it("marks the spinner as failed and rethrows the same error when the provider throws", async () => {
    const boom = new Error("fallo de red");
    const provider: LLMProvider = { generate: vi.fn().mockRejectedValue(boom) };
    const wrapped = withLLMSpinner(provider);

    await expect(wrapped.generate([{ role: "user", content: "hola" }])).rejects.toBe(boom);
    expect(spinnerInstance.fail).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.succeed).not.toHaveBeenCalled();
  });
});

describe("withCodeCheckerSpinner", () => {
  beforeEach(() => {
    oraFactory.mockClear();
    spinnerInstance.start.mockClear();
    spinnerInstance.succeed.mockClear();
    spinnerInstance.fail.mockClear();
    spinnerInstance.stop.mockClear();
  });

  it("returns the wrapped checker's result unchanged when ok", async () => {
    const checker: CodeChecker = { check: vi.fn().mockResolvedValue({ ok: true }) };
    const wrapped = withCodeCheckerSpinner(checker);

    const result = await wrapped.check([{ path: "a.py", content: "pass\n" }]);

    expect(result).toEqual({ ok: true });
    expect(spinnerInstance.succeed).toHaveBeenCalledTimes(1);
  });

  it("marks the spinner as failed (without throwing) when the check result is not ok", async () => {
    const checker: CodeChecker = { check: vi.fn().mockResolvedValue({ ok: false, errors: "boom" }) };
    const wrapped = withCodeCheckerSpinner(checker);

    const result = await wrapped.check([{ path: "a.py", content: "pass\n" }]);

    expect(result).toEqual({ ok: false, errors: "boom" });
    expect(spinnerInstance.fail).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.succeed).not.toHaveBeenCalled();
  });

  it("marks the spinner as failed and rethrows the same error when the checker throws", async () => {
    const boom = new Error("ruff no encontrado");
    const checker: CodeChecker = { check: vi.fn().mockRejectedValue(boom) };
    const wrapped = withCodeCheckerSpinner(checker);

    await expect(wrapped.check([{ path: "a.py", content: "pass\n" }])).rejects.toBe(boom);
    expect(spinnerInstance.fail).toHaveBeenCalledTimes(1);
  });

  it("passes the exact same files array through to the wrapped checker", async () => {
    const check = vi.fn().mockResolvedValue({ ok: true });
    const checker: CodeChecker = { check };
    const wrapped = withCodeCheckerSpinner(checker);
    const files: CodeFile[] = [{ path: "a.py", content: "pass\n" }];

    await wrapped.check(files);

    expect(check).toHaveBeenCalledWith(files);
  });
});

describe("withTestRunnerSpinner", () => {
  beforeEach(() => {
    oraFactory.mockClear();
    spinnerInstance.start.mockClear();
    spinnerInstance.succeed.mockClear();
    spinnerInstance.fail.mockClear();
    spinnerInstance.stop.mockClear();
  });

  function baseOptions(onOutput: (chunk: string) => void): TestRunOptions {
    return {
      cwd: "/tmp/project/tests",
      markerExpression: null,
      screenshotMode: "off",
      videoMode: "off",
      headed: false,
      verboseSteps: false,
      junitXmlPath: "/tmp/project/tests/results/latest.xml",
      htmlReportPath: "/tmp/project/tests/results/latest.html",
      onOutput,
      env: {},
    };
  }

  it("starts a spinner before running, and stops it as soon as the first output chunk arrives", async () => {
    const chunks: string[] = [];
    const runner: TestRunner = {
      run: vi.fn(async (options: TestRunOptions) => {
        options.onOutput("primera línea\n");
        options.onOutput("segunda línea\n");
        return { exitCode: 0 };
      }),
    };
    const wrapped = withTestRunnerSpinner(runner);

    const result = await wrapped.run(baseOptions((chunk) => chunks.push(chunk)));

    expect(oraFactory).toHaveBeenCalledWith("Ejecutando tests...");
    expect(spinnerInstance.start).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.stop).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(["primera línea\n", "segunda línea\n"]);
    expect(result).toEqual({ exitCode: 0 });
  });

  it("stops the spinner even if the runner never emits any output", async () => {
    const runner: TestRunner = { run: vi.fn().mockResolvedValue({ exitCode: 0 }) };
    const wrapped = withTestRunnerSpinner(runner);

    await wrapped.run(baseOptions(() => {}));

    expect(spinnerInstance.stop).toHaveBeenCalledTimes(1);
  });

  it("marks the spinner as failed and rethrows when the runner throws before emitting any output", async () => {
    const boom = new Error("no se pudo lanzar pytest");
    const runner: TestRunner = { run: vi.fn().mockRejectedValue(boom) };
    const wrapped = withTestRunnerSpinner(runner);

    await expect(wrapped.run(baseOptions(() => {}))).rejects.toBe(boom);
    expect(spinnerInstance.fail).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.stop).not.toHaveBeenCalled();
  });

  it("does not call fail when the runner throws after already emitting output (spinner already stopped)", async () => {
    const boom = new Error("pytest crasheó a medias");
    const runner: TestRunner = {
      run: vi.fn(async (options: TestRunOptions) => {
        options.onOutput("algo de output\n");
        throw boom;
      }),
    };
    const wrapped = withTestRunnerSpinner(runner);

    await expect(wrapped.run(baseOptions(() => {}))).rejects.toBe(boom);
    expect(spinnerInstance.stop).toHaveBeenCalledTimes(1);
    expect(spinnerInstance.fail).not.toHaveBeenCalled();
  });
});
