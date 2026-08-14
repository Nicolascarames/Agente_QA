import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectEnvPath,
  ensureProjectEnvTemplate,
  loadProjectEnv,
  requireLlmConfig,
} from "./projectEnv.js";

describe("projectEnv", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-projectenv-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  describe("projectEnvPath", () => {
    it("points at <project>/.agente-qa/.env", () => {
      expect(projectEnvPath(tmpProject)).toBe(path.join(tmpProject, ".agente-qa", ".env"));
    });
  });

  describe("ensureProjectEnvTemplate", () => {
    it("creates the .env template and the .gitignore when neither exists", async () => {
      const result = await ensureProjectEnvTemplate(tmpProject);

      expect(result).toEqual({ created: true, path: projectEnvPath(tmpProject) });
      const envContent = await fs.readFile(projectEnvPath(tmpProject), "utf-8");
      expect(envContent).toContain("AGENTE_QA_LLM_API_KEY=");

      const gitignoreContent = await fs.readFile(
        path.join(tmpProject, ".agente-qa", ".gitignore"),
        "utf-8"
      );
      expect(gitignoreContent).toBe(".env\n");
    });

    it("does not overwrite an existing .env", async () => {
      await ensureProjectEnvTemplate(tmpProject);
      await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");

      const result = await ensureProjectEnvTemplate(tmpProject);

      expect(result).toEqual({ created: false, path: projectEnvPath(tmpProject) });
      const envContent = await fs.readFile(projectEnvPath(tmpProject), "utf-8");
      expect(envContent).toBe("AGENTE_QA_APP_URL=https://mi-app.com\n");
    });

    describe.skipIf(process.platform === "win32")("file permissions (POSIX only)", () => {
      it("writes .env with mode 0600 (owner read/write only)", async () => {
        await ensureProjectEnvTemplate(tmpProject);
        const stats = await fs.stat(projectEnvPath(tmpProject));
        expect(stats.mode & 0o777).toBe(0o600);
      });

      it("tightens the .agente-qa directory to mode 0700 even when it already existed with a looser mode (real init ordering: saveProjectConfig creates the dir first, with no mode)", async () => {
        const dirPath = path.join(tmpProject, ".agente-qa");
        // Reproduce what saveProjectConfig does: create the dir recursively with
        // no mode argument, before ensureProjectEnvTemplate ever runs.
        await fs.mkdir(dirPath, { recursive: true });

        // Guard against an unusually strict umask (e.g. 077) masking the seeded
        // mode down to the target already, which would let this test pass
        // without exercising the tightening behavior it claims to prove.
        expect((await fs.stat(dirPath)).mode & 0o777).not.toBe(0o700);

        await ensureProjectEnvTemplate(tmpProject);

        const dirStats = await fs.stat(dirPath);
        expect(dirStats.mode & 0o777).toBe(0o700);
      });

      it("tightens permissions on a pre-existing .env and writes the .gitignore, without touching its content", async () => {
        const dirPath = path.join(tmpProject, ".agente-qa");
        const filePath = projectEnvPath(tmpProject);
        await fs.mkdir(dirPath, { recursive: true });
        await fs.writeFile(filePath, "AGENTE_QA_APP_URL=https://mi-app.com\n", { mode: 0o644 });

        // Guard against an unusually strict umask masking the seeded mode down
        // to the target already, which would let this test pass without
        // exercising the tightening behavior it claims to prove.
        expect((await fs.stat(filePath)).mode & 0o777).not.toBe(0o600);

        const result = await ensureProjectEnvTemplate(tmpProject);

        expect(result).toEqual({ created: false, path: filePath });
        const envContent = await fs.readFile(filePath, "utf-8");
        expect(envContent).toBe("AGENTE_QA_APP_URL=https://mi-app.com\n");

        const gitignoreContent = await fs.readFile(path.join(dirPath, ".gitignore"), "utf-8");
        expect(gitignoreContent).toBe(".env\n");

        const fileStats = await fs.stat(filePath);
        expect(fileStats.mode & 0o777).toBe(0o600);
      });
    });

    it("writes the .gitignore even when .env already existed (cross-platform content check)", async () => {
      const dirPath = path.join(tmpProject, ".agente-qa");
      const filePath = projectEnvPath(tmpProject);
      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(filePath, "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");

      await ensureProjectEnvTemplate(tmpProject);

      const gitignoreContent = await fs.readFile(path.join(dirPath, ".gitignore"), "utf-8");
      expect(gitignoreContent).toBe(".env\n");
    });
  });

  describe("loadProjectEnv", () => {
    it("returns null when no .env file exists", async () => {
      expect(await loadProjectEnv(tmpProject)).toBeNull();
    });

    it("returns all-undefined fields when the file exists but is the blank template", async () => {
      await ensureProjectEnvTemplate(tmpProject);

      expect(await loadProjectEnv(tmpProject)).toEqual({
        testUsername: undefined,
        testPassword: undefined,
        llmProvider: undefined,
        llmApiKey: undefined,
        llmBaseURL: undefined,
        llmModel: undefined,
      });
    });

    async function writeEnv(values: Record<string, string>): Promise<void> {
      await fs.mkdir(path.join(tmpProject, ".agente-qa"), { recursive: true });
      const content = Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      await fs.writeFile(projectEnvPath(tmpProject), `${content}\n`, "utf-8");
    }

    it("parses filled-in values", async () => {
      await writeEnv({
        AGENTE_QA_TEST_USERNAME: "qa-tester@mi-app.com",
        AGENTE_QA_TEST_PASSWORD: "Sup3rSecreta!",
        AGENTE_QA_LLM_PROVIDER: "anthropic",
        AGENTE_QA_LLM_API_KEY: "sk-ant-test",
      });

      expect(await loadProjectEnv(tmpProject)).toEqual({
        testUsername: "qa-tester@mi-app.com",
        testPassword: "Sup3rSecreta!",
        llmProvider: "anthropic",
        llmApiKey: "sk-ant-test",
        llmBaseURL: undefined,
        llmModel: undefined,
      });
    });

    it("treats a whitespace-only value as absent", async () => {
      await writeEnv({ AGENTE_QA_TEST_USERNAME: "   " });

      expect((await loadProjectEnv(tmpProject))?.testUsername).toBeUndefined();
    });

    it("throws a clear error naming AGENTE_QA_LLM_PROVIDER when it has an invalid value", async () => {
      await writeEnv({ AGENTE_QA_LLM_PROVIDER: "not-a-real-provider" });

      await expect(loadProjectEnv(tmpProject)).rejects.toThrow(/AGENTE_QA_LLM_PROVIDER/);
    });
  });

  describe("requireLlmConfig", () => {
    const envPath = "/fake/.agente-qa/.env";
    const blank = {
      testUsername: undefined,
      testPassword: undefined,
      llmProvider: undefined,
      llmApiKey: undefined,
      llmBaseURL: undefined,
      llmModel: undefined,
    };

    it("returns provider/apiKey/baseURL/model when all needed fields are present", () => {
      const result = requireLlmConfig(
        {
          ...blank,
          llmProvider: "openai-compatible",
          llmApiKey: "k",
          llmBaseURL: "https://api.groq.com/openai/v1",
          llmModel: "llama-3.3-70b-versatile",
        },
        envPath
      );

      expect(result).toEqual({
        provider: "openai-compatible",
        apiKey: "k",
        baseURL: "https://api.groq.com/openai/v1",
        model: "llama-3.3-70b-versatile",
      });
    });

    it("throws naming AGENTE_QA_LLM_PROVIDER and AGENTE_QA_LLM_API_KEY when both are missing", () => {
      expect(() => requireLlmConfig(blank, envPath)).toThrow(
        /AGENTE_QA_LLM_PROVIDER.*AGENTE_QA_LLM_API_KEY/s
      );
    });

    it("throws naming AGENTE_QA_LLM_BASE_URL and AGENTE_QA_LLM_MODEL when provider is openai-compatible but they're missing", () => {
      expect(() =>
        requireLlmConfig({ ...blank, llmProvider: "openai-compatible", llmApiKey: "k" }, envPath)
      ).toThrow(/AGENTE_QA_LLM_BASE_URL.*AGENTE_QA_LLM_MODEL/s);
    });
  });
});
