import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { createRealSiteExplorer, MissingExplorerToolError } from "./realSiteExplorer.js";
import { startFixtureApp, FIXTURE_CREDENTIALS, type FixtureApp } from "./testFixtureApp.js";
import { FakeLLMProvider } from "../llm/testUtils.js";
import type { Pattern } from "../schemas/pattern.js";
import type { ExplorationInput } from "./siteExplorer.js";

async function hasChromium(): Promise<boolean> {
  try {
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const chromiumAvailable = await hasChromium();

describe("createRealSiteExplorer missing tool handling", () => {
  it("throws MissingExplorerToolError when the browser executable doesn't exist", async () => {
    const explorer = createRealSiteExplorer(new FakeLLMProvider([]), {
      executablePath: "/definitely/missing/chromium-binary",
    });
    await expect(
      explorer.explore({
        featureText: "Feature: x\n",
        matchedPattern: null,
        baseUrl: "http://127.0.0.1:1",
        headed: false,
      })
    ).rejects.toThrow(MissingExplorerToolError);
  });
});

function baseInput(overrides: Partial<ExplorationInput> = {}): ExplorationInput {
  return {
    featureText: "Feature: Login\n  Scenario: entrar\n    Given estoy en la página de login\n",
    matchedPattern: null,
    baseUrl: "http://127.0.0.1",
    headed: false,
    ...overrides,
  };
}

const loginPattern: Pattern = {
  name: "login",
  description: "login",
  gherkinTemplate: "Feature: Login\n",
  pageObjectTemplate: "",
  navigationHints: { routeCandidates: ["/login", "/signin"], requiresLogin: true },
};

describe.skipIf(!chromiumAvailable)("createRealSiteExplorer (requires Playwright Chromium installed)", () => {
  describe("conventional app (real routes match the known pattern)", () => {
    let app: FixtureApp;
    beforeAll(async () => {
      app = await startFixtureApp("conventional");
    });
    afterAll(async () => {
      await app.close();
    });

    it("fast path finds /login, logs in for real, and captures both screens without ever calling the LLM", async () => {
      const llm = new FakeLLMProvider([]);
      const explorer = createRealSiteExplorer(llm);
      const steps: string[] = [];

      const result = await explorer.explore(
        baseInput({ matchedPattern: loginPattern, baseUrl: app.url, credentials: FIXTURE_CREDENTIALS }),
        (message) => steps.push(message)
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.screens).toHaveLength(2);
      expect(result.screens[0].url).toContain("/login");
      expect(result.screens[1].url).toContain("/dashboard");
      expect(result.screens[1].ariaSnapshot).toContain("Cerrar sesión");
      expect(llm.receivedCalls).toHaveLength(0);
      expect(steps.some((s) => s.includes("/login"))).toBe(true);
    });

    it("returns a clear error when the pattern requires login but no credentials were configured", async () => {
      const explorer = createRealSiteExplorer(new FakeLLMProvider([]));
      const result = await explorer.explore(baseInput({ matchedPattern: loginPattern, baseUrl: app.url }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("AGENTE_QA_TEST_USERNAME");
    });
  });

  describe("spa app (login only reachable at the root — the exact bug this feature fixes)", () => {
    let app: FixtureApp;
    beforeAll(async () => {
      app = await startFixtureApp("spa");
    });
    afterAll(async () => {
      await app.close();
    });

    it("finds the login form at the root when /login and /signin both 404, without escalating to the agentic path", async () => {
      const patternWithRootFallback: Pattern = {
        ...loginPattern,
        navigationHints: { routeCandidates: ["/login", "/signin", "/"], requiresLogin: false },
      };
      const llm = new FakeLLMProvider([]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: patternWithRootFallback, baseUrl: app.url }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.screens[0].url).toBe(`${app.url}/`);
      expect(llm.receivedCalls).toHaveLength(0);
    });
  });

  describe("custom app (login lives outside any known route candidate)", () => {
    let app: FixtureApp;
    beforeAll(async () => {
      app = await startFixtureApp("custom");
    });
    afterAll(async () => {
      await app.close();
    });

    it("escalates to the agentic path when every route candidate fails, and reaches the target via the model's actions", async () => {
      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "goto", target: "/access" }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: loginPattern, baseUrl: app.url }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.screens[0].url).toContain("/access");
      expect(llm.receivedCalls.length).toBeGreaterThan(0);
    });

    it("fills credentials via the driver without ever sending the real password to the LLM", async () => {
      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "goto", target: "/access" }),
        JSON.stringify({ action: "fill_credential", labelText: "Correo electrónico", field: "username" }),
        JSON.stringify({ action: "fill_credential", labelText: "Contraseña", field: "password" }),
        JSON.stringify({ action: "click", role: "button", name: "Iniciar sesión" }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(
        baseInput({ matchedPattern: null, baseUrl: app.url, credentials: FIXTURE_CREDENTIALS })
      );

      expect(result.ok).toBe(true);
      const allPromptText = llm.receivedCalls.flat().map((m) => m.content).join("\n");
      expect(allPromptText).not.toContain(FIXTURE_CREDENTIALS.password);
    });

    it("fails clearly after exceeding the step limit instead of looping forever", async () => {
      const neverDone = JSON.stringify({ action: "click", role: "button", name: "no existe" });
      const llm = new FakeLLMProvider(new Array(25).fill(neverDone));
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: null, baseUrl: app.url }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("20 acciones");
      expect(llm.receivedCalls).toHaveLength(20);
    });
  });
});
