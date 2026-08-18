import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProjectConfig, loadProjectConfig, projectConfigPath, requireAppUrl, testEnvVars, ProjectConfigSchema } from "./projectConfig.js";

describe("projectConfig", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("returns null when no config file exists", async () => {
    expect(await loadProjectConfig(tmpProject)).toBeNull();
  });

  const defaultCrawl = {
    maxScreens: 500,
    maxDepth: 25,
    maxDurationMinutes: 60,
    loopSuspicionThreshold: 3,
    excludeRoutes: [] as string[],
    maxViewDepth: 4,
  };

  it("saves and loads project config round-trip, defaulting headedMode to false when omitted", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com" });
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      crawl: defaultCrawl,
    });
  });

  it("saves and loads headedMode: true when explicitly given", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "tests", headedMode: true, appUrl: "https://example.com" });
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: true,
      appUrl: "https://example.com",
      appLanguage: "es",
      routes: {},
      crawl: defaultCrawl,
    });
  });

  it("writes the file at <project>/.agente-qa/config.json", async () => {
    await saveProjectConfig(tmpProject, { testsDir: "qa-tests", appUrl: "https://example.com" });
    expect(projectConfigPath(tmpProject)).toBe(path.join(tmpProject, ".agente-qa", "config.json"));
  });

  it("rejects and does not write the file when testsDir is empty", async () => {
    await expect(saveProjectConfig(tmpProject, { testsDir: "", appUrl: "https://example.com" })).rejects.toThrow();
    const exists = await fs.stat(projectConfigPath(tmpProject)).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it("saves and loads an explicit appLanguage and routes", async () => {
    await saveProjectConfig(tmpProject, {
      testsDir: "tests",
      appUrl: "https://example.com",
      appLanguage: "en",
      routes: { home: "/", login: "/login" },
    });
    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appUrl: "https://example.com",
      appLanguage: "en",
      routes: { home: "/", login: "/login" },
      crawl: defaultCrawl,
    });
  });

  it("rejects an invalid appLanguage value", async () => {
    await expect(
      saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "https://example.com", appLanguage: "fr" as never })
    ).rejects.toThrow();
  });

  it("rejects a config with no appUrl", async () => {
    await expect(saveProjectConfig(tmpProject, { testsDir: "tests" } as never)).rejects.toThrow();
  });

  it("rejects an appUrl that isn't a valid URL", async () => {
    await expect(
      saveProjectConfig(tmpProject, { testsDir: "tests", appUrl: "not-a-url" })
    ).rejects.toThrow();
  });

  it("rejects an appUrl with embedded credentials", async () => {
    await expect(
      saveProjectConfig(tmpProject, {
        testsDir: "tests",
        appUrl: "https://qa-user:Sup3rSecreta@staging.mi-app.com",
      })
    ).rejects.toThrow();
  });

  it("throws a friendly castellano message when loading a pre-upgrade config.json with no appUrl", async () => {
    const filePath = projectConfigPath(tmpProject);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ testsDir: "tests", headedMode: false }), "utf-8");

    await expect(loadProjectConfig(tmpProject)).rejects.toThrow(/appUrl/);
    await expect(loadProjectConfig(tmpProject)).rejects.toThrow(/agente-qa init|Configuración/);
    await expect(loadProjectConfig(tmpProject)).rejects.toThrow(/ejecuta/i);
  });

  it("defaults the crawl block when the config has none", () => {
    const parsed = ProjectConfigSchema.parse({ testsDir: "tests", appUrl: "https://example.test/" });
    expect(parsed.crawl).toEqual({
      maxScreens: 500, maxDepth: 25, maxDurationMinutes: 60,
      loopSuspicionThreshold: 3, excludeRoutes: [], maxViewDepth: 4,
    });
  });

  it("keeps user-supplied crawl limits", () => {
    const parsed = ProjectConfigSchema.parse({
      testsDir: "tests", appUrl: "https://example.test/",
      crawl: { maxScreens: 20, maxDepth: 3, maxDurationMinutes: 5, loopSuspicionThreshold: 2, excludeRoutes: ["/admin/*"], maxViewDepth: 4 },
    });
    expect(parsed.crawl.excludeRoutes).toEqual(["/admin/*"]);
  });

  describe("requireAppUrl", () => {
    it("returns the configured appUrl", () => {
      expect(
        requireAppUrl({
          testsDir: "tests",
          headedMode: false,
          appUrl: "https://mi-app.com",
          appLanguage: "es",
          routes: {},
          crawl: defaultCrawl,
        })
      ).toBe("https://mi-app.com");
    });
  });

  describe("testEnvVars", () => {
    const config = {
      testsDir: "tests",
      headedMode: false,
      appUrl: "https://mi-app.com",
      appLanguage: "es" as const,
      routes: {},
      crawl: defaultCrawl,
    };

    it("maps appUrl and present test credentials to their AGENTE_QA_* names", () => {
      expect(testEnvVars(config, { testUsername: "qa", testPassword: "pwd", llmProvider: undefined, llmApiKey: undefined, llmBaseURL: undefined, llmModel: undefined })).toEqual({
        AGENTE_QA_APP_URL: "https://mi-app.com",
        AGENTE_QA_TEST_USERNAME: "qa",
        AGENTE_QA_TEST_PASSWORD: "pwd",
      });
    });

    it("omits absent test credentials entirely rather than including them as empty strings", () => {
      expect(testEnvVars(config, { testUsername: undefined, testPassword: undefined, llmProvider: undefined, llmApiKey: undefined, llmBaseURL: undefined, llmModel: undefined })).toEqual({
        AGENTE_QA_APP_URL: "https://mi-app.com",
      });
    });
  });
});
