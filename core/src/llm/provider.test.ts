import { describe, it, expect } from "vitest";
import { splitSystemMessage, type Message } from "./provider.js";

describe("splitSystemMessage", () => {
  it("extracts a leading system message as instructions and strips it from the rest", () => {
    const messages: Message[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" },
    ];

    const { instructions, rest } = splitSystemMessage(messages);

    expect(instructions).toBe("You are a helpful assistant.");
    expect(rest).toEqual([{ role: "user", content: "hi" }]);
  });

  it("returns undefined instructions and the original messages unchanged when there is no system message", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];

    const { instructions, rest } = splitSystemMessage(messages);

    expect(instructions).toBeUndefined();
    expect(rest).toEqual([{ role: "user", content: "hi" }]);
  });

  it("extracts a system message even if it isn't the first element", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "system", content: "Be concise." },
      { role: "assistant", content: "ok" },
    ];

    const { instructions, rest } = splitSystemMessage(messages);

    expect(instructions).toBe("Be concise.");
    expect(rest).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("does not mutate the input array", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const originalLength = messages.length;

    splitSystemMessage(messages);

    expect(messages).toHaveLength(originalLength);
  });
});
