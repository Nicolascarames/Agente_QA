import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { saveAppMap } from "../../appMap/mapStore.js";
import { runIntake, type IntakeCallbacks } from "./runIntake.js";
import type { AppMap, Screen, ScenarioCandidate } from "../../appMap/schema.js";
import type { AgentEvent } from "../../events/agentEvent.js";

const loginScreen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: ["Welcome back", "Email"], probeValues: [], locators: [],
  ambiguous: [], transitions: [], writeActions: [],
  states: [{
    id: "invalid",
    reachedBy: { action: "submit", locator: "submit_button", data: "invalid" },
    addsTexts: ["Authentication failed. Please try again."],
  }],
};

const baseMap: AppMap = {
  schemaVersion: 1, appUrl: "https://app.test/", createdAt: "t",
  complete: true, authenticated: false, scenarios: [],
  stats: { screens: 1, locators: 0, ambiguous: 0, durationMs: 0 },
  screens: [loginScreen],
};

const scenarioCandidate: ScenarioCandidate = {
  id: "bad-login",
  title: "Invalid credentials show an error",
  screenId: "login",
  involvedScreens: ["login"],
  rationale: "Covers the failure path",
};

const mapWithScenario: AppMap = { ...baseMap, scenarios: [scenarioCandidate] };

const gherkinResponse = (featureText: string, fileName = "login.feature"): string =>
  JSON.stringify({ fileName, featureText });

// Quotes a literal that IS in the map (screen text) — passes checkFeatureLiterals.
const validPlanJson = gherkinResponse(
  'Feature: Log in\n\n  @screen:login\n  Scenario: Invalid credentials show an error\n    Then I see "Welcome back"\n'
);

// Quotes a literal the map does NOT contain — an invented string, must be rejected.
const invented = gherkinResponse(
  'Feature: Log in\n\n  @screen:login\n  Scenario: Invalid credentials show an error\n    Then I see "Invalid email or password"\n'
);

// Quotes the real text the state adds after a failed submit — passes checkFeatureLiterals.
const grounded = gherkinResponse(
  'Feature: Log in\n\n  @screen:login\n  Scenario: Invalid credentials show an error\n    Then I see "Authentication failed. Please try again."\n'
);

describe("runIntake", () => {
  let projectRoot: string;
  let callbacks: IntakeCallbacks;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-intake-"));
    callbacks = {
      askUser: vi.fn(),
      // Auto-selects the map's own candidate by default, mirroring how
      // presentForApproval/confirmOverwrite default to the "happy path"
      // outcome so most tests don't need to script every callback.
      chooseScenario: vi.fn(async (candidates: ScenarioCandidate[]) => candidates[0] ?? null),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("stops with an actionable message when there is no map", async () => {
    await expect(runIntake({
      initialText: "probar login", llm: new FakeLLMProvider(["{}"]),
      projectRoot, testsDir: "tests", callbacks, emit: () => {},
    })).rejects.toThrow(/agente-qa map/);
  });

  it("offers the map's candidate scenarios before asking for free text", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    let offered = 0;
    await runIntake({
      initialText: "", llm: new FakeLLMProvider([validPlanJson]),
      projectRoot, testsDir: "tests", emit: () => {},
      callbacks: { ...callbacks, chooseScenario: async (list) => { offered = list.length; return list[0]; } },
    });
    expect(offered).toBe(1);
  });

  it("regenerates instead of presenting a plan whose literal is not in the map", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    const llm = new FakeLLMProvider([invented, grounded]);
    const presented: string[] = [];
    await runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests", emit: () => {},
      callbacks: { ...callbacks, presentForApproval: async (plan) => { presented.push(plan.featureText); return { approved: true }; } },
    });
    expect(presented).toHaveLength(1);
    expect(presented[0]).toContain("Authentication failed. Please try again.");
  });

  it("asks clarifying questions when the map offers no scenario and the request is ambiguous", async () => {
    await saveAppMap(projectRoot, baseMap); // no scenarios: nothing to auto-select
    const llm = new FakeLLMProvider([
      JSON.stringify({ ambiguous: true, questions: ["¿Qué credenciales usamos?"] }),
      validPlanJson,
    ]);
    callbacks.askUser = vi.fn().mockResolvedValue("Credenciales inválidas");

    await runIntake({
      initialText: "probar algo raro", llm, projectRoot, testsDir: "tests", callbacks, emit: () => {},
    });

    expect(callbacks.askUser).toHaveBeenCalledWith("¿Qué credenciales usamos?");
    // The clarification must reach the regenerated prompt.
    const finalMessages = llm.receivedCalls[llm.receivedCalls.length - 1];
    expect(finalMessages[finalMessages.length - 1].content).toContain("Credenciales inválidas");
  });

  it("throws after exhausting grounding attempts, naming the real texts of the screen", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    const llm = new FakeLLMProvider([invented, invented, invented]);

    await expect(runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests", callbacks, emit: () => {},
    })).rejects.toThrow(/Invalid email or password/);
  });

  it("emits a warn event while regenerating and an ok event once the plan is written", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    const llm = new FakeLLMProvider([invented, grounded]);
    const events: AgentEvent[] = [];

    const { filePath } = await runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests", callbacks,
      emit: (event) => events.push(event),
    });

    expect(events.some((e) => e.agent === "intake" && e.status === "warn")).toBe(true);
    expect(events.some((e) => e.agent === "intake" && e.status === "ok" && e.message.includes(filePath))).toBe(true);
  });

  it("asks for confirmation before overwriting an existing feature file, and honors the answer", async () => {
    await saveAppMap(projectRoot, mapWithScenario);

    const { filePath } = await runIntake({
      initialText: "probar login", llm: new FakeLLMProvider([validPlanJson]),
      projectRoot, testsDir: "tests", callbacks, emit: () => {},
    });
    const originalContent = await fs.readFile(filePath, "utf-8");

    const confirmOverwriteReject = vi.fn().mockResolvedValue(false);
    await expect(
      runIntake({
        initialText: "probar login otra vez", llm: new FakeLLMProvider([validPlanJson]),
        projectRoot, testsDir: "tests",
        callbacks: { ...callbacks, confirmOverwrite: confirmOverwriteReject },
        emit: () => {},
      })
    ).rejects.toThrow(/Cancelado/);
    expect(confirmOverwriteReject).toHaveBeenCalledWith(filePath);
    expect(await fs.readFile(filePath, "utf-8")).toBe(originalContent);

    const secondPlanJson = gherkinResponse(
      'Feature: Log in\n\n  @screen:login\n  Scenario: Invalid credentials show an error\n    Then I see "Email"\n'
    );
    await runIntake({
      initialText: "probar login de nuevo", llm: new FakeLLMProvider([secondPlanJson]),
      projectRoot, testsDir: "tests",
      callbacks: { ...callbacks, confirmOverwrite: vi.fn().mockResolvedValue(true) },
      emit: () => {},
    });
    expect(await fs.readFile(filePath, "utf-8")).not.toBe(originalContent);
  });

  it("regenerates with the user's feedback on rejection, and writes the approved version", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    const firstDraft = gherkinResponse(
      'Feature: Log in\n\n  @screen:login\n  Scenario: v1\n    Then I see "Welcome back"\n'
    );
    const secondDraft = gherkinResponse(
      'Feature: Log in\n\n  @screen:login\n  Scenario: v2\n    Then I see "Email"\n'
    );
    const llm = new FakeLLMProvider([firstDraft, secondDraft]);
    const presentForApproval = vi
      .fn()
      .mockResolvedValueOnce({ approved: false, feedback: "añade el resultado esperado" })
      .mockResolvedValueOnce({ approved: true });

    const { plan } = await runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests",
      callbacks: { ...callbacks, presentForApproval }, emit: () => {},
    });

    expect(plan.featureText).toContain("Scenario: v2");
    const regenerationMessages = llm.receivedCalls[1];
    const regenerationPrompt = regenerationMessages[regenerationMessages.length - 1].content;
    expect(regenerationPrompt).toContain("añade el resultado esperado");
  });
});
