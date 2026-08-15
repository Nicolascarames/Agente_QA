import { describe, it, expect } from "vitest";
import { checkStepParsers } from "./stepParserLint.js";

describe("checkStepParsers", () => {
  it("rejects parsers.parse with a quoted parameter", () => {
    const result = checkStepParsers([
      {
        path: "tests/test_login.py",
        content: `@when(parsers.parse('introduzco el correo electrónico "{email}"'))\ndef step(login_page, email):\n    pass\n`,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("tests/test_login.py:1");
    expect(result.errors).toContain("parsers.re");
  });

  it("accepts parsers.re with a named group", () => {
    const result = checkStepParsers([
      {
        path: "tests/test_login.py",
        content: `@when(parsers.re(r'introduzco el correo electrónico "(?P<email>[^"]*)"'))\ndef step(login_page, email):\n    pass\n`,
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts parsers.parse when no parameter is quoted", () => {
    const result = checkStepParsers([
      { path: "tests/test_login.py", content: `@when(parsers.parse('pulso el botón {name}'))\n` },
    ]);
    expect(result.ok).toBe(true);
  });

  // The prompt names parsers.parse to warn against it, so the model tends to
  // quote that exact string inside a comment. Same failure already seen with
  // .or_() on 2026-08-14.
  it("ignores commented-out lines", () => {
    const result = checkStepParsers([
      {
        path: "tests/test_login.py",
        content: `# no uses parsers.parse('el correo "{email}"') aquí\n@when(parsers.re(r'el correo "(?P<email>[^"]*)"'))\n`,
      },
    ]);
    expect(result.ok).toBe(true);
  });
});
