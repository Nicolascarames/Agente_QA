import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { saveProjectConfig, saveAppMap, projectEnvPath, FakeLocatorVerifier, type AppMap, type Screen } from "@agente-qa/core";

function commandExists(cmd: string): boolean {
  return spawnSync(cmd, ["--version"]).error === undefined;
}
const hasPython = commandExists("python");
const hasRuff = commandExists("ruff");

const generateTextMock = vi.fn();
const createRealLocatorVerifierMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));
vi.mock("../util/spinner.js", () => ({
  withLLMSpinner: (provider: unknown) => provider,
  withCodeCheckerSpinner: (checker: unknown) => checker,
  withLocatorVerifierSpinner: (verifier: unknown) => verifier,
}));
vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    createRealLocatorVerifier: (...args: unknown[]) => createRealLocatorVerifierMock(...args),
  };
});

import { runGenerateTests } from "./generate.js";
import type { GeneratorPrompts } from "../prompts/types.js";

const loginScreen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: [], probeValues: [], ambiguous: [], transitions: [], writeActions: [],
  states: [], locators: [],
};

const baseMap: AppMap = {
  schemaVersion: 1, appUrl: "https://example.com/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
  screens: [loginScreen],
};

describe.skipIf(!hasPython || !hasRuff)(
  "end-to-end: generate tests via the real wiring (ruff/py_compile real; locator verifier and LLM network call mocked)",
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
      await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
      await saveAppMap(tmpProject, baseMap);
      const featuresDir = path.join(tmpProject, "tests", "features");
      await fs.mkdir(featuresDir, { recursive: true });
      await fs.writeFile(
        path.join(featuresDir, "login.feature"),
        "Feature: Login\n\n  @screen:login\n  Scenario: x\n    Given a\n",
        "utf-8"
      );
      generateTextMock.mockReset();
      createRealLocatorVerifierMock.mockReset();
      createRealLocatorVerifierMock.mockReturnValue(new FakeLocatorVerifier([]));
    });

    afterEach(async () => {
      await fs.rm(tmpProject, { recursive: true, force: true });
    });

    it("generates and writes the test file for a scenario grounded in the map", async () => {
      generateTextMock.mockResolvedValueOnce({
        text: `# FILE: tests/test_login.py
from pytest_bdd import given, scenarios

scenarios("../features/login.feature")


@given("a")
def a():
    pass
`,
      });

      const prompts: GeneratorPrompts = {
        selectFeatureFile: vi.fn().mockResolvedValue("login.feature"),
        confirmOverwrite: vi.fn().mockResolvedValue(true),
        onStaleLocator: vi.fn().mockRejectedValue(new Error("onStaleLocator no debería haberse llamado")),
        onAmbiguousLocator: vi.fn().mockRejectedValue(new Error("onAmbiguousLocator no debería haberse llamado")),
      };

      const writtenPaths = await runGenerateTests(prompts, tmpProject);

      expect(writtenPaths).toHaveLength(1);
      expect(prompts.onStaleLocator).not.toHaveBeenCalled();
    });
  }
);
