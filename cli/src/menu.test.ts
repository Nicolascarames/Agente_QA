import { describe, it, expect, vi, beforeEach } from "vitest";

const runCreatePlanMock = vi.fn();
const runInitMock = vi.fn();
const runGenerateTestsMock = vi.fn();
const runExecuteTestsMock = vi.fn();
const runGenerateReportsMock = vi.fn();

vi.mock("./commands/chat.js", () => ({
  runCreatePlan: (...args: unknown[]) => runCreatePlanMock(...args),
}));
vi.mock("./commands/init.js", () => ({
  runInit: (...args: unknown[]) => runInitMock(...args),
}));
vi.mock("./commands/generate.js", () => ({
  runGenerateTests: (...args: unknown[]) => runGenerateTestsMock(...args),
}));
vi.mock("./commands/execute.js", () => ({
  runExecuteTests: (...args: unknown[]) => runExecuteTestsMock(...args),
}));
vi.mock("./commands/reports.js", () => ({
  runGenerateReports: (...args: unknown[]) => runGenerateReportsMock(...args),
}));

import { runMenuLoop } from "./menu.js";
import type { MenuChoice } from "./prompts/types.js";

describe("runMenuLoop", () => {
  beforeEach(() => {
    runCreatePlanMock.mockReset();
    runInitMock.mockReset();
    runGenerateTestsMock.mockReset();
    runExecuteTestsMock.mockReset();
    runGenerateReportsMock.mockReset();
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
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
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
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
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
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
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
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runGenerateTestsMock).toHaveBeenCalledTimes(1);
  });

  it("routes 'run-tests' to runExecuteTests and prints the pass summary", async () => {
    const choices: MenuChoice[] = ["run-tests", "exit"];
    let i = 0;
    runExecuteTestsMock.mockResolvedValue({ exitCode: 0, junitXmlPath: "/tmp/tests/results/latest.xml" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runExecuteTestsMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Todos los tests pasaron."));

    logSpy.mockRestore();
  });

  it("prints the browser setup warning when runExecuteTests returns one", async () => {
    const choices: MenuChoice[] = ["run-tests", "exit"];
    let i = 0;
    runExecuteTestsMock.mockResolvedValue({
      exitCode: 1,
      junitXmlPath: "/tmp/tests/results/latest.xml",
      browserSetupWarning: 'Ejecuta "playwright install".',
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Algunos tests fallaron."));
    expect(logSpy).toHaveBeenCalledWith('Ejecuta "playwright install".');

    logSpy.mockRestore();
  });

  it("prints 'no se ejecutó ningún test' when runExecuteTests returns exitCode 5", async () => {
    const choices: MenuChoice[] = ["run-tests", "exit"];
    let i = 0;
    runExecuteTestsMock.mockResolvedValue({ exitCode: 5, junitXmlPath: "/tmp/tests/results/latest.xml" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No se ejecutó ningún test (revisa el filtro de tags seleccionado).")
    );

    logSpy.mockRestore();
  });

  it("prints 'no se completó correctamente' with the exit code when runExecuteTests returns an unexpected exitCode", async () => {
    const choices: MenuChoice[] = ["run-tests", "exit"];
    let i = 0;
    runExecuteTestsMock.mockResolvedValue({ exitCode: 2, junitXmlPath: "/tmp/tests/results/latest.xml" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("La ejecución de pytest no se completó correctamente (código de salida 2).")
    );

    logSpy.mockRestore();
  });

  it("routes 'reports' to runGenerateReports and prints the summary", async () => {
    const choices: MenuChoice[] = ["reports", "exit"];
    let i = 0;
    runGenerateReportsMock.mockResolvedValue({
      junitXmlPath: "/tmp/tests/results/latest.xml",
      htmlReportPath: "/tmp/tests/results/latest.html",
      summaryPath: "/tmp/tests/results/summary.md",
      totalTests: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(runGenerateReportsMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("2 pasados, 1 fallidos, 0 omitidos (3 en total)")
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("/tmp/tests/results/summary.md"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("/tmp/tests/results/latest.html"));

    logSpy.mockRestore();
  });

  it("catches errors from runGenerateReports and prints them", async () => {
    const choices: MenuChoice[] = ["reports", "exit"];
    let i = 0;
    runGenerateReportsMock.mockRejectedValue(new Error("No hay resultados de ejecución todavía. Usa 'Ejecutar tests' primero."));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runMenuLoop({
      menuPrompts: { selectMenuChoice: async () => choices[i++] },
      chatPrompts: {} as never,
      initPrompts: {} as never,
      generatorPrompts: {} as never,
      executorPrompts: {} as never,
      reportesPrompts: {} as never,
      homeDir: "/home/test",
      projectRoot: "/project/test",
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Error: No hay resultados de ejecución"));

    logSpy.mockRestore();
  });
});
