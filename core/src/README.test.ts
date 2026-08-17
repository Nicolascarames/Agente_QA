import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

describe("README", () => {
  it("documents the five agents in order", async () => {
    const readme = await fs.readFile(path.join(process.cwd(), "README.md"), "utf-8");
    const order = ["Agente 1", "Agente 2", "Agente 3", "Agente 4", "Agente 5"];
    let cursor = -1;
    for (const label of order) {
      const next = readme.indexOf(label);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it("mentions 'agente-qa map' before 'agente-qa chat'", async () => {
    const readme = await fs.readFile(path.join(process.cwd(), "README.md"), "utf-8");
    const mapIndex = readme.indexOf("agente-qa map");
    const chatIndex = readme.indexOf("agente-qa chat");
    expect(mapIndex).toBeGreaterThan(-1);
    expect(chatIndex).toBeGreaterThan(-1);
    expect(mapIndex).toBeLessThan(chatIndex);
  });
});
