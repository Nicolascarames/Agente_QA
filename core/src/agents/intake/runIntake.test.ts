import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { FakeSiteExplorer } from "../../siteExplorer/testUtils.js";
import { evidenceCacheKey, writeCachedEvidence } from "../../siteExplorer/evidenceCache.js";
import { runIntake, type IntakeCallbacks } from "./runIntake.js";
import type { Pattern } from "../../schemas/pattern.js";

const loginPattern: Pattern = {
  name: "login",
  description: "Inicio de sesión",
  gherkinTemplate: "Feature: Login\n  Scenario: x\n    Given a\n",
  pageObjectTemplate: "",
};

describe("runIntake", () => {
  let tmpProject: string;
  let callbacks: IntakeCallbacks;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-intake-"));
    callbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
      onExplorationStep: vi.fn(),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("happy path: no ambiguity, matches a pattern, approved on first try", async () => {
    const llm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);

    const { plan, filePath } = await runIntake({
      initialText: "quiero probar el login",
      llm,
      patterns: [loginPattern],
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "es",
      routes: {},
      callbacks,
    });

    expect(plan.fileName).toBe("login.feature");
    expect(plan.matchedPatternName).toBe("login");
    expect(callbacks.askUser).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf-8")).toContain(plan.featureText);
  });

  it("ambiguous + no match: asks clarifying questions and loops on rejection", async () => {
    // Note: no scripted response for pattern matching here — matchPattern (Task 12)
    // short-circuits with zero LLM calls when the patterns list is empty (see
    // matcher.test.ts: "returns null without calling the model when there are no
    // patterns"), so only 3 LLM calls actually happen: ambiguity check, initial
    // generation, and regeneration after rejection feedback.
    const llm = new FakeLLMProvider([
      '{"ambiguous": true, "questions": ["¿Qué navegador?"]}',
      "Feature: Caso custom\n  Scenario: x\n    Given a\n",
      "Feature: Caso custom v2\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);

    callbacks.askUser = vi.fn().mockResolvedValue("Chrome");
    callbacks.presentForApproval = vi
      .fn()
      .mockResolvedValueOnce({ approved: false, feedback: "añade el resultado esperado" })
      .mockResolvedValueOnce({ approved: true });

    const { plan, filePath } = await runIntake({
      initialText: "quiero probar algo",
      llm,
      patterns: [],
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "es",
      routes: {},
      callbacks,
    });

    expect(callbacks.askUser).toHaveBeenCalledWith("¿Qué navegador?");
    expect(plan.featureText).toContain("Caso custom v2");
    expect(plan.matchedPatternName).toBeNull();
    expect(await fs.readFile(filePath, "utf-8")).toBe(plan.featureText);

    // The regeneration call (after rejection) must show the model the previous
    // plan's featureText alongside the feedback, so it can apply the requested
    // change relative to something concrete instead of regenerating blind.
    // receivedCalls[0] = ambiguity check, [1] = initial generation,
    // [2] = regeneration after rejection (matchPattern makes no LLM call here
    // since patterns is empty).
    const firstPlanText = "Feature: Caso custom\n  Scenario: x\n    Given a\n";
    const regenerationMessages = llm.receivedCalls[2];
    const regenerationPrompt = regenerationMessages[regenerationMessages.length - 1].content;
    expect(regenerationPrompt).toContain(firstPlanText);
    expect(regenerationPrompt).toContain("añade el resultado esperado");
  });

  it("asks for confirmation before overwriting an existing feature file, and honors the answer", async () => {
    // First run: creates tests/features/login.feature from scratch.
    const firstRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const firstRunExplorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const firstRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
      onExplorationStep: vi.fn(),
    };
    const { plan: firstPlan, filePath } = await runIntake({
      initialText: "quiero probar el login",
      llm: firstRunLlm,
      patterns: [loginPattern],
      explorer: firstRunExplorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "es",
      routes: {},
      callbacks: firstRunCallbacks,
    });
    expect(firstRunCallbacks.confirmOverwrite).not.toHaveBeenCalled();
    const originalContent = await fs.readFile(filePath, "utf-8");
    expect(originalContent).toContain(firstPlan.featureText);

    // Second run against the same project/filename, with confirmOverwrite -> false:
    // must reject and leave the original file untouched (the reproduction from the review).
    const rejectRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: y\n    Given a2\n    When b2\n    Then c2\n",
    ]);
    const rejectRunExplorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const confirmOverwriteReject = vi.fn().mockResolvedValue(false);
    const rejectRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: confirmOverwriteReject,
      onExplorationStep: vi.fn(),
    };
    await expect(
      runIntake({
        initialText: "quiero probar el login otra vez",
        llm: rejectRunLlm,
        patterns: [loginPattern],
        explorer: rejectRunExplorer,
        projectRoot: tmpProject,
        testsDir: "tests",
        baseUrl: "https://app.test/",
        appLanguage: "es",
        routes: {},
        callbacks: rejectRunCallbacks,
      })
    ).rejects.toThrow(/Cancelado/);
    expect(confirmOverwriteReject).toHaveBeenCalledWith(filePath);
    expect(await fs.readFile(filePath, "utf-8")).toBe(originalContent);

    // Third run, with confirmOverwrite -> true: must succeed and overwrite the file.
    const acceptRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: z\n    Given a3\n    When b3\n    Then c3\n",
    ]);
    const acceptRunExplorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const acceptRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
      onExplorationStep: vi.fn(),
    };
    const { plan: thirdPlan } = await runIntake({
      initialText: "quiero probar el login de nuevo",
      llm: acceptRunLlm,
      patterns: [loginPattern],
      explorer: acceptRunExplorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "es",
      routes: {},
      callbacks: acceptRunCallbacks,
    });
    expect(thirdPlan.featureText).not.toBe(originalContent);
    expect(await fs.readFile(filePath, "utf-8")).toContain(thirdPlan.featureText);
  });

  it("explores the app and feeds the evidence into the Gherkin prompt", async () => {
    // patterns: [] makes matchPattern short-circuit with zero LLM calls (see
    // the "ambiguous + no match" test above), so only 2 real calls happen:
    // ambiguity check and Gherkin generation — no matchedPatternName response.
    const llm = new FakeLLMProvider([
      JSON.stringify({ ambiguous: false, questions: [] }),
      "Feature: Login\n  Scenario: x\n    Given y\n",
    ]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [
          { stepText: "pantalla en /", url: "https://app.test/", ariaSnapshot: '- heading "Welcome back"' },
        ],
      },
    ]);
    const steps: string[] = [];

    await runIntake({
      initialText: "probar el login",
      llm,
      patterns: [],
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "en",
      routes: {},
      callbacks: { ...callbacks, onExplorationStep: (m) => steps.push(m) },
    });

    expect(llm.lastPrompt()).toContain("Welcome back");
  });

  it("continues without evidence when the exploration fails, and says so", async () => {
    // patterns: [] makes matchPattern short-circuit with zero LLM calls (see
    // the "ambiguous + no match" test above), so only 2 real calls happen:
    // ambiguity check and Gherkin generation — no matchedPatternName response.
    const llm = new FakeLLMProvider([
      JSON.stringify({ ambiguous: false, questions: [] }),
      "Feature: Login\n  Scenario: x\n    Given y\n",
    ]);
    const explorer = new FakeSiteExplorer([{ ok: false, error: "la app no responde" }]);
    const steps: string[] = [];

    await runIntake({
      initialText: "probar el login",
      llm,
      patterns: [],
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "en",
      routes: {},
      callbacks: { ...callbacks, onExplorationStep: (m) => steps.push(m) },
    });

    expect(steps.join("\n")).toContain("la app no responde");
    expect(llm.lastPrompt()).toContain("No se pudo capturar evidencia");
  });

  it("reuses cached evidence instead of exploring again", async () => {
    await writeCachedEvidence(
      tmpProject,
      evidenceCacheKey({ appUrl: "https://app.test/", patternName: null, routes: {} }),
      [{ stepText: "cacheada", url: "https://app.test/", ariaSnapshot: '- heading "Desde caché"' }]
    );
    // patterns: [] makes matchPattern short-circuit with zero LLM calls (see
    // the "ambiguous + no match" test above), so only 2 real calls happen:
    // ambiguity check and Gherkin generation — no matchedPatternName response.
    const llm = new FakeLLMProvider([
      JSON.stringify({ ambiguous: false, questions: [] }),
      "Feature: Login\n  Scenario: x\n    Given y\n",
    ]);
    const explorer = new FakeSiteExplorer([]); // would throw if explored

    await runIntake({
      initialText: "probar el login",
      llm,
      patterns: [],
      explorer,
      projectRoot: tmpProject,
      testsDir: "tests",
      baseUrl: "https://app.test/",
      appLanguage: "en",
      routes: {},
      callbacks: { ...callbacks, onExplorationStep: () => {} },
    });

    expect(llm.lastPrompt()).toContain("Desde caché");
  });
});
