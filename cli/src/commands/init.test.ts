import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectConfig, projectEnvPath, projectGitignorePath } from "@agente-qa/core";
import { runInit } from "./init.js";
import type { InitPrompts } from "../prompts/types.js";

function prompts(overrides: Partial<InitPrompts> = {}): InitPrompts {
  return {
    inputTestsDir: async () => "tests",
    confirmHeadedMode: async () => false,
    inputAppUrl: async () => "https://example.com",
    selectAppLanguage: async () => "es",
    inputRoute: async (label) => (label.includes("home") ? "/" : ""),
    promptAdditionalRoutes: async () => ({}),
    inputMaxViewDepth: async () => 4,
    selectGitignoreEntries: async (candidates) => candidates,
    ...overrides,
  };
}

describe("runInit", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-init-project-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  const defaultCrawl = {
    maxScreens: 500,
    maxDepth: 25,
    maxDurationMinutes: 60,
    loopSuspicionThreshold: 3,
    excludeRoutes: [] as string[],
    maxViewDepth: 4,
  };

  it("saves the project config from the prompt answers", async () => {
    await runInit(prompts(), tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: false,
      appUrl: "https://example.com",
      appLanguage: "es",
      routes: { home: "/" },
      crawl: defaultCrawl,
    });
  });

  it("saves headedMode: true when the user confirms it", async () => {
    await runInit(prompts({ confirmHeadedMode: async () => true }), tmpProject);

    expect(await loadProjectConfig(tmpProject)).toEqual({
      testsDir: "tests",
      headedMode: true,
      appUrl: "https://example.com",
      appLanguage: "es",
      routes: { home: "/" },
      crawl: defaultCrawl,
    });
  });

  it("saves appLanguage: \"en\" when the user picks English", async () => {
    await runInit(prompts({ selectAppLanguage: async () => "en" }), tmpProject);

    expect((await loadProjectConfig(tmpProject))?.appLanguage).toBe("en");
  });

  it("asks for the home and login routes, and only saves login when it's non-empty", async () => {
    await runInit(
      prompts({
        inputRoute: async (label) => (label.includes("login") ? "/login" : "/"),
      }),
      tmpProject
    );

    expect((await loadProjectConfig(tmpProject))?.routes).toEqual({ home: "/", login: "/login" });
  });

  it("omits the login route when the user leaves it blank", async () => {
    await runInit(
      prompts({
        inputRoute: async (label) => (label.includes("login") ? "" : "/"),
      }),
      tmpProject
    );

    expect((await loadProjectConfig(tmpProject))?.routes).toEqual({ home: "/" });
  });

  it("merges extra routes from promptAdditionalRoutes into the saved config", async () => {
    await runInit(
      prompts({
        promptAdditionalRoutes: async () => ({ checkout: "/carrito", signup: "/registro" }),
      }),
      tmpProject
    );

    expect((await loadProjectConfig(tmpProject))?.routes).toEqual({
      home: "/",
      checkout: "/carrito",
      signup: "/registro",
    });
  });

  it("saves the answered maxViewDepth into crawl config", async () => {
    await runInit(prompts({ inputMaxViewDepth: async () => 2 }), tmpProject);
    const config = await loadProjectConfig(tmpProject);
    expect(config!.crawl.maxViewDepth).toBe(2);
  });

  it("creates the .env template when it doesn't exist yet, and reports it as created", async () => {
    const result = await runInit(prompts(), tmpProject);

    expect(result.envCreated).toBe(true);
    expect(result.envPath).toBe(projectEnvPath(tmpProject));
    const exists = await fs.stat(projectEnvPath(tmpProject)).then(() => true, () => false);
    expect(exists).toBe(true);
  });

  it("does not overwrite an existing .env, and reports it as not created", async () => {
    await runInit(prompts(), tmpProject);
    await fs.writeFile(projectEnvPath(tmpProject), "AGENTE_QA_APP_URL=https://mi-app.com\n", "utf-8");

    const result = await runInit(prompts(), tmpProject);

    expect(result.envCreated).toBe(false);
    expect(await fs.readFile(projectEnvPath(tmpProject), "utf-8")).toBe(
      "AGENTE_QA_APP_URL=https://mi-app.com\n"
    );
  });

  it("asks about .gitignore entries and writes what the user chose when the project has no .gitignore yet", async () => {
    const result = await runInit(prompts(), tmpProject);

    expect(result.gitignoreEntriesAdded).toEqual(["node_modules", "tests/results", "tests/test-results"]);
    expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe(
      "node_modules\ntests/results\ntests/test-results\n"
    );
  });

  it("only asks about entries that are missing, leaving already-present ones untouched", async () => {
    await fs.writeFile(projectGitignorePath(tmpProject), "node_modules\n", "utf-8");
    let askedWith: string[] = [];

    const result = await runInit(
      prompts({
        selectGitignoreEntries: async (candidates) => {
          askedWith = candidates;
          return candidates;
        },
      }),
      tmpProject
    );

    expect(askedWith).toEqual(["tests/results", "tests/test-results"]);
    expect(result.gitignoreEntriesAdded).toEqual(["tests/results", "tests/test-results"]);
    expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe(
      "node_modules\ntests/results\ntests/test-results\n"
    );
  });

  it("never calls selectGitignoreEntries when every candidate is already present", async () => {
    await fs.writeFile(
      projectGitignorePath(tmpProject),
      "node_modules\ntests/results\ntests/test-results\n",
      "utf-8"
    );
    let called = false;

    const result = await runInit(
      prompts({
        selectGitignoreEntries: async (candidates) => {
          called = true;
          return candidates;
        },
      }),
      tmpProject
    );

    expect(called).toBe(false);
    expect(result.gitignoreEntriesAdded).toEqual([]);
  });

  it("respects a partial selection from selectGitignoreEntries (user unchecked some candidates)", async () => {
    const result = await runInit(prompts({ selectGitignoreEntries: async () => ["node_modules"] }), tmpProject);

    expect(result.gitignoreEntriesAdded).toEqual(["node_modules"]);
    expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe("node_modules\n");
  });

  it("recognizes /node_modules (leading slash) as already covering node_modules and doesn't ask about it again", async () => {
    await fs.writeFile(projectGitignorePath(tmpProject), "/node_modules\n", "utf-8");
    let askedWith: string[] = [];

    const result = await runInit(
      prompts({
        selectGitignoreEntries: async (candidates) => {
          askedWith = candidates;
          return candidates;
        },
      }),
      tmpProject
    );

    expect(askedWith).not.toContain("node_modules");
    expect(askedWith).toEqual(["tests/results", "tests/test-results"]);
    expect(result.gitignoreEntriesAdded).not.toContain("node_modules");
  });

  it("normalizes a trailing slash on testsDir so candidates don't get a double slash", async () => {
    const result = await runInit(prompts({ inputTestsDir: async () => "tests/" }), tmpProject);

    expect(result.gitignoreEntriesAdded).toEqual(["node_modules", "tests/results", "tests/test-results"]);
    expect(await fs.readFile(projectGitignorePath(tmpProject), "utf-8")).toBe(
      "node_modules\ntests/results\ntests/test-results\n"
    );
  });
});
