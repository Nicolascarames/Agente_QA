import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
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

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-intake-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("happy path: no ambiguity, matches a pattern, approved on first try, no save offer", async () => {
    const llm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);

    const callbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const { plan, filePath } = await runIntake(
      "quiero probar el login",
      llm,
      [loginPattern],
      tmpProject,
      "tests",
      callbacks
    );

    expect(plan.fileName).toBe("login.feature");
    expect(callbacks.askUser).not.toHaveBeenCalled();
    expect(callbacks.offerSavePattern).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf-8")).toBe(plan.featureText);
  });

  it("ambiguous + no match: asks clarifying questions, loops on rejection, saves new pattern on approval", async () => {
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

    const callbacks: IntakeCallbacks = {
      askUser: vi.fn().mockResolvedValue("Chrome"),
      presentForApproval: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, feedback: "añade el resultado esperado" })
        .mockResolvedValueOnce({ approved: true }),
      offerSavePattern: vi
        .fn()
        .mockResolvedValue({ save: true, name: "caso-custom", description: "Caso de prueba a medida" }),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };

    const { plan, filePath } = await runIntake(
      "quiero probar algo",
      llm,
      [],
      tmpProject,
      "tests",
      callbacks
    );

    expect(callbacks.askUser).toHaveBeenCalledWith("¿Qué navegador?");
    expect(plan.featureText).toContain("Caso custom v2");
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

    const savedPatternRaw = await fs.readFile(
      path.join(tmpProject, ".agente-qa", "templates", "caso-custom.json"),
      "utf-8"
    );
    const savedPattern = JSON.parse(savedPatternRaw);
    expect(savedPattern.name).toBe("caso-custom");
    expect(savedPattern.gherkinTemplate).toBe(plan.featureText);
  });

  it("asks for confirmation before overwriting an existing feature file, and honors the answer", async () => {
    // First run: creates tests/features/login.feature from scratch.
    const firstRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: x\n    Given a\n    When b\n    Then c\n",
    ]);
    const firstRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };
    const { plan: firstPlan, filePath } = await runIntake(
      "quiero probar el login",
      firstRunLlm,
      [loginPattern],
      tmpProject,
      "tests",
      firstRunCallbacks
    );
    expect(firstRunCallbacks.confirmOverwrite).not.toHaveBeenCalled();
    const originalContent = await fs.readFile(filePath, "utf-8");
    expect(originalContent).toBe(firstPlan.featureText);

    // Second run against the same project/filename, with confirmOverwrite -> false:
    // must reject and leave the original file untouched (the reproduction from the review).
    const rejectRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: y\n    Given a2\n    When b2\n    Then c2\n",
    ]);
    const confirmOverwriteReject = vi.fn().mockResolvedValue(false);
    const rejectRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      offerSavePattern: vi.fn(),
      confirmOverwrite: confirmOverwriteReject,
    };
    await expect(
      runIntake(
        "quiero probar el login otra vez",
        rejectRunLlm,
        [loginPattern],
        tmpProject,
        "tests",
        rejectRunCallbacks
      )
    ).rejects.toThrow(/Cancelado/);
    expect(confirmOverwriteReject).toHaveBeenCalledWith(filePath);
    expect(await fs.readFile(filePath, "utf-8")).toBe(originalContent);

    // Third run, with confirmOverwrite -> true: must succeed and overwrite the file.
    const acceptRunLlm = new FakeLLMProvider([
      '{"ambiguous": false, "questions": []}',
      '{"matchedPatternName": "login"}',
      "Feature: Login\n  Scenario: z\n    Given a3\n    When b3\n    Then c3\n",
    ]);
    const acceptRunCallbacks: IntakeCallbacks = {
      askUser: vi.fn(),
      presentForApproval: vi.fn().mockResolvedValue({ approved: true }),
      offerSavePattern: vi.fn(),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    };
    const { plan: thirdPlan } = await runIntake(
      "quiero probar el login de nuevo",
      acceptRunLlm,
      [loginPattern],
      tmpProject,
      "tests",
      acceptRunCallbacks
    );
    expect(thirdPlan.featureText).not.toBe(originalContent);
    expect(await fs.readFile(filePath, "utf-8")).toBe(thirdPlan.featureText);
  });
});
