import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExploradorCallbacks, WriteAction } from "@agente-qa/core";

const confirmMock = vi.fn();
const checkboxMock = vi.fn();

vi.mock("@inquirer/prompts", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  checkbox: (...args: unknown[]) => checkboxMock(...args),
}));

import { runMapCommand } from "./map.js";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    runExplorador: vi.fn(async (_opts: unknown) => ({ map: { stats: { screens: 2 } }, mapPath: "/tmp/map.json", writtenPaths: ["/tmp/pages/a.py"] })),
    loadConfig: vi.fn(async () => ({
      testsDir: "tests", appUrl: "https://example.test/",
      crawl: { maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60, loopSuspicionThreshold: 3, excludeRoutes: [] },
    })),
    loadEnv: vi.fn(async () => ({ testUsername: "u", testPassword: "p" })),
    buildLlm: vi.fn(async () => ({ generate: vi.fn(async () => "") })),
    log: vi.fn(),
    ...overrides,
  };
}

describe("runMapCommand", () => {
  it("passes the configured limits through to the agent", async () => {
    const d = deps();
    await runMapCommand("/project", d as never);
    expect(d.runExplorador).toHaveBeenCalledTimes(1);
    expect((d.runExplorador.mock.calls[0][0] as { limits: { maxScreens: number } }).limits.maxScreens).toBe(500);
  });

  it("passes the test credentials through when present", async () => {
    const d = deps();
    await runMapCommand("/project", d as never);
    const passed = d.runExplorador.mock.calls[0][0] as { credentials?: { username: string } };
    expect(passed.credentials?.username).toBe("u");
  });

  it("prints a warning about mapping with a real account before starting", async () => {
    const d = deps();
    await runMapCommand("/project", d as never);
    expect(d.log.mock.calls.flat().join("\n")).toMatch(/cuenta de pruebas/i);
  });

  it("reports the failure message when the agent throws", async () => {
    const d = deps({ runExplorador: vi.fn(async () => { throw new Error("sin navegador"); }) });
    await runMapCommand("/project", d as never);
    expect(d.log.mock.calls.flat().join("\n")).toContain("sin navegador");
  });
});

function writeAction(locator: string, label = "Enviar"): WriteAction {
  return { locator, label, kind: "submit", formFields: [] };
}

async function extractCallbacks(overrides: Record<string, unknown> = {}) {
  const d = deps(overrides);
  await runMapCommand("/project", d as never);
  const passed = d.runExplorador.mock.calls[0][0] as { callbacks: ExploradorCallbacks };
  return { d, callbacks: passed.callbacks };
}

describe("approveWriteActions callback", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    checkboxMock.mockReset();
  });

  it("round-trips screenId and locator for two actions on the same screen with different locators", async () => {
    const { callbacks } = await extractCallbacks();
    const actions = [
      { screenId: "checkout", action: writeAction("btn_pay", "Pagar") },
      { screenId: "checkout", action: writeAction("btn_cancel", "Cancelar") },
    ];
    checkboxMock.mockResolvedValueOnce(["checkout::btn_pay", "checkout::btn_cancel"]);

    const approved = await callbacks.approveWriteActions(actions);

    expect(approved).toEqual([
      { screenId: "checkout", locator: "btn_pay" },
      { screenId: "checkout", locator: "btn_cancel" },
    ]);
  });

  it("returns an empty array when given no actions, without prompting", async () => {
    const { callbacks } = await extractCallbacks();

    const approved = await callbacks.approveWriteActions([]);

    expect(approved).toEqual([]);
    expect(checkboxMock).not.toHaveBeenCalled();
  });

  it("returns only the entries the user actually selected, nothing pre-approved", async () => {
    const { callbacks } = await extractCallbacks();
    const actions = [
      { screenId: "checkout", action: writeAction("btn_pay", "Pagar") },
      { screenId: "checkout", action: writeAction("btn_cancel", "Cancelar") },
    ];
    checkboxMock.mockResolvedValueOnce(["checkout::btn_pay"]);

    const approved = await callbacks.approveWriteActions(actions);

    expect(approved).toEqual([{ screenId: "checkout", locator: "btn_pay" }]);
    const passedChoices = checkboxMock.mock.calls[0][0] as { choices: Array<{ checked?: boolean }> };
    expect(passedChoices.choices.every((choice) => !choice.checked)).toBe(true);
  });
});

describe("confirmContinueOnLoop callback", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    checkboxMock.mockReset();
  });

  it("returns what the user answered", async () => {
    const { callbacks } = await extractCallbacks();
    confirmMock.mockResolvedValueOnce(false);

    const result = await callbacks.confirmContinueOnLoop({ urlTemplate: "/product/:id", repeats: 5 });

    expect(result).toBe(false);
  });
});
