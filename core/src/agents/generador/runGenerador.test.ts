import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { FakeCodeChecker } from "../../codeCheck/testUtils.js";
import { FakeLocatorVerifier } from "../../locatorVerify/testUtils.js";
import { saveAppMap } from "../../appMap/mapStore.js";
import { loadOverrides } from "../../appMap/overrides.js";
import { runGenerador, type GeneratorCallbacks } from "./runGenerador.js";
import type { AppMap, Screen } from "../../appMap/schema.js";
import type { AgentEvent } from "../../events/agentEvent.js";

const loginScreen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: ["Welcome back"], probeValues: [], ambiguous: [], transitions: [], writeActions: [],
  states: [],
  locators: [
    {
      name: "log_in_button", kind: "button", accessibleName: "Log in",
      python: 'page.get_by_role("button", name="Log in", exact=True)', count: 1, verifiedAt: "t",
    },
  ],
};

const baseMap: AppMap = {
  schemaVersion: 1, appUrl: "https://example.com/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [loginScreen],
};

// Carries no "I click"/"I fill" step, so locatorsUsedBy finds nothing to
// revalidate — used by every test whose focus is unrelated to freshness.
const simpleFeature = "Feature: Login\n\n  @screen:login\n  Scenario: x\n    Given a\n    When b\n    Then c\n";

// Names the map's one locator via a step mapFreshness.locatorsUsedBy recognizes.
const featureWithClick = 'Feature: Login\n\n  @screen:login\n  Scenario: x\n    When I click "Log in"\n    Then I see "Welcome back"\n';

const scriptedResponse = `# FILE: tests/test_login.py
from pytest_bdd import scenarios, given, when, then

scenarios("../features/login.feature")


@given("a")
def a():
    pass
`;

function callbacks(overrides: Partial<GeneratorCallbacks> = {}): GeneratorCallbacks {
  return {
    confirmOverwrite: vi.fn().mockResolvedValue(true),
    onStaleLocator: vi.fn().mockRejectedValue(new Error("onStaleLocator no debería haberse llamado")),
    ...overrides,
  };
}

describe("runGenerador", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-rungenerador-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  async function writeFeature(content: string): Promise<string> {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "login.feature");
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("throws with an actionable message naming 'agente-qa map' when there is no map", async () => {
    const featureFilePath = await writeFeature(simpleFeature);

    await expect(
      runGenerador({
        featureFilePath,
        llm: new FakeLLMProvider([]),
        checker: new FakeCodeChecker([]),
        verifier: new FakeLocatorVerifier([]),
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        credentials: undefined,
        callbacks: callbacks(),
        emit: () => {},
      })
    ).rejects.toThrow(/agente-qa map/);
  });

  it("throws an actionable error when the feature carries no @screen: tag", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature("Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n");

    await expect(
      runGenerador({
        featureFilePath,
        llm: new FakeLLMProvider([]),
        checker: new FakeCodeChecker([]),
        verifier: new FakeLocatorVerifier([]),
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        credentials: undefined,
        callbacks: callbacks(),
        emit: () => {},
      })
    ).rejects.toThrow(/@screen:/);
  });

  it("generates and writes only tests/*.py, never a file under pages/", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(simpleFeature);
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const verifier = new FakeLocatorVerifier([]);
    const cb = callbacks();

    const { writtenPaths } = await runGenerador({
      featureFilePath,
      llm,
      checker,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      credentials: undefined,
      callbacks: cb,
      emit: () => {},
    });

    expect(writtenPaths).toHaveLength(1);
    expect(writtenPaths.some((p) => /pages[\\/]/.test(p))).toBe(false);
    expect(writtenPaths[0]).toMatch(/tests[\\/]test_login\.py$/);
    expect(await fs.readFile(writtenPaths[0], "utf-8")).toContain("scenarios(");
  });

  it("routes a stale locator through onStaleLocator, and persists an override answer via saveOverride", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(featureWithClick);
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const verifier = new FakeLocatorVerifier([{ ok: false, errors: "log_in_button: 0 coincidencias" }]);
    const overridePython = 'page.get_by_test_id("login-btn")';
    const cb = callbacks({
      onStaleLocator: vi.fn().mockResolvedValue({ action: "override", python: overridePython }),
    });

    await runGenerador({
      featureFilePath,
      llm,
      checker,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      credentials: undefined,
      callbacks: cb,
      emit: () => {},
    });

    expect(cb.onStaleLocator).toHaveBeenCalledWith([{ screenId: "login", name: "log_in_button", count: 0 }]);

    const overrides = await loadOverrides(tmpProject);
    expect(overrides.locators).toEqual([{ screenId: "login", name: "log_in_button", python: overridePython }]);
  });

  it("aborts with a message naming 'agente-qa map' when the answer to a stale locator is remap", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(featureWithClick);
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const verifier = new FakeLocatorVerifier([{ ok: false, errors: "log_in_button: 0 coincidencias" }]);
    const cb = callbacks({ onStaleLocator: vi.fn().mockResolvedValue({ action: "remap" }) });

    await expect(
      runGenerador({
        featureFilePath,
        llm,
        checker,
        verifier,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        credentials: undefined,
        callbacks: cb,
        emit: () => {},
      })
    ).rejects.toThrow(/agente-qa map/);

    expect(llm.receivedCalls).toHaveLength(0);
  });

  it("retries generation when the checker reports a compilation failure, feeding the error back as feedback", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(simpleFeature);
    const llm = new FakeLLMProvider([scriptedResponse, scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: false, errors: "SyntaxError: line 1" }, { ok: true }]);
    const verifier = new FakeLocatorVerifier([]);
    const cb = callbacks();

    await runGenerador({
      featureFilePath,
      llm,
      checker,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      credentials: undefined,
      callbacks: cb,
      emit: () => {},
    });

    expect(checker.receivedCalls).toHaveLength(2);
    const secondAttemptPrompt = llm.receivedCalls[1].find((m) => m.role === "user")?.content;
    expect(secondAttemptPrompt).toContain("SyntaxError: line 1");
  });

  it("aborts without writing anything after 3 failed corrections (4 total attempts)", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(simpleFeature);
    const llm = new FakeLLMProvider([scriptedResponse, scriptedResponse, scriptedResponse, scriptedResponse]);
    const checker = new FakeCodeChecker([
      { ok: false, errors: "e1" },
      { ok: false, errors: "e2" },
      { ok: false, errors: "e3" },
      { ok: false, errors: "e4" },
    ]);
    const verifier = new FakeLocatorVerifier([]);
    const cb = callbacks();

    await expect(
      runGenerador({
        featureFilePath,
        llm,
        checker,
        verifier,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        credentials: undefined,
        callbacks: cb,
        emit: () => {},
      })
    ).rejects.toThrow(/4 intentos/);

    const exists = await fs
      .access(path.join(tmpProject, "tests", "tests", "test_login.py"))
      .then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it("asks for overwrite confirmation when a target test file already exists, and honors a rejection", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(simpleFeature);
    await fs.mkdir(path.join(tmpProject, "tests", "tests"), { recursive: true });
    await fs.writeFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "# ya existente\n", "utf-8");

    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const verifier = new FakeLocatorVerifier([]);
    const cb = callbacks({ confirmOverwrite: vi.fn().mockResolvedValue(false) });

    await expect(
      runGenerador({
        featureFilePath,
        llm,
        checker,
        verifier,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://example.com",
        credentials: undefined,
        callbacks: cb,
        emit: () => {},
      })
    ).rejects.toThrow(/Cancelado/);

    expect(await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")).toBe(
      "# ya existente\n"
    );
  });

  it("surfaces a freshness warning via emit, without treating it as a failure", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(featureWithClick);
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const verifier = new FakeLocatorVerifier([
      { ok: true, warnings: "el locator log_in_button resolvió a 0 elementos en una pantalla" },
    ]);
    const cb = callbacks();
    const events: AgentEvent[] = [];

    await runGenerador({
      featureFilePath,
      llm,
      checker,
      verifier,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://example.com",
      credentials: undefined,
      callbacks: cb,
      emit: (event) => events.push(event),
    });

    expect(
      events.some(
        (e) => e.agent === "generador" && e.status === "warn" && e.message.includes("resolvió a 0 elementos")
      )
    ).toBe(true);
    expect(cb.onStaleLocator).not.toHaveBeenCalled();
  });
});
