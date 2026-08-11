import { describe, it, expect } from "vitest";
import { parseFeatureHeader } from "./parseFeatureHeader.js";

describe("parseFeatureHeader", () => {
  it("reads the pattern name from the header comment", () => {
    expect(parseFeatureHeader("# agente-qa:pattern=login\nFeature: Login\n")).toBe("login");
  });

  it("returns null when there's no header", () => {
    expect(parseFeatureHeader("Feature: Checkout\n")).toBeNull();
  });

  it("returns null when the comment is on a line other than the first", () => {
    expect(parseFeatureHeader("Feature: Login\n# agente-qa:pattern=login\n")).toBeNull();
  });
});
