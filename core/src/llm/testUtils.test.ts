import { describe, it, expect } from "vitest";
import { FakeLLMProvider } from "./testUtils.js";

describe("FakeLLMProvider", () => {
  it("returns scripted responses in order and records calls", async () => {
    const fake = new FakeLLMProvider(["first", "second"]);
    expect(await fake.generate([{ role: "user", content: "a" }])).toBe("first");
    expect(await fake.generate([{ role: "user", content: "b" }])).toBe("second");
    expect(fake.receivedCalls).toHaveLength(2);
    expect(fake.receivedCalls[0]).toEqual([{ role: "user", content: "a" }]);
  });

  it("throws when out of scripted responses", async () => {
    const fake = new FakeLLMProvider([]);
    await expect(fake.generate([{ role: "user", content: "a" }])).rejects.toThrow();
  });
});
