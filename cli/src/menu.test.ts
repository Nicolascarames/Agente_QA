import { describe, it, expect, vi, beforeEach } from "vitest";

const runCreatePlanMock = vi.fn();
const runInitMock = vi.fn();
const runGenerateTestsMock = vi.fn();

vi.mock("./commands/chat.js", () => ({
  runCreatePlan: (...args: unknown[]) => runCreatePlanMock(...args),
}));
vi.mock("./commands/init.js", () => ({
  runInit: (...args: unknown[]) => runInitMock(...args),
}));
vi.mock("./commands/generate.js", () => ({
  runGenerateTests: (...args: unknown[]) => runGenerateTestsMock(...args),
}));

import { runMenuLoop } from "./menu.js";
import type { MenuChoice } from "./prompts/types.js";

describe("runMenuLoop", () => {
  beforeEach(() => {
    runCreatePlanMock.mockReset();
    runInitMock.mockReset();
    runGenerateTestsMock.mockReset();
  });

  it("routes 'create-plan' to runCreatePlan and exits on 'exit'", async () => {
    const choices: MenuChoice[] = ["create-plan", "exit"];
    let i = 0;
    runCreatePlanMock.mockResolvedValue("/tmp/tests/features/login.feature");

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runCreatePlanMock).toHaveBeenCalledTimes(1);
  });

  it("catches errors from runCreatePlan, prints them, and returns to the next menu prompt", async () => {
    const choices: MenuChoice[] = ["create-plan", "exit"];
    let i = 0;
    runCreatePlanMock.mockRejectedValue(
      new Error("No hay credenciales configuradas. Ejecuta 'agente-qa init' primero.")
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error: No hay credenciales configuradas")
    );
    expect(i).toBe(2);

    logSpy.mockRestore();
  });

  it("routes 'config' to runInit", async () => {
    const choices: MenuChoice[] = ["config", "exit"];
    let i = 0;

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runInitMock).toHaveBeenCalledTimes(1);
  });

  it("routes 'generate-tests' to runGenerateTests", async () => {
    const choices: MenuChoice[] = ["generate-tests", "exit"];
    let i = 0;
    runGenerateTestsMock.mockResolvedValue(["/tmp/tests/tests/test_login.py"]);

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runGenerateTestsMock).toHaveBeenCalledTimes(1);
  });

  it("loops through remaining unimplemented choices before exiting", async () => {
    const choices: MenuChoice[] = ["run-tests", "reports", "exit"];
    let i = 0;

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(i).toBe(3);
    expect(runCreatePlanMock).not.toHaveBeenCalled();
    expect(runInitMock).not.toHaveBeenCalled();
    expect(runGenerateTestsMock).not.toHaveBeenCalled();
  });
});
