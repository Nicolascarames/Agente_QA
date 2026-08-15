import http from "node:http";
import type { AddressInfo } from "node:net";
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

interface GuardTestServer {
  url: string;
  close(): Promise<void>;
}

function guardFixtureLoginFieldsHtml(): string {
  return `<!doctype html>
<html>
<body>
  <form id="login-form">
    <label for="email">Correo electrónico</label>
    <input id="email" name="email" type="text" />
    <label for="password">Contraseña</label>
    <input id="password" name="password" type="password" />
    <button type="submit">Iniciar sesión</button>
  </form>
  <script>
    document.getElementById("login-form").addEventListener("submit", function (event) {
      event.preventDefault();
    });
  </script>
</body>
</html>`;
}

const GUARD_FIXTURE_LOCKED_OUT_PAGE = `<!doctype html><html><body><h1>Demasiados intentos</h1></body></html>`;

/**
 * A minimal, local-only, STATEFUL HTTP server used ONLY by the negative-probe
 * guard test below — deliberately not added as a mode to testFixtureApp.ts.
 * Every existing FixtureMode there serves static, stateless HTML, so a route
 * that has login fields on its first load still has them after a same-URL
 * reload; that means performRealLogin (called right after the probe's own
 * reload of the same candidate) can never fail to find fields on a candidate
 * the probe already fired on, so exploreByHints's candidate loop never
 * actually needs to `continue` past one — no existing mode can reproduce the
 * scenario the guard defends against. This server exists purely to construct
 * that one stateful edge case: "/login-a" has real login fields only on its
 * FIRST request (so the probe genuinely fires there) and lacks them from the
 * second request onward (so performRealLogin can't find them there and the
 * loop moves on to "/login-b", which always has fields). Without the guard,
 * the probe would fire again on "/login-b"; the test asserts it doesn't.
 */
function startNegativeProbeGuardFixture(): Promise<GuardTestServer> {
  let loginARequestCount = 0;
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const send = (status: number, body: string): void => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (url === "/login-a") {
      loginARequestCount += 1;
      return send(200, loginARequestCount === 1 ? guardFixtureLoginFieldsHtml() : GUARD_FIXTURE_LOCKED_OUT_PAGE);
    }
    if (url === "/login-b") {
      return send(200, guardFixtureLoginFieldsHtml());
    }
    send(404, "<!doctype html><html><body><h1>404</h1></body></html>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

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

    it.skipIf(!chromiumAvailable)(
      "captures a failed-login screen when the pattern declares a negative probe",
      async () => {
        const pattern: Pattern = {
          name: "login",
          description: "login",
          gherkinTemplate: "Feature: Login\n",
          pageObjectTemplate: "",
          navigationHints: {
            routeCandidates: ["/login"],
            requiresLogin: true,
            negativeProbe: { kind: "invalid-credentials" },
          },
        };
        const explorer = createRealSiteExplorer(new FakeLLMProvider([]));
        const result = await explorer.explore(
          baseInput({ baseUrl: app.url, matchedPattern: pattern, credentials: FIXTURE_CREDENTIALS })
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const probe = result.screens.find((s) => s.stepText.includes("credenciales incorrectas"));
        expect(probe).toBeDefined();
        expect(probe?.ariaSnapshot).toContain("Credenciales inválidas");
        // the real login still happened afterwards
        expect(result.screens.some((s) => s.stepText.includes("tras iniciar sesión"))).toBe(true);
        // the probe never leaks the real password
        expect(probe?.ariaSnapshot).not.toContain(FIXTURE_CREDENTIALS.password);
      }
    );

    it.skipIf(!chromiumAvailable)(
      "skips the probe on a usable-but-fields-less candidate without losing the chance to probe the later real login candidate, and never returns more than one probe screen",
      async () => {
        const pattern: Pattern = {
          name: "login",
          description: "login",
          gherkinTemplate: "Feature: Login\n",
          pageObjectTemplate: "",
          navigationHints: {
            // "/dashboard" is usable (it renders a button) but has no login
            // fields, so performRealLogin finds nothing there and the loop
            // continues to "/login" — the real login candidate.
            routeCandidates: ["/dashboard", "/login"],
            requiresLogin: true,
            negativeProbe: { kind: "invalid-credentials" },
          },
        };
        const explorer = createRealSiteExplorer(new FakeLLMProvider([]));
        const result = await explorer.explore(
          baseInput({ baseUrl: app.url, matchedPattern: pattern, credentials: FIXTURE_CREDENTIALS })
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // the loop really did skip /dashboard and land on /login
        expect(result.screens[0].url).toContain("/login");
        const probeScreens = result.screens.filter((s) => s.stepText.includes("credenciales incorrectas"));
        expect(probeScreens.length).toBeLessThanOrEqual(1);
        // and the probe still fired on /login, since /dashboard's no-op never consumed it
        expect(probeScreens).toHaveLength(1);
      }
    );
  });

  describe("negative probe guard (the probe fires at most once per explore() call)", () => {
    let guardServer: GuardTestServer;
    beforeAll(async () => {
      guardServer = await startNegativeProbeGuardFixture();
    });
    afterAll(async () => {
      await guardServer.close();
    });

    it.skipIf(!chromiumAvailable)(
      "never re-fires the negative probe on a second route candidate after the loop continues past one where fields vanished after the probe's reload",
      async () => {
        const pattern: Pattern = {
          name: "login",
          description: "login",
          gherkinTemplate: "Feature: Login\n",
          pageObjectTemplate: "",
          navigationHints: {
            routeCandidates: ["/login-a", "/login-b"],
            requiresLogin: true,
            negativeProbe: { kind: "invalid-credentials" },
          },
        };
        const explorer = createRealSiteExplorer(new FakeLLMProvider([]));
        const steps: string[] = [];

        const result = await explorer.explore(
          baseInput({ baseUrl: guardServer.url, matchedPattern: pattern, credentials: FIXTURE_CREDENTIALS }),
          (message) => steps.push(message)
        );

        expect(result.ok).toBe(true);
        // Confirms the loop genuinely continued past /login-a: its fields were
        // there for the probe's first pass but gone by the time performRealLogin
        // looked (the fixture serves the locked-out page from the 2nd request on).
        expect(steps.some((s) => s.includes("No se encontraron campos de login en /login-a"))).toBe(true);
        // The probe step itself — which only ever runs against a candidate that
        // genuinely has fields at the time it's checked, so each occurrence here
        // corresponds to a real fill+click, not a no-op — must appear at most
        // once across the whole exploration, never once per candidate.
        const probeSteps = steps.filter((s) => s.includes("Provocando un error de credenciales"));
        expect(probeSteps).toHaveLength(1);
      }
    );
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

    it("re-navigates to baseUrl before the agentic loop when escalating from a failed fast path, instead of starting from the last failed route", async () => {
      // Both known route candidates 404 in "custom" mode, so this escalates.
      // Before the fix, the agentic loop's first prompt/snapshot would come
      // from the LAST tried candidate (a dead-end 404), not a fresh baseUrl.
      const llm = new FakeLLMProvider([JSON.stringify({ action: "done" })]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: loginPattern, baseUrl: app.url }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      // A single "done" action with no navigation in between only reaches
      // baseUrl's root if the escalation actually re-navigated there first —
      // otherwise it would still be sitting on ".../signin" (the last candidate).
      expect(result.screens[0].url).toBe(`${app.url}/`);
    });

    it("tells the model what went wrong after a failed click, instead of repeating an unchanged prompt", async () => {
      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "click", role: "button", name: "no existe" }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: null, baseUrl: app.url }));

      expect(result.ok).toBe(true);
      expect(llm.receivedCalls).toHaveLength(2);
      const secondPrompt = llm.receivedCalls[1].find((m) => m.role === "user")?.content;
      expect(secondPrompt).toContain("La acción anterior no tuvo el efecto esperado");
      expect(secondPrompt).toContain('no se encontró ningún "button" con nombre "no existe"');
    });

    it("returns a clear failure instead of throwing when the model's response isn't valid JSON", async () => {
      const llm = new FakeLLMProvider(["esto no es JSON en absoluto"]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(baseInput({ matchedPattern: null, baseUrl: app.url }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toBeTruthy();
    });
  });

  describe("leaky app (native GET-method login form puts credentials in the URL on submit)", () => {
    let app: FixtureApp;
    beforeAll(async () => {
      app = await startFixtureApp("leaky");
    });
    afterAll(async () => {
      await app.close();
    });

    /**
     * Independently proves the raw leak vector is real, WITHOUT going through
     * createRealSiteExplorer at all: drives the fixture's native
     * (method="get", no JS) login form with a fresh, separate browser and
     * returns the resulting page.url() — pre-redaction. This is what the
     * "leaky" fixture's LEAKY_LOGIN_PAGE (see testFixtureApp.ts) actually
     * does when a real browser submits it.
     */
    async function captureRawLeakedUrl(
      credentials: { username: string; password: string }
    ): Promise<string> {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(new URL("/leaky", app.url).toString());
        await page.getByLabel("Correo electrónico").fill(credentials.username);
        await page.getByLabel("Contraseña").fill(credentials.password);
        await page.getByRole("button", { name: "Iniciar sesión" }).click();
        await page.waitForLoadState("networkidle").catch(() => {});
        return page.url();
      } finally {
        await browser.close();
      }
    }

    it("redacts a credential that leaks into page.url() after a native form submission, and never returns it to the caller or the LLM", async () => {
      // The native form submission really does put the password in the URL —
      // proves this test exercises the leak vector, not just a page that
      // never reaches it — checked independently of the explorer under test.
      const rawLeakedUrl = await captureRawLeakedUrl(FIXTURE_CREDENTIALS);
      expect(rawLeakedUrl).toContain(FIXTURE_CREDENTIALS.password);

      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "goto", target: "/leaky" }),
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
      if (!result.ok) throw new Error("unreachable");
      // Fixed: the real password is redacted before it's ever returned to the caller.
      expect(result.screens[0].url).not.toContain(FIXTURE_CREDENTIALS.password);
      expect(new URL(result.screens[0].url).searchParams.get("password")).toBe("[REDACTED]");

      const allPromptText = llm.receivedCalls.flat().map((m) => m.content).join("\n");
      expect(allPromptText).not.toContain(FIXTURE_CREDENTIALS.password);
    });

    it("redacts a credential containing URL-reserved characters, whether it lands raw or percent-encoded in the URL", async () => {
      // "@" and "+" get percent-encoded, and a space is form-encoded as "+" (not "%20"),
      // by a real browser serializing a native application/x-www-form-urlencoded GET form.
      const reservedCredentials = { username: "leaky.user+tag@example.com", password: "s3cr3t pass+val" };
      const formEncodedPassword = encodeURIComponent(reservedCredentials.password).replace(/%20/g, "+");

      const rawLeakedUrl = await captureRawLeakedUrl(reservedCredentials);
      expect(rawLeakedUrl).toContain(formEncodedPassword);

      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "goto", target: "/leaky" }),
        JSON.stringify({ action: "fill_credential", labelText: "Correo electrónico", field: "username" }),
        JSON.stringify({ action: "fill_credential", labelText: "Contraseña", field: "password" }),
        JSON.stringify({ action: "click", role: "button", name: "Iniciar sesión" }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(
        baseInput({ matchedPattern: null, baseUrl: app.url, credentials: reservedCredentials })
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      // Fixed: none of the raw/encoded forms of the password make it into the
      // evidence returned to the caller.
      expect(result.screens[0].url).not.toContain(reservedCredentials.password);
      expect(result.screens[0].url).not.toContain(encodeURIComponent(reservedCredentials.password));
      expect(result.screens[0].url).not.toContain(formEncodedPassword);

      const allPromptText = llm.receivedCalls.flat().map((m) => m.content).join("\n");
      expect(allPromptText).not.toContain(reservedCredentials.password);
      expect(allPromptText).not.toContain(encodeURIComponent(reservedCredentials.password));
      expect(allPromptText).not.toContain(formEncodedPassword);
      expect(allPromptText).not.toContain(reservedCredentials.username);
      expect(allPromptText).not.toContain(encodeURIComponent(reservedCredentials.username));
    });

    it("redacts a credential containing characters WHATWG form-urlencoded escapes but encodeURIComponent does not (! ' ( ) ~)", async () => {
      // application/x-www-form-urlencoded (what a real browser uses to serialize a
      // native form) percent-encodes a wider character set than encodeURIComponent —
      // it also escapes "! ' ( ) ~". A redaction approach that only strips the raw
      // value plus its encodeURIComponent() form would miss this entirely.
      const trickyCredentials = { username: "leaky-user", password: "it's!weird(pass)~end" };

      // Confirm the leak vector is genuinely exercised: decoding the raw URL a
      // native form submission actually produces gives back the exact real password.
      const rawLeakedUrl = await captureRawLeakedUrl(trickyCredentials);
      expect(new URL(rawLeakedUrl).searchParams.get("password")).toBe(trickyCredentials.password);

      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "goto", target: "/leaky" }),
        JSON.stringify({ action: "fill_credential", labelText: "Correo electrónico", field: "username" }),
        JSON.stringify({ action: "fill_credential", labelText: "Contraseña", field: "password" }),
        JSON.stringify({ action: "click", role: "button", name: "Iniciar sesión" }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(
        baseInput({ matchedPattern: null, baseUrl: app.url, credentials: trickyCredentials })
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      // Fixed: the password param is redacted in the evidence returned to the caller.
      const evidenceUrl = new URL(result.screens[0].url);
      expect(evidenceUrl.searchParams.get("password")).not.toBe(trickyCredentials.password);

      const allPromptText = llm.receivedCalls.flat().map((m) => m.content).join("\n");
      expect(allPromptText).not.toContain(trickyCredentials.password);
      // Assert against the browser's *actual* encoded form (via URLSearchParams,
      // which implements the real spec), not a guessed/hand-rolled encoding.
      const realEncodedPassword = new URLSearchParams({ password: trickyCredentials.password })
        .toString()
        .replace("password=", "");
      expect(allPromptText).not.toContain(realEncodedPassword);
    });
  });

  describe("portal app (a real link on the page leads off to a different origin)", () => {
    // Two separate fixture servers on 127.0.0.1 at different ports ARE
    // different origins (WHATWG origin = scheme + host + port) — this is a
    // real cross-origin browser navigation, not a simulated one.
    let destination: FixtureApp;
    let portal: FixtureApp;
    let redirectingLoginApp: FixtureApp;
    beforeAll(async () => {
      destination = await startFixtureApp("spa"); // serves a real login form at "/"
      portal = await startFixtureApp("portal", { crossOriginTarget: destination.url });
      redirectingLoginApp = await startFixtureApp("redirect-login", { crossOriginTarget: `${destination.url}/` });
    });
    afterAll(async () => {
      await portal.close();
      await destination.close();
      await redirectingLoginApp.close();
    });

    it("refuses to navigate to a different origin when the model requests an absolute cross-origin goto", async () => {
      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "goto", target: destination.url }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);
      const steps: string[] = [];

      const result = await explorer.explore(
        baseInput({ matchedPattern: null, baseUrl: portal.url }),
        (message) => steps.push(message)
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      // Still on the configured origin — the cross-origin goto never happened.
      expect(new URL(result.screens[0].url).origin).toBe(new URL(portal.url).origin);
      expect(steps.some((s) => s.includes("otro origen bloqueada"))).toBe(true);
    });

    it("refuses to fill credentials after a real click takes it to a different origin, never typing the credential there", async () => {
      const llm = new FakeLLMProvider([
        JSON.stringify({ action: "click", role: "link", name: "Portal externo" }),
        JSON.stringify({ action: "fill_credential", labelText: "Correo electrónico", field: "username" }),
        JSON.stringify({ action: "done" }),
      ]);
      const explorer = createRealSiteExplorer(llm);
      const steps: string[] = [];

      const result = await explorer.explore(
        baseInput({ matchedPattern: null, baseUrl: portal.url, credentials: FIXTURE_CREDENTIALS }),
        (message) => steps.push(message)
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      // The click genuinely left the configured origin (a real <a href> navigation,
      // not something our own goto-guard would ever see or block).
      expect(new URL(result.screens[0].url).origin).toBe(new URL(destination.url).origin);
      expect(new URL(result.screens[0].url).origin).not.toBe(new URL(portal.url).origin);
      // The credential was never actually typed into the off-origin page.
      expect(result.screens[0].ariaSnapshot).not.toContain(FIXTURE_CREDENTIALS.username);
      expect(steps.some((s) => s.includes("Relleno de credenciales bloqueado"))).toBe(true);
    });

    it("refuses to fill credentials via the fast path (performRealLogin) when the login route redirects to a different origin", async () => {
      // The COMMON case: a pattern's navigationHints.requiresLogin routes
      // through performRealLogin, not the agentic loop. An app whose login
      // route 302s to a hosted external IdP (Clerk/Auth0/Okta-style) must get
      // the same safe default as the agentic path — never type real
      // credentials outside the configured origin.
      const externalLoginPattern: Pattern = {
        ...loginPattern,
        navigationHints: { routeCandidates: ["/login"], requiresLogin: true },
      };
      const llm = new FakeLLMProvider([]);
      const explorer = createRealSiteExplorer(llm);

      const result = await explorer.explore(
        baseInput({
          matchedPattern: externalLoginPattern,
          baseUrl: redirectingLoginApp.url,
          credentials: FIXTURE_CREDENTIALS,
        })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("origen");
      // Never escalated to the LLM, and (by construction, since we returned
      // before calling performRealLogin) never typed the credential anywhere.
      expect(llm.receivedCalls).toHaveLength(0);
    });
  });
});
