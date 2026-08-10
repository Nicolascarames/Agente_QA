import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials, loadCredentials, credentialsPath } from "./credentials.js";

describe("credentials", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("returns null when no credentials file exists", async () => {
    expect(await loadCredentials(tmpHome)).toBeNull();
  });

  it("saves and loads credentials round-trip", async () => {
    await saveCredentials({ provider: "anthropic", apiKey: "sk-test-123" }, tmpHome);
    expect(await loadCredentials(tmpHome)).toEqual({ provider: "anthropic", apiKey: "sk-test-123" });
  });

  it("writes the file at <home>/.agente-qa/credentials.json", async () => {
    await saveCredentials({ provider: "openai", apiKey: "sk-test-456" }, tmpHome);
    const exists = await fs.stat(credentialsPath(tmpHome)).then(() => true, () => false);
    expect(exists).toBe(true);
    expect(credentialsPath(tmpHome)).toBe(path.join(tmpHome, ".agente-qa", "credentials.json"));
  });
});
