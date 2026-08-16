import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");

/**
 * Test-only. Serving the fixture from disk keeps crawler tests independent of
 * any external site: a public app can change any day and break the suite for
 * reasons that have nothing to do with this project.
 */
export async function startFixtureSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const requested = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = requested === "/" ? "index.html" : requested.replace(/^\//, "");
    // /item/1 and /item/2 are route templates, not files: they share one page.
    const file = relative.startsWith("item/") ? "item.html" : relative;
    try {
      const body = await fs.readFile(path.join(SITE_DIR, file), "utf-8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("El servidor de fixtures no obtuvo un puerto.");

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
