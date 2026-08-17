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

import { disambiguatorToken, disambiguatedName } from "./naming.js";

describe("disambiguatorToken", () => {
  it("takes the value out of an attribute condition", () => {
    expect(disambiguatorToken("attribute:[type='submit']")).toBe("submit");
    expect(disambiguatorToken("attribute:[data-testid='login-submit']")).toBe("login_submit");
  });

  it("falls back to the whole condition when the attribute has no value", () => {
    expect(disambiguatorToken("attribute:[disabled]")).toBe("disabled");
  });

  it("takes the role from a region scope and the selector from a css scope", () => {
    expect(disambiguatorToken("region:banner")).toBe("banner");
    expect(disambiguatorToken("selector:form")).toBe("form");
  });

  it("gives nothing when there was no disambiguator", () => {
    expect(disambiguatorToken(undefined)).toBe("");
  });
});

describe("disambiguatedName", () => {
  it("appends the token that tells the two apart", () => {
    expect(disambiguatedName("log_in_button", "attribute:[type='submit']", "p1", new Set())).toBe(
      "log_in_button_submit"
    );
  });

  it("suppresses a token that only repeats the tail of the base name", () => {
    expect(disambiguatedName("log_in_button", "attribute:[type='button']", "p1", new Set())).toBe(
      "log_in_button"
    );
  });

  it("keeps the redundant token rather than colliding", () => {
    const taken = new Set(["log_in_button"]);
    expect(disambiguatedName("log_in_button", "attribute:[type='button']", "p1", taken)).toBe(
      "log_in_button_button"
    );
  });

  it("never appends a counter: a collision falls back to a fingerprint suffix", () => {
    const taken = new Set(["log_in_button", "log_in_button_submit"]);
    const name = disambiguatedName("log_in_button", "attribute:[type='submit']", "python-expr", taken);
    expect(name).not.toBe("log_in_button_2");
    expect(name.startsWith("log_in_button_submit_")).toBe(true);
  });

  it("is stable: the same element yields the same name regardless of when it was seen", () => {
    // The property the whole task exists for. `taken` differs (a different
    // crawl order), the element does not, so the name must not move.
    const first = disambiguatedName("log_in_button", "attribute:[type='submit']", "p1", new Set());
    const later = disambiguatedName("log_in_button", "attribute:[type='submit']", "p1", new Set(["other_button"]));
    expect(later).toBe(first);
  });
});
