import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseJsonResponse, LLMResponseParseError } from "./parseJson.js";

const schema = z.object({ ok: z.boolean() });

describe("parseJsonResponse", () => {
  it("parses plain JSON", () => {
    expect(parseJsonResponse(schema, '{"ok": true}')).toEqual({ ok: true });
  });

  it("strips markdown code fences", () => {
    expect(parseJsonResponse(schema, '```json\n{"ok": false}\n```')).toEqual({ ok: false });
  });

  it("throws LLMResponseParseError on invalid JSON", () => {
    expect(() => parseJsonResponse(schema, "not json")).toThrow(LLMResponseParseError);
  });

  it("throws LLMResponseParseError when the schema doesn't match", () => {
    expect(() => parseJsonResponse(schema, '{"ok": "yes"}')).toThrow(LLMResponseParseError);
  });
});
