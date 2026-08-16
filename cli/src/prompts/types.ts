export interface InitPrompts {
  inputTestsDir(): Promise<string>;
  confirmHeadedMode(): Promise<boolean>;
  inputAppUrl(): Promise<string>;
  selectAppLanguage(): Promise<"es" | "en">;
  inputRoute(label: string): Promise<string>;
  promptAdditionalRoutes(): Promise<Record<string, string>>;
  selectGitignoreEntries(candidates: string[]): Promise<string[]>;
}

export type MenuChoice = "map" | "create-plan" | "generate-tests" | "run-tests" | "reports" | "config" | "exit";

export interface MenuPrompts {
  selectMenuChoice(): Promise<MenuChoice>;
}

export interface ChatPrompts {
  inputInitialText(): Promise<string>;
  askUser(question: string): Promise<string>;
  presentForApproval(featureText: string): Promise<{ approved: boolean; feedback?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}

export interface GeneratorPrompts {
  selectFeatureFile(files: string[]): Promise<string>;
  offerSavePattern(): Promise<{ save: boolean; name?: string; description?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}

export interface ExecutorPrompts {
  selectTags(availableTags: string[]): Promise<string[]>;
  selectCaptureMode(): Promise<"off" | "only-on-failure" | "always">;
}

export interface ReportesPrompts {
  selectDetailLevel(): Promise<"resumen" | "completo">;
}
