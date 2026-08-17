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
    {
      name: "email_input", kind: "input", accessibleName: "Email",
      python: 'page.get_by_label("Email")', count: 1, verifiedAt: "t",
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

// Names both of the map's locators, so checkMapFreshness can report two stale entries.
const featureWithTwoLocators =
  'Feature: Login\n\n  @screen:login\n  Scenario: x\n    When I fill "Email" with "a@b.com"\n    And I click "Log in"\n    Then I see "Welcome back"\n';

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

  it("throws an actionable error naming 'agente-qa map' when the @screen: tag names a screen absent from the map", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(
      "Feature: Login\n\n  @screen:ghost\n  Scenario: x\n    Given a\n    When b\n    Then c\n"
    );

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
    expect(writtenPaths[0]).toMatch(/tests[\\/]test_login\.py$/);
    expect(await fs.readFile(writtenPaths[0], "utf-8")).toContain("scenarios(");
  });

  it("rejects a generated file whose path is not under tests/, and never writes it to disk", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(simpleFeature);
    const badPathResponse = `# FILE: pages/login_page.py
class LoginPage:
    pass
`;
    const llm = new FakeLLMProvider([badPathResponse]);
    const checker = new FakeCodeChecker([]);
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
    ).rejects.toThrow(/tests\//);

    const exists = await fs
      .access(path.join(tmpProject, "tests", "pages", "login_page.py"))
      .then(() => true, () => false);
    expect(exists).toBe(false);
    expect(checker.receivedCalls).toHaveLength(0);
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

  it("throws an actionable error, without calling onStaleLocator, when the verifier fails without naming any locator", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(featureWithClick);
    const llm = new FakeLLMProvider([]);
    const checker = new FakeCodeChecker([]);
    // A navigation timeout, a Playwright traceback, the app being down: none of
    // these name the locator, so checkMapFreshness computes an empty `stale`.
    const verifier = new FakeLocatorVerifier([{ ok: false, errors: "Navigation timeout of 30000ms exceeded." }]);
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
    ).rejects.toThrow(/verificaci/i);

    expect(cb.onStaleLocator).not.toHaveBeenCalled();
  });

  it("calls onStaleLocator once per stale entry, and persists an override for each", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(featureWithTwoLocators);
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const verifier = new FakeLocatorVerifier([
      { ok: false, errors: "email_input: 0 coincidencias\n\nlog_in_button: 0 coincidencias" },
    ]);
    const overridesByName: Record<string, string> = {
      email_input: 'page.get_by_test_id("email")',
      log_in_button: 'page.get_by_test_id("login-btn")',
    };
    const onStaleLocator = vi.fn(
      async (stale: { screenId: string; name: string; count: number }[]) =>
        ({ action: "override" as const, python: overridesByName[stale[0].name] })
    );
    const cb = callbacks({ onStaleLocator });

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

    expect(onStaleLocator).toHaveBeenCalledTimes(2);
    expect(onStaleLocator).toHaveBeenNthCalledWith(1, [{ screenId: "login", name: "email_input", count: 0 }]);
    expect(onStaleLocator).toHaveBeenNthCalledWith(2, [{ screenId: "login", name: "log_in_button", count: 0 }]);

    const overrides = await loadOverrides(tmpProject);
    expect(overrides.locators).toEqual(
      expect.arrayContaining([
        { screenId: "login", name: "email_input", python: overridesByName.email_input },
        { screenId: "login", name: "log_in_button", python: overridesByName.log_in_button },
      ])
    );
    expect(overrides.locators).toHaveLength(2);
  });

  it("aborts on a remap answer to the second of two stale locators, having already persisted the first's override", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(featureWithTwoLocators);
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const verifier = new FakeLocatorVerifier([
      { ok: false, errors: "email_input: 0 coincidencias\n\nlog_in_button: 0 coincidencias" },
    ]);
    let call = 0;
    const onStaleLocator = vi.fn(async () => {
      call += 1;
      if (call === 1) return { action: "override" as const, python: 'page.get_by_test_id("email")' };
      return { action: "remap" as const };
    });
    const cb = callbacks({ onStaleLocator });

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

    expect(onStaleLocator).toHaveBeenCalledTimes(2);
    expect(llm.receivedCalls).toHaveLength(0);

    const overrides = await loadOverrides(tmpProject);
    expect(overrides.locators).toEqual([
      { screenId: "login", name: "email_input", python: 'page.get_by_test_id("email")' },
    ]);
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

  it("emits the freshness event before checkMapFreshness's browser round trip, not merely before generation starts", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(featureWithClick);
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const verifier = new FakeLocatorVerifier([{ ok: true }]);
    const cb = callbacks();
    const events: AgentEvent[] = [];
    // FakeLocatorVerifier.verify() pushes onto receivedCalls synchronously, before its
    // own `await` (inside checkMapFreshness) ever suspends — so the length of
    // receivedCalls at the instant the freshness event is captured tells us whether
    // the round trip had already started when the event fired.
    let verifierCallsWhenFreshnessEventFired: number | undefined;

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
      emit: (event) => {
        events.push(event);
        if (
          event.agent === "generador" &&
          event.status === "info" &&
          event.message === "Verificando 1 localizador(es) contra la aplicación real"
        ) {
          verifierCallsWhenFreshnessEventFired = verifier.receivedCalls.length;
        }
      },
    });

    // Neither the message text nor the event's position relative to the attempt loop
    // can catch a revert that moves the emit() call to after `await checkMapFreshness(...)`:
    // `used.length` is fixed before either ordering (so the text is identical), and the
    // event still lands before the attempt loop's own events either way (both sit earlier
    // in the function). What actually distinguishes "before" from "after" the round trip
    // is whether verifier.verify() had already run: 0 received calls means the user was
    // warned before the multi-second browser check, not after it.
    expect(verifierCallsWhenFreshnessEventFired).toBe(0);
    expect(verifier.receivedCalls).toHaveLength(1);
  });

  it("emits one event per generation attempt, and an 'ok' event on the attempt that passes verification", async () => {
    await saveAppMap(tmpProject, baseMap);
    const featureFilePath = await writeFeature(simpleFeature);
    const llm = new FakeLLMProvider([scriptedResponse, scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: false, errors: "SyntaxError: line 1" }, { ok: true }]);
    const verifier = new FakeLocatorVerifier([]);
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

    const attemptEvents = events.filter((e) => e.agent === "generador" && e.message.includes("intento"));
    // Reverting to a single "generating..." message emitted once (instead of once per
    // attempt) collapses these two apart, so the count and the ok-on-second-attempt
    // both have to hold for this to pass.
    expect(attemptEvents).toHaveLength(3); // info(1) + info(2) + ok(2)
    expect(attemptEvents.filter((e) => e.status === "info")).toHaveLength(2);
    expect(
      attemptEvents.some((e) => e.status === "ok" && e.message.includes("intento 2 de 4"))
    ).toBe(true);
  });
});
