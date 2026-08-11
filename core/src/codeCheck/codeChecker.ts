export interface CodeFile {
  path: string;
  content: string;
}

export interface CodeCheckResult {
  ok: boolean;
  errors?: string;
}

export interface CodeChecker {
  check(files: CodeFile[]): Promise<CodeCheckResult>;
}
