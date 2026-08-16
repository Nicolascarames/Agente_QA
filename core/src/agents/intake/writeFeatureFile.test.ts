import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFeatureFile } from "./writeFeatureFile.js";

describe("writeFeatureFile", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-write-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("writes the feature file under <testsDir>/features/", async () => {
    const plan = { fileName: "login.feature", featureText: "Feature: Login\n" };
    const filePath = await writeFeatureFile(tmpProject, "tests", plan);

    expect(filePath).toBe(path.join(tmpProject, "tests", "features", "login.feature"));
    expect(await fs.readFile(filePath, "utf-8")).toBe("Feature: Login\n");
  });

  it("creates intermediate directories if they don't exist", async () => {
    const plan = { fileName: "signup.feature", featureText: "Feature: Signup\n" };
    await writeFeatureFile(tmpProject, "qa/tests", plan);
    const exists = await fs
      .stat(path.join(tmpProject, "qa", "tests", "features", "signup.feature"))
      .then(() => true, () => false);
    expect(exists).toBe(true);
  });

  it("writes the featureText verbatim, with no header prepended", async () => {
    const plan = { fileName: "checkout.feature", featureText: '@screen:checkout\nFeature: Checkout\n' };
    const filePath = await writeFeatureFile(tmpProject, "tests", plan);

    expect(await fs.readFile(filePath, "utf-8")).toBe("@screen:checkout\nFeature: Checkout\n");
  });
});
