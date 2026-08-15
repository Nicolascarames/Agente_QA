import type { LLMProvider, Message } from "./provider.js";

export class FakeLLMProvider implements LLMProvider {
  private responses: string[];
  public receivedCalls: Message[][] = [];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async generate(messages: Message[]): Promise<string> {
    this.receivedCalls.push([...messages]);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("FakeLLMProvider: no hay más respuestas programadas");
    }
    return next;
  }

  lastPrompt(): string {
    const last = this.receivedCalls.at(-1);
    if (!last) throw new Error("FakeLLMProvider: no se ha registrado ninguna llamada");
    return last.map((message) => message.content).join("\n\n");
  }

  callCount(): number {
    return this.receivedCalls.length;
  }
}
