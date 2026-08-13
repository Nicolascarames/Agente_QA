import { chromium, type Browser, type Page } from "playwright";
import type { LLMProvider } from "../llm/provider.js";
import { parseJsonResponse } from "../llm/parseJson.js";
import { ExplorerActionSchema } from "./explorerAction.js";
import { explorerActionPrompt } from "../prompts/explorer.js";
import type {
  SiteExplorer,
  ExplorationInput,
  ExplorationResult,
  ExplorationStepCallback,
  ScreenEvidence,
} from "./siteExplorer.js";

export class MissingExplorerToolError extends Error {
  constructor(detail: string) {
    super(
      `No se pudo abrir el navegador para explorar la aplicación: ${detail}. Instala los navegadores de Playwright con "npx playwright install chromium".`
    );
    this.name = "MissingExplorerToolError";
  }
}

const MAX_AGENTIC_STEPS = 20;
const AGENTIC_ACTION_TIMEOUT_MS = 3000;

async function launchBrowser(headed: boolean, executablePath?: string): Promise<Browser> {
  try {
    return await chromium.launch({ headless: !headed, executablePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MissingExplorerToolError(message);
  }
}

async function ariaSnapshotOf(page: Page): Promise<string> {
  return page.locator("body").ariaSnapshot();
}

/**
 * The real credential values must never reach the LLM. ariaSnapshot() echoes
 * back the live value typed into a field (e.g. `textbox "Contraseña": hunter2-test-only`)
 * as plain accessibility-tree text — never URL-encoded — so a direct literal
 * substring strip is correct and sufficient for it.
 */
function redactLiteralCredentials(
  text: string,
  credentials: { username: string; password: string } | undefined
): string {
  if (!credentials) return text;
  let redacted = text;
  for (const value of [credentials.password, credentials.username]) {
    if (!value) continue;
    redacted = redacted.split(value).join("••••••••");
  }
  return redacted;
}

/**
 * page.url() can carry a credential in a query string after a native
 * (non-preventDefault) GET-method login form submits (e.g. "?password=...").
 * A browser serializes that per the WHATWG application/x-www-form-urlencoded
 * spec, whose percent-encode set is wider than encodeURIComponent's (it also
 * escapes "! ' ( ) ~", among others, and encodes a space as "+"). Enumerating
 * every encoding a browser might produce is fragile — this has already leaked
 * two different character sets across two rounds. Instead: parse the URL and
 * compare each query param's DECODED value (what URLSearchParams.get already
 * gives back, matching what the browser actually produced, by construction)
 * against the real credential, and redact the param in place. A literal pass
 * over the reconstructed string is still run as a fallback, in case a
 * credential ends up somewhere other than a query param value (e.g. a path
 * segment) or the URL fails to parse.
 */
function redactCredentialsFromUrl(
  url: string,
  credentials: { username: string; password: string } | undefined
): string {
  if (!credentials) return url;

  let working = url;
  try {
    const parsed = new URL(url);
    const keysToRedact: string[] = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      if ((credentials.username && value === credentials.username) || (credentials.password && value === credentials.password)) {
        keysToRedact.push(key);
      }
    }
    for (const key of keysToRedact) {
      parsed.searchParams.set(key, "[REDACTED]");
    }
    working = parsed.toString();
  } catch {
    // Not a parseable absolute URL — fall through to the literal pass below.
  }

  return redactLiteralCredentials(working, credentials);
}

/**
 * The agentic path's `goto`/`click` targets come from the LLM's reading of the
 * page (indirectly, from whatever the app under test rendered) — not from the
 * user's own config. A page under test can legitimately link off-origin (a
 * "Login with Google" button, an ad, a compromised/XSS'd link), and the LLM
 * has no way to know that following it is unsafe. Filling real test
 * credentials into a form on any origin other than the one the user actually
 * configured (AGENTE_QA_APP_URL) would hand that credential to a third party
 * the user never approved. This check is the last line of defense right
 * before the one action that actually types a secret into a page.
 */
function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

async function looksLikeUsablePage(page: Page): Promise<boolean> {
  const count = await page.getByRole("textbox").or(page.getByRole("button")).count();
  return count > 0;
}

const LOGIN_FIELD_LABEL = /correo|usuario|email|user/i;
const PASSWORD_FIELD_LABEL = /contraseña|password/i;
const SUBMIT_BUTTON_NAME = /iniciar sesión|ingresar|log ?in/i;

async function performRealLogin(
  page: Page,
  credentials: { username: string; password: string }
): Promise<ScreenEvidence | null> {
  const emailField = page.getByLabel(LOGIN_FIELD_LABEL).first();
  const passwordField = page.getByLabel(PASSWORD_FIELD_LABEL).first();
  const submitButton = page.getByRole("button", { name: SUBMIT_BUTTON_NAME }).first();

  if ((await emailField.count()) === 0 || (await passwordField.count()) === 0) {
    return null;
  }

  await emailField.fill(credentials.username);
  await passwordField.fill(credentials.password);
  await submitButton.click();
  await page.waitForLoadState("networkidle").catch(() => {});

  return {
    stepText: "tras iniciar sesión con las credenciales de test",
    url: page.url(),
    ariaSnapshot: await ariaSnapshotOf(page),
  };
}

async function exploreByHints(
  page: Page,
  input: ExplorationInput,
  onStep: ExplorationStepCallback,
  triedRoutes: string[]
): Promise<ExplorationResult | null> {
  const hints = input.matchedPattern?.navigationHints;
  if (!hints) return null;

  for (const candidate of hints.routeCandidates) {
    const url = new URL(candidate, input.baseUrl).toString();
    triedRoutes.push(url);
    onStep(`Probando ruta ${candidate}...`);

    const response = await page.goto(url).catch(() => null);
    if (!response || response.status() >= 400) {
      onStep(`Ruta ${candidate} no disponible (${response ? response.status() : "sin respuesta"}).`);
      continue;
    }
    if (!(await looksLikeUsablePage(page))) {
      onStep(`Ruta ${candidate} cargó pero no parece tener contenido interactivo.`);
      continue;
    }

    onStep(`Ruta ${candidate} encontrada.`);
    const screens: ScreenEvidence[] = [
      { stepText: `pantalla en ${candidate}`, url: page.url(), ariaSnapshot: await ariaSnapshotOf(page) },
    ];

    if (hints.requiresLogin) {
      if (!input.credentials) {
        return {
          ok: false,
          error:
            "Este escenario necesita iniciar sesión pero no hay AGENTE_QA_TEST_USERNAME/AGENTE_QA_TEST_PASSWORD configurados en .agente-qa/.env.",
        };
      }
      const postLogin = await performRealLogin(page, input.credentials);
      if (!postLogin) {
        onStep(`No se encontraron campos de login en ${candidate} para iniciar sesión de verdad.`);
        continue;
      }
      screens.push(postLogin);
    }

    return { ok: true, screens };
  }

  return null;
}

async function exploreAgentically(
  page: Page,
  llm: LLMProvider,
  input: ExplorationInput,
  onStep: ExplorationStepCallback
): Promise<ExplorationResult> {
  if (page.url() === "about:blank") {
    await page.goto(input.baseUrl).catch(() => {});
  }

  for (let step = 0; step < MAX_AGENTIC_STEPS; step++) {
    const snapshot = await ariaSnapshotOf(page);
    const promptUrl = redactCredentialsFromUrl(page.url(), input.credentials);
    const promptSnapshot = redactLiteralCredentials(snapshot, input.credentials);
    const prompt = explorerActionPrompt(input.featureText, promptUrl, promptSnapshot, Boolean(input.credentials));
    const raw = await llm.generate([
      { role: "system", content: "Eres un explorador de interfaces web que decide una acción a la vez." },
      { role: "user", content: prompt },
    ]);
    const action = parseJsonResponse(ExplorerActionSchema, raw);
    onStep(`Acción ${step + 1}: ${action.action}`);

    if (action.action === "done") {
      return {
        ok: true,
        screens: [{ stepText: "estado final del escenario", url: page.url(), ariaSnapshot: snapshot }],
      };
    }
    if (action.action === "fail") {
      return { ok: false, error: action.reason };
    }
    if (action.action === "goto") {
      const url = new URL(action.target, input.baseUrl).toString();
      if (!isSameOrigin(url, input.baseUrl)) {
        onStep(`Navegación a otro origen bloqueada por seguridad: ${url}`);
      } else {
        await page.goto(url).catch(() => {});
      }
    } else if (action.action === "click") {
      const target = page.getByRole(action.role, { name: action.name }).first();
      if ((await target.count()) > 0) {
        await target.click({ timeout: AGENTIC_ACTION_TIMEOUT_MS }).catch(() => {});
      } else {
        onStep(`No se encontró ningún "${action.role}" con nombre "${action.name}".`);
      }
    } else if (action.action === "fill_credential") {
      if (!input.credentials) {
        return {
          ok: false,
          error:
            "El modelo pidió rellenar credenciales de test, pero no hay AGENTE_QA_TEST_USERNAME/AGENTE_QA_TEST_PASSWORD configurados en .agente-qa/.env.",
        };
      }
      if (!isSameOrigin(page.url(), input.baseUrl)) {
        onStep("Relleno de credenciales bloqueado: la pantalla actual no pertenece al origen configurado en AGENTE_QA_APP_URL.");
        continue;
      }
      const value = action.field === "username" ? input.credentials.username : input.credentials.password;
      const target = page.getByLabel(action.labelText, { exact: false }).first();
      if ((await target.count()) > 0) {
        await target.fill(value, { timeout: AGENTIC_ACTION_TIMEOUT_MS }).catch(() => {});
      } else {
        onStep(`No se encontró ningún campo con etiqueta "${action.labelText}".`);
      }
    }
  }

  return { ok: false, error: `No se pudo completar el escenario tras ${MAX_AGENTIC_STEPS} acciones.` };
}

export function createRealSiteExplorer(llm: LLMProvider, options?: { executablePath?: string }): SiteExplorer {
  return {
    async explore(input: ExplorationInput, onStep: ExplorationStepCallback = () => {}): Promise<ExplorationResult> {
      const browser = await launchBrowser(input.headed, options?.executablePath);
      try {
        const page = await browser.newPage();
        const triedRoutes: string[] = [];

        const hintsResult = await exploreByHints(page, input, onStep, triedRoutes);
        if (hintsResult) return hintsResult;

        onStep(
          triedRoutes.length > 0
            ? `Ninguna ruta conocida sirvió (${triedRoutes.join(", ")}); explorando con ayuda del modelo...`
            : "No hay patrón conocido; explorando con ayuda del modelo..."
        );

        const agenticResult = await exploreAgentically(page, llm, input, onStep);
        if (!agenticResult.ok && triedRoutes.length > 0) {
          return { ok: false, error: `${agenticResult.error} (rutas ya descartadas: ${triedRoutes.join(", ")})` };
        }
        return agenticResult;
      } finally {
        await browser.close();
      }
    },
  };
}
