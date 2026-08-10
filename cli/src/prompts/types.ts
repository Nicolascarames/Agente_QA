import type { ProviderName } from "@agente-qa/core";

export interface InitPrompts {
  selectProvider(): Promise<ProviderName>;
  inputApiKey(provider: ProviderName): Promise<string>;
  inputTestsDir(): Promise<string>;
}

export type MenuChoice = "create-plan" | "generate-tests" | "run-tests" | "reports" | "config" | "exit";

export interface MenuPrompts {
  selectMenuChoice(): Promise<MenuChoice>;
}

export interface ChatPrompts {
  inputInitialText(): Promise<string>;
  askUser(question: string): Promise<string>;
  presentForApproval(featureText: string): Promise<{ approved: boolean; feedback?: string }>;
  offerSavePattern(): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}
