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

  it("rejects and does not write the file when apiKey is empty", async () => {
    await expect(saveCredentials({ provider: "anthropic", apiKey: "" }, tmpHome)).rejects.toThrow();
    const exists = await fs.stat(credentialsPath(tmpHome)).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  describe.skipIf(process.platform === "win32")("file permissions (POSIX only)", () => {
    it("writes credentials.json with mode 0600 (owner read/write only)", async () => {
      await saveCredentials({ provider: "anthropic", apiKey: "sk-test-789" }, tmpHome);
      const stats = await fs.stat(credentialsPath(tmpHome));
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("creates the .agente-qa directory with mode 0700 (owner only)", async () => {
      await saveCredentials({ provider: "anthropic", apiKey: "sk-test-789" }, tmpHome);
      const dirStats = await fs.stat(path.join(tmpHome, ".agente-qa"));
      expect(dirStats.mode & 0o777).toBe(0o700);
    });

    it("tightens permissions on a pre-existing file/dir from before this change, not just on first creation", async () => {
      const dirPath = path.join(tmpHome, ".agente-qa");
      const filePath = credentialsPath(tmpHome);
      await fs.mkdir(dirPath, { recursive: true, mode: 0o755 });
      await fs.writeFile(filePath, JSON.stringify({ provider: "anthropic", apiKey: "old-key" }), {
        mode: 0o644,
      });

      // Guard against an unusually strict umask (e.g. 077) masking the seeded mode down
      // to the target already, which would let this test pass without exercising the
      // tightening behavior it claims to prove.
      expect((await fs.stat(dirPath)).mode & 0o777).not.toBe(0o700);
      expect((await fs.stat(filePath)).mode & 0o777).not.toBe(0o600);

      await saveCredentials({ provider: "anthropic", apiKey: "new-key" }, tmpHome);

      const dirStats = await fs.stat(dirPath);
      const fileStats = await fs.stat(filePath);
      expect(dirStats.mode & 0o777).toBe(0o700);
      expect(fileStats.mode & 0o777).toBe(0o600);
    });
  });
});
