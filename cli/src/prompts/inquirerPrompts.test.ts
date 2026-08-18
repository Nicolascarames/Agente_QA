import { describe, it, expect, vi, afterEach } from "vitest";
import type { LocatorEntry } from "@agente-qa/core";

// select()/input()/checkbox() are real interactive prompts — mocked so the
// dump can be exercised headlessly. select is scripted per-test below.
const selectMock = vi.fn();
vi.mock("@inquirer/prompts", () => ({
  select: (...args: unknown[]) => selectMock(...args),
  input: vi.fn(),
  checkbox: vi.fn(),
}));

import { buildRealGeneratorPrompts } from "./inquirerPrompts.js";

describe("buildRealGeneratorPrompts().onAmbiguousLocator", () => {
  afterEach(() => {
    selectMock.mockReset();
  });

  it("advertises each candidate only with the Page Object methods its kind actually gets", async () => {
    // A heading and an input sharing accessibleName "Log in" is exactly the
    // collision this prompt exists to resolve. Neither one's real Page
    // Object exposes click_<name> — only a button/link does (pageObjectEmitter's
    // CLICKABLE) — so the dump must not claim otherwise for either of them.
    const heading: LocatorEntry = {
      name: "log_in_heading", kind: "heading", python: "page.a", count: 1, verifiedAt: "t",
    };
    const emailInput: LocatorEntry = {
      name: "email_input", kind: "input", python: "page.b", count: 1, verifiedAt: "t",
    };
    selectMock.mockResolvedValue("log_in_heading");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let printed: string;
    try {
      await buildRealGeneratorPrompts().onAmbiguousLocator({
        screenId: "home",
        screenName: "home",
        quoted: "Log in",
        candidates: [heading, emailInput],
      });
    } finally {
      printed = logSpy.mock.calls.map((call) => call[0]).join("\n");
      logSpy.mockRestore();
    }

    // A heading only ever gets get_ — advertising click_ would send the user
    // to a method the emitted Page Object never defines.
    expect(printed).toContain("get_log_in_heading()");
    expect(printed).not.toContain("click_log_in_heading()");

    // An input's real method is fill_, not click_.
    expect(printed).toContain("fill_email_input()");
    expect(printed).not.toContain("click_email_input()");
  });
});
