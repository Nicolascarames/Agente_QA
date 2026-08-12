export interface TestRunOptions {
  cwd: string;
  markerExpression: string | null;
  screenshotMode: "off" | "only-on-failure" | "on";
  videoMode: "off" | "retain-on-failure" | "on";
  junitXmlPath: string;
  htmlReportPath: string;
  onOutput: (chunk: string) => void;
  env: Record<string, string>;
}

export interface TestRunResult {
  exitCode: number;
  browserSetupWarning?: string;
}

export interface TestRunner {
  run(options: TestRunOptions): Promise<TestRunResult>;
}
