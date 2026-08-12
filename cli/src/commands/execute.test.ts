import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, ensureProjectEnvTemplate, projectEnvPath } from "@agente-qa/core";
import type { ExecutorPrompts } from "../prompts/types.js";

const realTestRunnerRunMock = vi.fn();

vi.mock("@agente-qa/core", async () => {
  const actual = await vi.importActual<typeof import("@agente-qa/core")>("@agente-qa/core");
  return {
    ...actual,
    realTestRunner: { run: (...args: unknown[]) => realTestRunnerRunMock(...args) },
  };
});

import { runExecuteTests } from "./execute.js";

describe("runExecuteTests", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-execute-project-"));
    realTestRunnerRunMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run yet", async () => {
    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
    };
    await expect(runExecuteTests(prompts, tmpProject)).rejects.toThrow(/agente-qa init/);
  });

  it("throws a clear error when there are no generated tests yet", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");
    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
    };
    await expect(runExecuteTests(prompts, tmpProject)).rejects.toThrow(/Generar tests Playwright/);
  });

  it("throws a clear error naming AGENTE_QA_APP_URL when it's missing from the .env, without invoking the real test runner", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "@smoke\nFeature: Login\n", "utf-8");

    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
    };

    await expect(runExecuteTests(prompts, tmpProject)).rejects.toThrow(/AGENTE_QA_APP_URL/);
    expect(realTestRunnerRunMock).not.toHaveBeenCalled();
  });

  it("runs through the fake prompts and the mocked real test runner, returning its result", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await ensureProjectEnvTemplate(tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "@smoke\nFeature: Login\n", "utf-8");

    realTestRunnerRunMock.mockResolvedValue({ exitCode: 0 });

    const prompts: ExecutorPrompts = {
      selectTags: vi.fn().mockResolvedValue(["@smoke"]),
      selectCaptureMode: vi.fn().mockResolvedValue("only-on-failure"),
    };

    const result = await runExecuteTests(prompts, tmpProject);

    expect(prompts.selectTags).toHaveBeenCalledWith(["@smoke"]);
    expect(result.exitCode).toBe(0);
    expect(result.junitXmlPath).toBe(path.join(tmpProject, "tests", "results", "latest.xml"));
    expect(realTestRunnerRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotMode: "only-on-failure", videoMode: "retain-on-failure" })
    );
  });

  it("passes the app URL and test credentials from the .env into the runner's env option", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests" });
    await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
    await fs.writeFile(
      projectEnvPath(tmpProject),
      "AGENTE_QA_APP_URL=https://staging.mi-app.com\nAGENTE_QA_TEST_USERNAME=qa\nAGENTE_QA_TEST_PASSWORD=pwd\n",
      "utf-8"
    );
    const featuresDir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(featuresDir, { recursive: true });
    await fs.writeFile(path.join(featuresDir, "login.feature"), "Feature: Login\n", "utf-8");

    realTestRunnerRunMock.mockResolvedValue({ exitCode: 0 });

    const prompts: ExecutorPrompts = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
    };

    await runExecuteTests(prompts, tmpProject);

    expect(realTestRunnerRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          AGENTE_QA_APP_URL: "https://staging.mi-app.com",
          AGENTE_QA_TEST_USERNAME: "qa",
          AGENTE_QA_TEST_PASSWORD: "pwd",
        },
      })
    );
  });
});
