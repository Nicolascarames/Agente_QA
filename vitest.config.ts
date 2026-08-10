import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["core/src/**/*.test.ts", "cli/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@agente-qa/core": path.resolve(__dirname, "core/src/index.ts"),
    },
  },
});
