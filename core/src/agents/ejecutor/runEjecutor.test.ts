import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeTestRunner } from "../../testRun/testUtils.js";
import { runEjecutor, type ExecutorCallbacks } from "./runEjecutor.js";

describe("runEjecutor", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-runejecutor-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  async function writeFeature(fileName: string, content: string): Promise<void> {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), content, "utf-8");
  }

  it("throws a clear error when there are no feature files", async () => {
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn(),
      onOutput: vi.fn(),
    };

    await expect(runEjecutor(tmpProject, "tests", runner, callbacks)).rejects.toThrow(
      /Generar tests Playwright/
    );
  });

  it("builds a pytest marker expression (without '@') from a strict subset of selected tags", async () => {
    await writeFeature("login.feature", "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n");
    await writeFeature("checkout.feature", "@regression\nFeature: Checkout\n  Scenario: y\n    Given b\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn().mockResolvedValue(["@smoke"]),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, callbacks);

    expect(callbacks.selectTags).toHaveBeenCalledWith(["@regression", "@smoke"]);
    expect(runner.receivedCalls[0].markerExpression).toBe("smoke");
  });

  it("passes markerExpression: null when every available tag is selected (run everything)", async () => {
    await writeFeature("login.feature", "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn().mockResolvedValue(["@smoke"]),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, callbacks);

    expect(runner.receivedCalls[0].markerExpression).toBeNull();
  });

  it("skips tag selection entirely when no feature has any tag", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, callbacks);

    expect(callbacks.selectTags).not.toHaveBeenCalled();
    expect(runner.receivedCalls[0].markerExpression).toBeNull();
  });

  it('maps capture mode "off" to screenshot/video off', async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, callbacks);

    expect(runner.receivedCalls[0].screenshotMode).toBe("off");
    expect(runner.receivedCalls[0].videoMode).toBe("off");
  });

  it('maps capture mode "only-on-failure" to screenshot only-on-failure / video retain-on-failure', async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("only-on-failure"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, callbacks);

    expect(runner.receivedCalls[0].screenshotMode).toBe("only-on-failure");
    expect(runner.receivedCalls[0].videoMode).toBe("retain-on-failure");
  });

  it('maps capture mode "always" to screenshot on / video on', async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("always"),
      onOutput: vi.fn(),
    };

    await runEjecutor(tmpProject, "tests", runner, callbacks);

    expect(runner.receivedCalls[0].screenshotMode).toBe("on");
    expect(runner.receivedCalls[0].videoMode).toBe("on");
  });

  it("runs pytest with cwd = <testsDir> and writes the junit-xml under <testsDir>/results/latest.xml", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([{ exitCode: 0 }]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    const result = await runEjecutor(tmpProject, "tests", runner, callbacks);

    const expectedCwd = path.join(tmpProject, "tests");
    const expectedXmlPath = path.join(expectedCwd, "results", "latest.xml");
    expect(runner.receivedCalls[0].cwd).toBe(expectedCwd);
    expect(result.junitXmlPath).toBe(expectedXmlPath);
    expect(runner.receivedCalls[0].junitXmlPath).toBe(expectedXmlPath);
    const dirExists = await fs
      .stat(path.join(expectedCwd, "results"))
      .then((s) => s.isDirectory(), () => false);
    expect(dirExists).toBe(true);
  });

  it("returns exitCode and browserSetupWarning from the TestRunner result", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    const runner = new FakeTestRunner([
      { exitCode: 1, browserSetupWarning: 'Ejecuta "playwright install".' },
    ]);
    const callbacks: ExecutorCallbacks = {
      selectTags: vi.fn(),
      selectCaptureMode: vi.fn().mockResolvedValue("off"),
      onOutput: vi.fn(),
    };

    const result = await runEjecutor(tmpProject, "tests", runner, callbacks);

    expect(result.exitCode).toBe(1);
    expect(result.browserSetupWarning).toBe('Ejecuta "playwright install".');
  });
});
