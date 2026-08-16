import { describe, it, expect } from "vitest";
import { screenSignature, isSuspectedLoop } from "./signature.js";

describe("screenSignature", () => {
  it("gives the same signature to two pages that differ only in data", () => {
    const page1 = `- heading "Orders" [level=1]\n- text: Total 1.234,50 €\n- text: 12/03/2026`;
    const page2 = `- heading "Orders" [level=1]\n- text: Total 9,99 €\n- text: 01/01/2025`;
    expect(screenSignature(page1)).toBe(screenSignature(page2));
  });

  it("gives different signatures when the structure differs", () => {
    const orders = `- heading "Orders" [level=1]\n- button "New"`;
    const settings = `- heading "Settings" [level=1]\n- button "New"`;
    expect(screenSignature(orders)).not.toBe(screenSignature(settings));
  });

  it("is insensitive to leading whitespace changes", () => {
    expect(screenSignature(`- button "Log in"`)).toBe(screenSignature(`    - button "Log in"`));
  });

  it("returns a sha256-prefixed value", () => {
    expect(screenSignature(`- button "Log in"`)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("preserves structural annotations: different heading levels produce different signatures", () => {
    const level1 = `- heading "Orders" [level=1]\n- button "New"`;
    const level2 = `- heading "Orders" [level=2]\n- button "New"`;
    expect(screenSignature(level1)).not.toBe(screenSignature(level2));
  });
});

describe("isSuspectedLoop", () => {
  it("flags three consecutive identical signatures at threshold 3", () => {
    expect(isSuspectedLoop(["a", "a", "a"], 3)).toBe(true);
  });

  it("does not flag when the last signatures differ", () => {
    expect(isSuspectedLoop(["a", "a", "b"], 3)).toBe(false);
  });

  it("does not flag before reaching the threshold", () => {
    expect(isSuspectedLoop(["a", "a"], 3)).toBe(false);
  });

  it("only looks at the most recent window", () => {
    expect(isSuspectedLoop(["b", "a", "a", "a"], 3)).toBe(true);
  });
});
