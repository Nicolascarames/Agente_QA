import { describe, it, expect } from "vitest";
import { toUrlTemplate } from "./urlTemplate.js";

const base = "https://example.test/";

describe("toUrlTemplate", () => {
  it("keeps a static path as-is", () => {
    expect(toUrlTemplate("https://example.test/settings/profile", base)).toBe("/settings/profile");
  });

  it("collapses a numeric segment", () => {
    expect(toUrlTemplate("https://example.test/user/123", base)).toBe("/user/:id");
  });

  it("collapses a uuid segment", () => {
    expect(toUrlTemplate("https://example.test/order/3f2504e0-4f89-11d3-9a0c-0305e82c3301", base))
      .toBe("/order/:id");
  });

  it("collapses every variable segment in the same path", () => {
    expect(toUrlTemplate("https://example.test/user/7/post/42", base)).toBe("/user/:id/post/:id");
  });

  it("normalises the root to a single slash", () => {
    expect(toUrlTemplate("https://example.test", base)).toBe("/");
    expect(toUrlTemplate("https://example.test/", base)).toBe("/");
  });

  it("drops the query string and hash: they are state, not route", () => {
    expect(toUrlTemplate("https://example.test/search?q=hola#top", base)).toBe("/search");
  });
});
