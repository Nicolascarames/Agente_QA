import type { LLMProvider, Message } from "./provider.js";

export class FakeLLMProvider implements LLMProvider {
  private responses: string[];
  public receivedCalls: Message[][] = [];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async generate(messages: Message[]): Promise<string> {
    this.receivedCalls.push(messages);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("FakeLLMProvider: no hay más respuestas programadas");
    }
    return next;
  }
}
