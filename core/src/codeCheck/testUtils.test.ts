import { describe, it, expect } from "vitest";
import { FakeCodeChecker } from "./testUtils.js";

describe("FakeCodeChecker", () => {
  it("returns scripted results in order and records the files it was called with", async () => {
    const fake = new FakeCodeChecker([{ ok: false, errors: "boom" }, { ok: true }]);

    const first = await fake.check([{ path: "a.py", content: "x = 1\n" }]);
    expect(first).toEqual({ ok: false, errors: "boom" });

    const second = await fake.check([{ path: "b.py", content: "y = 2\n" }]);
    expect(second).toEqual({ ok: true });

    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0]).toEqual([{ path: "a.py", content: "x = 1\n" }]);
  });

  it("throws when out of scripted results", async () => {
    const fake = new FakeCodeChecker([]);
    await expect(fake.check([{ path: "a.py", content: "x = 1\n" }])).rejects.toThrow();
  });
});
