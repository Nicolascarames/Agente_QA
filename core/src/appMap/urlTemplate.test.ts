import { describe, it, expect } from "vitest";
import { siblingTemplate, toUrlTemplate } from "./urlTemplate.js";

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

  it("resolves a relative URL against a base URL with no trailing slash", () => {
    expect(toUrlTemplate("/reset", "https://example.test")).toBe("/reset");
  });
});

describe("siblingTemplate", () => {
  it("collapses the segment two sibling routes differ in", () => {
    expect(siblingTemplate("/blog/first-post", "/blog/second-post")).toBe("/blog/:id");
  });

  it("collapses a differing segment in the middle of the path", () => {
    expect(siblingTemplate("/blog/first-post/comments", "/blog/second-post/comments")).toBe("/blog/:id/comments");
  });

  // Every top-level route differs from every other in exactly one segment.
  // Collapsing those would turn the whole map into a single /:id screen.
  it("never collapses two top-level routes", () => {
    expect(siblingTemplate("/reset.html", "/list.html")).toBeNull();
  });

  it("refuses paths that differ in more than one segment", () => {
    expect(siblingTemplate("/blog/a/x", "/blog/b/y")).toBeNull();
  });

  it("refuses paths of different length", () => {
    expect(siblingTemplate("/blog/a", "/blog/a/comments")).toBeNull();
  });

  it("refuses a segment already templated by the numeric or uuid rule", () => {
    expect(siblingTemplate("/user/:id", "/user/profile")).toBeNull();
  });

  it("refuses two identical templates", () => {
    expect(siblingTemplate("/blog/a", "/blog/a")).toBeNull();
  });
});
