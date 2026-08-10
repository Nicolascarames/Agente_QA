import { describe, it, expect, vi, beforeEach } from "vitest";

const runCreatePlanMock = vi.fn();
const runInitMock = vi.fn();

vi.mock("./commands/chat.js", () => ({
  runCreatePlan: (...args: unknown[]) => runCreatePlanMock(...args),
}));
vi.mock("./commands/init.js", () => ({
  runInit: (...args: unknown[]) => runInitMock(...args),
}));

import { runMenuLoop } from "./menu.js";
import type { MenuChoice } from "./prompts/types.js";

describe("runMenuLoop", () => {
  beforeEach(() => {
    runCreatePlanMock.mockReset();
    runInitMock.mockReset();
  });

  it("routes 'create-plan' to runCreatePlan and exits on 'exit'", async () => {
    const choices: MenuChoice[] = ["create-plan", "exit"];
    let i = 0;
    runCreatePlanMock.mockResolvedValue("/tmp/tests/features/login.feature");

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runCreatePlanMock).toHaveBeenCalledTimes(1);
  });

  it("routes 'config' to runInit", async () => {
    const choices: MenuChoice[] = ["config", "exit"];
    let i = 0;

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runInitMock).toHaveBeenCalledTimes(1);
  });

  it("loops through multiple choices before exiting", async () => {
    const choices: MenuChoice[] = ["generate-tests", "run-tests", "reports", "exit"];
    let i = 0;

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(i).toBe(4);
    expect(runCreatePlanMock).not.toHaveBeenCalled();
    expect(runInitMock).not.toHaveBeenCalled();
  });
});
