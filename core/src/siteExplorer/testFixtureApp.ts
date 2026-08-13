import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureApp {
  url: string;
  close(): Promise<void>;
}

const TEST_USERNAME = "qa-tester@example.com";
const TEST_PASSWORD = "hunter2-test-only";
export const FIXTURE_CREDENTIALS = { username: TEST_USERNAME, password: TEST_PASSWORD };

function loginPageHtml(): string {
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
      var email = document.getElementById("email").value;
      var password = document.getElementById("password").value;
      if (email === "${TEST_USERNAME}" && password === "${TEST_PASSWORD}") {
        window.location.href = "/dashboard";
      } else {
        var alertBox = document.createElement("div");
        alertBox.setAttribute("role", "alert");
        alertBox.textContent = "Credenciales inválidas";
        document.body.appendChild(alertBox);
      }
    });
  </script>
</body>
</html>`;
}

const DASHBOARD_PAGE = `<!doctype html>
<html>
<body>
  <nav>
    <span>Hola, tester</span>
    <button type="button">Menú de usuario</button>
    <a href="/login">Cerrar sesión</a>
  </nav>
  <main><h1>Panel</h1></main>
</body>
</html>`;

const NOT_FOUND_PAGE = `<!doctype html><html><body><h1>404</h1></body></html>`;
const EMPTY_HOME_PAGE = `<!doctype html><html><body><h1>Home</h1></body></html>`;

// Legacy-style native form (no JS, method="get"): submitting it puts field values
// straight into the resulting page's URL query string, e.g. "?password=...".
// Used to exercise the real "credential leaks into page.url()" vector.
const LEAKY_LOGIN_PAGE = `<!doctype html>
<html>
<body>
  <form method="get" action="/leaky-landing">
    <label for="email">Correo electrónico</label>
    <input id="email" name="email" type="text" />
    <label for="password">Contraseña</label>
    <input id="password" name="password" type="password" />
    <button type="submit">Iniciar sesión</button>
  </form>
</body>
</html>`;

const LEAKY_LANDING_PAGE = `<!doctype html><html><body><h1>Bienvenido</h1></body></html>`;

function portalPageHtml(crossOriginTarget: string): string {
  return `<!doctype html>
<html>
<body>
  <a href="${crossOriginTarget}">Portal externo</a>
</body>
</html>`;
}

export type FixtureMode = "conventional" | "spa" | "custom" | "leaky" | "portal";

export interface FixtureAppOptions {
  // Only used by mode "portal": the real cross-origin URL its "Portal externo"
  // link points to, so a test can drive an actual browser-native navigation
  // to a different origin (not one this app's own server controls).
  crossOriginTarget?: string;
}

export function startFixtureApp(mode: FixtureMode, options: FixtureAppOptions = {}): Promise<FixtureApp> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const send = (status: number, body: string): void => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    };

    if (url.startsWith("/dashboard")) return send(200, DASHBOARD_PAGE);
    if (mode === "conventional" && (url === "/login" || url === "/signin")) return send(200, loginPageHtml());
    if (mode === "conventional" && url === "/") return send(200, EMPTY_HOME_PAGE);
    if (mode === "spa" && url === "/") return send(200, loginPageHtml());
    if (mode === "custom" && url === "/access") return send(200, loginPageHtml());
    if (mode === "leaky" && url === "/leaky") return send(200, LEAKY_LOGIN_PAGE);
    if (mode === "leaky" && url === "/leaky-landing") return send(200, LEAKY_LANDING_PAGE);
    if (mode === "portal" && url === "/" && options.crossOriginTarget) {
      return send(200, portalPageHtml(options.crossOriginTarget));
    }

    send(404, NOT_FOUND_PAGE);
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
