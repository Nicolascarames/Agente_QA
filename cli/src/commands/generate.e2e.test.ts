import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { saveProjectConfig, projectEnvPath } from "@agente-qa/core";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}
const hasPython = commandExists("python");
const hasRuff = commandExists("ruff");

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));
vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => provider,
  withCodeCheckerSpinner: (checker: unknown) => checker,
}));

import { runGenerateTests } from "./generate.js";
import type { GeneratorPrompts } from "../prompts/types.js";

describe.skipIf(!hasPython || !hasRuff)(
  "end-to-end: generate tests via the real wiring, only the network call mocked",
  () => {
    let tmpProject: string;

    beforeEach(async () => {
      tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-gen-e2e-project-"));
      await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
      await fs.writeFile(
        projectEnvPath(tmpProject),
        "AGENTE_QA_LLM_PROVIDER=anthropic\nAGENTE_QA_LLM_API_KEY=sk-test\n",
        "utf-8"
      );
      await saveProjectConfig(tmpProject, { testsDir: "tests" });
      const featuresDir = path.join(tmpProject, "tests", "features");
      await fs.mkdir(featuresDir, { recursive: true });
      await fs.writeFile(
        path.join(featuresDir, "login.feature"),
        "# agente-qa:pattern=login\nFeature: Login\n  Scenario: x\n    Given a\n",
        "utf-8"
      );
      generateTextMock.mockReset();
    });

    afterEach(async () => {
      await fs.rm(tmpProject, { recursive: true, force: true });
    });

    it("generates and writes tests/pages for the built-in login pattern", async () => {
      generateTextMock.mockResolvedValueOnce({
        text: `# FILE: tests/test_login.py
from pytest_bdd import scenarios

scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page
`,
      });

      const prompts: GeneratorPrompts = {
        selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
        offerSavePattern: vi.fn(),
        confirmOverwrite: vi.fn().mockResolvedValue(true),
      };

      const writtenPaths = await runGenerateTests(prompts, tmpProject);

      expect(writtenPaths).toHaveLength(2);
      expect(prompts.offerSavePattern).not.toHaveBeenCalled();
    });
  }
);
