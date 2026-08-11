export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  generate(messages: Message[]): Promise<string>;
}

export function splitSystemMessage(messages: Message[]): { instructions: string | undefined; rest: Message[] } {
  const systemMessage = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  return { instructions: systemMessage?.content, rest };
}
