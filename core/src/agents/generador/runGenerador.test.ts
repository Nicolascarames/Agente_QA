import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLLMProvider } from "../../llm/testUtils.js";
import { FakeCodeChecker } from "../../codeCheck/testUtils.js";
import { FakeSiteExplorer } from "../../siteExplorer/testUtils.js";
import { runGenerador, type GeneratorCallbacks } from "./runGenerador.js";
import type { Pattern } from "../../schemas/pattern.js";

const loginPattern: Pattern = {
  name: "login",
  description: "Inicio de sesión",
  gherkinTemplate: "Feature: Login\n",
  pageObjectTemplate: "class LoginPage:\n    pass\n",
};

const scriptedResponse = `# FILE: tests/test_login.py
scenarios("../features/login.feature")
# FILE: pages/login_page.py
class LoginPage:
    def __init__(self, page):
        self.page = page
`;

function callbacks(overrides: Partial<GeneratorCallbacks> = {}): GeneratorCallbacks {
  return {
    offerSavePattern: vi.fn(),
    confirmOverwrite: vi.fn().mockResolvedValue(true),
    onExplorationStep: vi.fn(),
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

  it("happy path: matched pattern, checker passes first try, writes files, never offers to save a pattern", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks();

    const { writtenPaths } = await runGenerador(
      featureFilePath, llm, [loginPattern], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

    expect(writtenPaths).toHaveLength(2);
    expect(cb.offerSavePattern).not.toHaveBeenCalled();
    expect(
      await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")
    ).toContain("scenarios(");
  });

  it("no matched pattern: offers to save the pattern with the generated Page Object as its template", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({
      offerSavePattern: vi.fn().mockResolvedValue({ save: true, name: "checkout", description: "Flujo de compra" }),
    });

    await runGenerador(
      featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

    expect(cb.offerSavePattern).toHaveBeenCalledWith("Feature: Checkout\n");
    const savedRaw = await fs.readFile(
      path.join(tmpProject, ".agente-qa", "templates", "checkout.json"),
      "utf-8"
    );
    const saved = JSON.parse(savedRaw);
    expect(saved.name).toBe("checkout");
    expect(saved.pageObjectTemplate).toContain("class LoginPage");
  });

  it("retries on checker failure, feeding the error back as feedback, up to 3 corrections, without re-exploring", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse, scriptedResponse, scriptedResponse]);
    const checker = new FakeCodeChecker([
      { ok: false, errors: "SyntaxError: line 1" },
      { ok: false, errors: "SyntaxError: line 2" },
      { ok: true },
    ]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador(
      featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

    expect(checker.receivedCalls).toHaveLength(3);
    expect(explorer.receivedCalls).toHaveLength(1);
    const secondAttemptPrompt = llm.receivedCalls[1].find((m) => m.role === "user")?.content;
    expect(secondAttemptPrompt).toContain("SyntaxError: line 1");
    expect(secondAttemptPrompt).toContain("class LoginPage");
  });

  it("aborts without writing anything after 3 failed corrections (4 total attempts)", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse, scriptedResponse, scriptedResponse, scriptedResponse]);
    const checker = new FakeCodeChecker([
      { ok: false, errors: "e1" },
      { ok: false, errors: "e2" },
      { ok: false, errors: "e3" },
      { ok: false, errors: "e4" },
    ]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks();

    await expect(
      runGenerador(
        featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
      )
    ).rejects.toThrow(/4 intentos/);

    expect(cb.offerSavePattern).not.toHaveBeenCalled();
    const exists = await fs
      .access(path.join(tmpProject, "tests", "tests", "test_login.py"))
      .then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it("asks for overwrite confirmation when a target test file already exists, and honors a rejection", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    await fs.mkdir(path.join(tmpProject, "tests", "tests"), { recursive: true });
    await fs.writeFile(
      path.join(tmpProject, "tests", "tests", "test_login.py"),
      "# ya existente\n",
      "utf-8"
    );

    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ confirmOverwrite: vi.fn().mockResolvedValue(false) });

    await expect(
      runGenerador(
        featureFilePath, llm, [loginPattern], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
      )
    ).rejects.toThrow(/Cancelado/);

    expect(await fs.readFile(path.join(tmpProject, "tests", "tests", "test_login.py"), "utf-8")).toBe(
      "# ya existente\n"
    );
  });

  it("passes the feature's exact filename and slug to the code generator", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks();

    await runGenerador(
      featureFilePath, llm, [loginPattern], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("features/login.feature");
    expect(promptContent).toContain("test_login.py");
    expect(promptContent).toContain("login_page.py");
  });

  it("sanitizes a multi-word feature filename into a valid Python module slug", async () => {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    const featureFilePath = path.join(dir, "recuperar-contrasena.feature");
    await fs.writeFile(featureFilePath, "Feature: Recuperar contraseña\n", "utf-8");

    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador(
      featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("test_recuperar_contrasena.py");
    expect(promptContent).toContain("recuperar_contrasena_page.py");
    expect(promptContent).toContain("features/recuperar-contrasena.feature");
  });

  it("aborts with a clear error and never calls the LLM when exploration fails", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: false, error: "ninguna ruta conocida respondió" }]);
    const cb = callbacks();

    await expect(
      runGenerador(
        featureFilePath, llm, [], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
      )
    ).rejects.toThrow(/ninguna ruta conocida respondió/);

    expect(llm.receivedCalls).toHaveLength(0);
  });

  it("passes the explorer's real evidence into the code generation prompt", async () => {
    const featureFilePath = await writeFeature("# agente-qa:pattern=login\nFeature: Login\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([
      {
        ok: true,
        screens: [{ stepText: "pantalla de login", url: "https://example.com/login", ariaSnapshot: 'textbox "Email"' }],
      },
    ]);
    const cb = callbacks();

    await runGenerador(
      featureFilePath, llm, [loginPattern], checker, explorer, tmpProject, "tests", "https://example.com", undefined, cb
    );

    const promptContent = llm.receivedCalls[0].find((m) => m.role === "user")?.content;
    expect(promptContent).toContain("https://example.com/login");
    expect(promptContent).toContain('textbox "Email"');
  });

  it("passes baseUrl, credentials, and headed:true through to the explorer", async () => {
    const featureFilePath = await writeFeature("Feature: Checkout\n");
    const llm = new FakeLLMProvider([scriptedResponse]);
    const checker = new FakeCodeChecker([{ ok: true }]);
    const explorer = new FakeSiteExplorer([{ ok: true, screens: [] }]);
    const cb = callbacks({ offerSavePattern: vi.fn().mockResolvedValue({ save: false }) });

    await runGenerador(
      featureFilePath,
      llm,
      [],
      checker,
      explorer,
      tmpProject,
      "tests",
      "https://example.com",
      { username: "qa@example.com", password: "s3cret" },
      cb
    );

    expect(explorer.receivedCalls[0].baseUrl).toBe("https://example.com");
    expect(explorer.receivedCalls[0].credentials).toEqual({ username: "qa@example.com", password: "s3cret" });
    expect(explorer.receivedCalls[0].headed).toBe(true);
  });
});
