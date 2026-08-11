import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, Message, CodeChecker, CodeFile } from "@agente-qa/core";

const spinnerInstance = {
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
};
spinnerInstance.start.mockReturnValue(spinnerInstance);

const oraFactory = vi.fn((_text: string) => spinnerInstance);

vi.mock("ora", () => ({
  default: (text: string) => oraFactory(text),
}));

import { withLLMSpinner, withCodeCheckerSpinner } from "./spinner.js";

describe("withLLMSpinner", () => {
  beforeEach(() => {
    oraFactory.mockClear();
    spinnerInstance.start.mockClear();
    spinnerInstance.succeed.mockClear();
    spinnerInstance.fail.mockClear();
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
