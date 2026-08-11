import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAvailableTags } from "./listAvailableTags.js";

describe("listAvailableTags", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agente-qa-listtags-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  async function writeFeature(fileName: string, content: string): Promise<void> {
    const dir = path.join(tmpProject, "tests", "features");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), content, "utf-8");
  }

  it("returns an empty array when there are no feature files", async () => {
    expect(await listAvailableTags(tmpProject, "tests")).toEqual([]);
  });

  it("returns an empty array when no feature has any tag", async () => {
    await writeFeature("login.feature", "Feature: Login\n  Scenario: x\n    Given a\n");
    expect(await listAvailableTags(tmpProject, "tests")).toEqual([]);
  });

  it("extracts a tag on the Feature line", async () => {
    await writeFeature("login.feature", "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n");
    expect(await listAvailableTags(tmpProject, "tests")).toEqual(["@smoke"]);
  });

  it("extracts multiple tags on an individual Scenario line", async () => {
    await writeFeature(
      "login.feature",
      "Feature: Login\n  @smoke @regression\n  Scenario: x\n    Given a\n"
    );
    expect(await listAvailableTags(tmpProject, "tests")).toEqual(["@regression", "@smoke"]);
  });

  it("deduplicates tags across multiple feature files, sorted alphabetically", async () => {
    await writeFeature("login.feature", "@smoke\nFeature: Login\n  Scenario: x\n    Given a\n");
    await writeFeature("checkout.feature", "@smoke\nFeature: Checkout\n  Scenario: y\n    Given b\n");
    expect(await listAvailableTags(tmpProject, "tests")).toEqual(["@smoke"]);
  });
});
