import { describe, it, expect } from "vitest";
import { FakeLocatorVerifier } from "./testUtils.js";
import type { GeneratedFile } from "../agents/generador/codeGenerator.js";

const files: GeneratedFile[] = [
  { path: "tests/test_login.py", content: "" },
  { path: "pages/login_page.py", content: "" },
];

describe("FakeLocatorVerifier", () => {
  it("returns scripted results in order and records every call it received", async () => {
    const fake = new FakeLocatorVerifier([
      { ok: true },
      { ok: false, errors: "resolvió a 2 elementos" },
    ]);

    const first = await fake.verify(files, [{ method: "get_button", argument: "Log In" }], "https://a.com", undefined);
    expect(first).toEqual({ ok: true });

    const second = await fake.verify(files, [], "https://b.com", { username: "u", password: "p" });
    expect(second).toEqual({ ok: false, errors: "resolvió a 2 elementos" });

    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0].baseUrl).toBe("https://a.com");
    expect(fake.receivedCalls[0].checks).toEqual([{ method: "get_button", argument: "Log In" }]);
    expect(fake.receivedCalls[1].credentials).toEqual({ username: "u", password: "p" });
  });

  it("throws when out of scripted results", async () => {
    const fake = new FakeLocatorVerifier([]);
    await expect(fake.verify(files, [], "https://a.com", undefined)).rejects.toThrow();
  });
});
