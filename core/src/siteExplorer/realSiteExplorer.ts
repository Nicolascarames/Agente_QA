import { chromium, type Browser, type Page } from "playwright";
import type { LLMProvider } from "../llm/provider.js";
import { parseJsonResponse } from "../llm/parseJson.js";
import { ExplorerActionSchema, type ExplorerAction } from "./explorerAction.js";
import { explorerActionPrompt } from "../prompts/explorer.js";
import type {
  SiteExplorer,
  ExplorationInput,
  ExplorationResult,
  ExplorationStepCallback,
  ExplorationCredentials,
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

/**
 * Every place that builds ScreenEvidence to hand back to the caller MUST go
 * through this helper. Evidence returned from explore() flows straight into
 * the code-generation LLM prompt (runGenerador -> generateCode) — a second
 * model that has no involvement in exploration and must never see a real
 * credential value either. Redacting only the explorer's OWN prompt
 * (promptUrl/promptSnapshot below) is not enough.
 */
async function captureEvidence(
  page: Page,
  stepText: string,
  credentials: ExplorationCredentials | undefined
): Promise<ScreenEvidence> {
  const snapshot = await ariaSnapshotOf(page);
  return {
    stepText,
    url: redactCredentialsFromUrl(page.url(), credentials),
    ariaSnapshot: redactLiteralCredentials(snapshot, credentials),
  };
}

async function looksLikeUsablePage(page: Page): Promise<boolean> {
  const count = await page.getByRole("textbox").or(page.getByRole("button")).count();
  return count > 0;
}

const LOGIN_FIELD_LABEL = /correo|usuario|email|user/i;
const PASSWORD_FIELD_LABEL = /contraseña|password/i;
const SUBMIT_BUTTON_NAME = /iniciar sesión|ingresar|log ?in/i;

// A deliberately wrong password, fixed and never derived from the real one, so
// the probe can never accidentally submit a valid credential. Only ever used
// once per exploration: some apps lock accounts after N failed attempts, which
// is why the probe is opt-in per pattern instead of global.
const INVALID_PROBE_PASSWORD = "agente-qa-invalid-password";

/**
 * Shared by performRealLogin and performNegativeLoginProbe: both need the
 * exact same field-locator heuristic (LOGIN_FIELD_LABEL/PASSWORD_FIELD_LABEL/
 * SUBMIT_BUTTON_NAME), which gets tuned as new apps are tested. Keeping one
 * implementation means a future tuning of that heuristic can't silently apply
 * to only one of the two paths — e.g. the probe going on "succeeding" (still
 * returning a screen) while no longer actually submitting the form, quietly
 * degrading its captured evidence back into the untouched login page. `email`/
 * `password` are what actually gets typed into the form; `credentials` is only
 * used for captureEvidence's redaction, so the probe's real password stays
 * redacted from evidence even though it's never the one typed in.
 */
async function submitLoginForm(
  page: Page,
  email: string,
  password: string,
  stepText: string,
  credentials: ExplorationCredentials
): Promise<ScreenEvidence | null> {
  const emailField = page.getByLabel(LOGIN_FIELD_LABEL).first();
  const passwordField = page.getByLabel(PASSWORD_FIELD_LABEL).first();
  const submitButton = page.getByRole("button", { name: SUBMIT_BUTTON_NAME }).first();

  if ((await emailField.count()) === 0 || (await passwordField.count()) === 0) {
    return null;
  }

  await emailField.fill(email);
  await passwordField.fill(password);
  await submitButton.click();
  await page.waitForLoadState("networkidle").catch(() => {});

  return captureEvidence(page, stepText, credentials);
}

async function performRealLogin(
  page: Page,
  credentials: ExplorationCredentials
): Promise<ScreenEvidence | null> {
  return submitLoginForm(
    page,
    credentials.username,
    credentials.password,
    "tras iniciar sesión con las credenciales de test",
    credentials
  );
}

async function performNegativeLoginProbe(
  page: Page,
  credentials: ExplorationCredentials
): Promise<ScreenEvidence | null> {
  return submitLoginForm(
    page,
    credentials.username,
    INVALID_PROBE_PASSWORD,
    "tras un intento de inicio de sesión con credenciales incorrectas",
    credentials
  );
}

async function exploreByHints(
  page: Page,
  input: ExplorationInput,
  onStep: ExplorationStepCallback,
  triedRoutes: string[]
): Promise<ExplorationResult | null> {
  const hints = input.matchedPattern?.navigationHints;
  if (!hints) return null;

  // Guards performNegativeLoginProbe to at most one ACTUAL submission per
  // explore() call, no matter how many route candidates the loop below walks.
  // Set only when the probe genuinely fills+clicks (i.e. performNegativeLoginProbe
  // returns non-null) — never for a no-op call that bailed out because a
  // candidate had no login fields, since that submits nothing and carries none
  // of the lockout risk this guard exists for. Declared outside the loop so it
  // survives across candidates instead of resetting per iteration.
  let negativeProbeFired = false;

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
    const screens: ScreenEvidence[] = [await captureEvidence(page, `pantalla en ${candidate}`, input.credentials)];

    if (hints.requiresLogin) {
      if (!input.credentials) {
        return {
          ok: false,
          error:
            "Este escenario necesita iniciar sesión pero no hay AGENTE_QA_TEST_USERNAME/AGENTE_QA_TEST_PASSWORD configurados en .agente-qa/.env.",
        };
      }
      if (!isSameOrigin(page.url(), input.baseUrl)) {
        return {
          ok: false,
          error: `La pantalla de login en ${candidate} no pertenece al origen configurado en AGENTE_QA_APP_URL (posible redirección a un proveedor externo de login); no se van a escribir credenciales de test fuera de ese origen.`,
        };
      }
      if (hints.negativeProbe && !negativeProbeFired) {
        onStep("Provocando un error de credenciales para capturar el mensaje real...");
        const probe = await performNegativeLoginProbe(page, input.credentials);
        if (probe) {
          screens.push(probe);
          negativeProbeFired = true;
        }
        // back to a clean login screen before the real attempt
        await page.goto(url).catch(() => {});
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

  // Short description of what happened when the LAST action didn't do what
  // was asked, so the next prompt doesn't look identical to the one that
  // already produced a failed/no-op action (see explorerActionPrompt). Reset
  // to undefined after any action that plausibly succeeded.
  let lastOutcome: string | undefined;

  for (let step = 0; step < MAX_AGENTIC_STEPS; step++) {
    const snapshot = await ariaSnapshotOf(page);
    const promptUrl = redactCredentialsFromUrl(page.url(), input.credentials);
    const promptSnapshot = redactLiteralCredentials(snapshot, input.credentials);
    const prompt = explorerActionPrompt(
      input.featureText,
      promptUrl,
      promptSnapshot,
      Boolean(input.credentials),
      lastOutcome
    );
    const raw = await llm.generate([
      { role: "system", content: "Eres un explorador de interfaces web que decide una acción a la vez." },
      { role: "user", content: prompt },
    ]);

    let action: ExplorerAction;
    try {
      action = parseJsonResponse(ExplorerActionSchema, raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
    onStep(`Acción ${step + 1}: ${action.action}`);

    if (action.action === "done") {
      return {
        ok: true,
        screens: [await captureEvidence(page, "estado final del escenario", input.credentials)],
      };
    }
    if (action.action === "fail") {
      return { ok: false, error: action.reason };
    }

    let outcome: string | undefined;

    if (action.action === "goto") {
      const url = new URL(action.target, input.baseUrl).toString();
      if (!isSameOrigin(url, input.baseUrl)) {
        onStep(`Navegación a otro origen bloqueada por seguridad: ${url}`);
        outcome = `se bloqueó la navegación a "${action.target}" por ser de otro origen`;
      } else {
        // page.goto() legitimately resolves null for a same-document navigation
        // (e.g. a hash-only change on a hash-router SPA) — that's success, not a
        // failure, so only a thrown error or a 4xx/5xx response counts as one.
        let response: Awaited<ReturnType<Page["goto"]>> | null = null;
        let threw = false;
        try {
          response = await page.goto(url);
        } catch {
          threw = true;
        }
        if (threw) {
          outcome = `no se pudo navegar a "${action.target}"`;
        } else if (response && response.status() >= 400) {
          outcome = `la navegación a "${action.target}" devolvió un error (${response.status()})`;
        }
      }
    } else if (action.action === "click") {
      const target = page.getByRole(action.role, { name: action.name }).first();
      if ((await target.count()) > 0) {
        const clicked = await target
          .click({ timeout: AGENTIC_ACTION_TIMEOUT_MS })
          .then(() => true)
          .catch(() => false);
        if (!clicked) {
          outcome = `no se pudo hacer click en "${action.role}" con nombre "${action.name}"`;
        }
      } else {
        onStep(`No se encontró ningún "${action.role}" con nombre "${action.name}".`);
        outcome = `no se encontró ningún "${action.role}" con nombre "${action.name}"`;
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
        lastOutcome = "se bloqueó el relleno de credenciales: la pantalla actual no pertenece al origen configurado";
        continue;
      }
      const value = action.field === "username" ? input.credentials.username : input.credentials.password;
      const target = page.getByLabel(action.labelText, { exact: false }).first();
      if ((await target.count()) > 0) {
        const filled = await target
          .fill(value, { timeout: AGENTIC_ACTION_TIMEOUT_MS })
          .then(() => true)
          .catch(() => false);
        if (!filled) {
          outcome = `no se pudo rellenar el campo "${action.labelText}"`;
        }
      } else {
        onStep(`No se encontró ningún campo con etiqueta "${action.labelText}".`);
        outcome = `no se encontró ningún campo con etiqueta "${action.labelText}"`;
      }
    }

    lastOutcome = outcome;
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

        if (triedRoutes.length > 0) {
          // Escalating from a failed fast path: the page is sitting on the
          // LAST tried candidate (often a 404), not a fresh view of the app.
          // Give the model a real starting point instead of a dead end.
          await page.goto(input.baseUrl).catch(() => {});
        }

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
