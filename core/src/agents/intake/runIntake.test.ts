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

// No @screen: tag anywhere — checkFeatureLiterals would silently report `missing: []`
// for this, so it must be caught by the screenTagFound gate instead.
const untagged = gherkinResponse(
  'Feature: Log in\n\n  Scenario: Invalid credentials show an error\n    Then I see "Invalid email or password"\n'
);

const ambiguityResolved = () => JSON.stringify({ ambiguous: false, questions: [] });

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

  it("skips a map scenario candidate whose screenId does not resolve, instead of crashing when the user picks it", async () => {
    // ScenarioCandidateSchema validates shape, never that screenId actually
    // resolves — a hallucinated screenId from generateScenarioCandidates would
    // otherwise reach gherkinGenerationPrompt verbatim and throw the bare
    // `La pantalla "X" no existe en el mapa.` with no recovery.
    const hallucinatedScenario: ScenarioCandidate = {
      id: "hallucinated", title: "Some ghost flow", screenId: "ghost",
      involvedScreens: ["ghost"], rationale: "Invented by a bad LLM response",
    };
    const mapWithBadScenario: AppMap = { ...baseMap, scenarios: [hallucinatedScenario, scenarioCandidate] };
    await saveAppMap(projectRoot, mapWithBadScenario);

    let offered: ScenarioCandidate[] = [];
    await runIntake({
      initialText: "", llm: new FakeLLMProvider([validPlanJson]),
      projectRoot, testsDir: "tests", emit: () => {},
      callbacks: { ...callbacks, chooseScenario: async (list) => { offered = list; return list[0] ?? null; } },
    });

    expect(offered).toEqual([scenarioCandidate]);
  });

  it("falls back to the freeform flow, without ever calling chooseScenario, when every map scenario candidate has a hallucinated screenId", async () => {
    const hallucinatedScenario: ScenarioCandidate = {
      id: "hallucinated", title: "Ghost flow", screenId: "ghost",
      involvedScreens: ["ghost"], rationale: "Invented",
    };
    const mapWithOnlyBadScenarios: AppMap = { ...baseMap, scenarios: [hallucinatedScenario] };
    await saveAppMap(projectRoot, mapWithOnlyBadScenarios);
    const llm = new FakeLLMProvider([ambiguityResolved(), validPlanJson]);
    const chooseScenario = vi.fn();

    await runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests",
      callbacks: { ...callbacks, chooseScenario },
      emit: () => {},
    });

    expect(chooseScenario).not.toHaveBeenCalled();
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

  it("falls back instead of ending with a dangling list when the exhausted plan's tag names a screen absent from the map", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    // The model can go rogue and tag a screen the map doesn't have — when that
    // happens, checkFeatureLiterals's `candidates` (real texts of THAT screen)
    // comes back empty, and the message must not end with a dangling
    // "Textos reales de esa pantalla: " with nothing after the colon.
    const ghostPlan = gherkinResponse(
      'Feature: Ghost\n\n  @screen:ghost\n  Scenario: X\n    Then I see "Anything"\n'
    );
    const llm = new FakeLLMProvider([ghostPlan, ghostPlan, ghostPlan]);

    let thrown: Error | undefined;
    try {
      await runIntake({
        initialText: "probar login", llm, projectRoot, testsDir: "tests", callbacks, emit: () => {},
      });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message.trimEnd()).not.toMatch(/Textos reales de esa pantalla:$/);
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

  it("regenerates instead of writing a plan whose feature carries no @screen: tag", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    const llm = new FakeLLMProvider([untagged, grounded]);
    const presented: string[] = [];

    const { filePath } = await runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests", emit: () => {},
      callbacks: { ...callbacks, presentForApproval: async (plan) => { presented.push(plan.featureText); return { approved: true }; } },
    });

    expect(presented).toHaveLength(1);
    expect(presented[0]).toContain("@screen:login");
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).not.toContain("Invalid email or password");
  });

  it("throws an actionable message naming the required @screen: tag when grounding attempts run out untagged", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    const llm = new FakeLLMProvider([untagged, untagged, untagged]);

    await expect(runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests", callbacks, emit: () => {},
    })).rejects.toThrow(/@screen:login/);
  });

  it("grounds a plan regenerated from user feedback before writing it — an ungrounded rewrite never reaches disk", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    const llm = new FakeLLMProvider([validPlanJson, invented, grounded]);
    const presentForApproval = vi
      .fn()
      .mockResolvedValueOnce({ approved: false, feedback: "añade el mensaje de error" })
      .mockResolvedValueOnce({ approved: true });

    const { filePath } = await runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests",
      callbacks: { ...callbacks, presentForApproval }, emit: () => {},
    });

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).not.toContain("Invalid email or password");
    expect(written).toContain("Authentication failed. Please try again.");
    expect(presentForApproval).toHaveBeenCalledTimes(2);
  });

  it("warns which screen a freeform request is grounded against when no map scenario was chosen", async () => {
    await saveAppMap(projectRoot, baseMap); // no scenarios: chooseScenario is never invoked
    const llm = new FakeLLMProvider([ambiguityResolved(), validPlanJson]);
    const events: AgentEvent[] = [];

    await runIntake({
      initialText: "probar login", llm, projectRoot, testsDir: "tests", callbacks,
      emit: (event) => events.push(event),
    });

    expect(
      events.some((e) => e.agent === "intake" && e.status === "warn" && e.message.includes(loginScreen.name))
    ).toBe(true);
  });

  it("throws an actionable error naming 'agente-qa map' when the map has no screens", async () => {
    await saveAppMap(projectRoot, { ...baseMap, screens: [] });

    await expect(runIntake({
      initialText: "probar algo", llm: new FakeLLMProvider([]), projectRoot, testsDir: "tests", callbacks, emit: () => {},
    })).rejects.toThrow(/agente-qa map/);
  });

  it("asks for the request text when the user declines the map's suggestions and typed nothing", async () => {
    await saveAppMap(projectRoot, mapWithScenario);
    const askUser = vi.fn().mockResolvedValue("probar login con credenciales inválidas");
    const llm = new FakeLLMProvider([ambiguityResolved(), validPlanJson]);

    await runIntake({
      initialText: "", llm, projectRoot, testsDir: "tests",
      callbacks: { ...callbacks, askUser, chooseScenario: async () => null },
      emit: () => {},
    });

    expect(askUser).toHaveBeenCalled();
    const ambiguityPrompt = llm.receivedCalls[0][llm.receivedCalls[0].length - 1].content;
    expect(ambiguityPrompt).toContain("probar login con credenciales inválidas");
  });
});
