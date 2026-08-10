export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  generate(messages: Message[]): Promise<string>;
}
