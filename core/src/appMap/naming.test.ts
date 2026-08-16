import { describe, it, expect } from "vitest";
import { pythonIdentifier, uniqueName } from "./naming.js";

describe("pythonIdentifier", () => {
  it("lowercases and joins words with underscores", () => {
    expect(pythonIdentifier("Log in")).toBe("log_in");
  });

  it("strips accents so Spanish UI copy yields plain identifiers", () => {
    expect(pythonIdentifier("Contraseña olvidada")).toBe("contrasena_olvidada");
  });

  it("drops punctuation", () => {
    expect(pythonIdentifier("Forgot password?")).toBe("forgot_password");
  });

  it("prefixes a leading digit so the result is a valid identifier", () => {
    expect(pythonIdentifier("2 factor")).toBe("_2_factor");
  });

  it("falls back to a placeholder when nothing usable remains", () => {
    expect(pythonIdentifier("···")).toBe("unnamed");
  });
});

describe("uniqueName", () => {
  it("returns the candidate when it is free", () => {
    expect(uniqueName("log_in", new Set())).toBe("log_in");
  });

  it("suffixes with a counter on collision", () => {
    expect(uniqueName("log_in", new Set(["log_in"]))).toBe("log_in_2");
    expect(uniqueName("log_in", new Set(["log_in", "log_in_2"]))).toBe("log_in_3");
  });
});
