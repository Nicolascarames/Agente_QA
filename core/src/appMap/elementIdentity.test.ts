import { describe, it, expect } from "vitest";
import { elementKey, mergeScreenState } from "./elementIdentity.js";
import type { Screen } from "./schema.js";

const screen: Screen = {
  id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
  signature: "sha256:a", requiresAuth: false,
  texts: ["Email", "Password"], probeValues: [], locators: [], states: [],
  ambiguous: [], transitions: [], writeActions: [],
};

describe("elementKey", () => {
  it("distinguishes two same-named buttons at different positions", () => {
    const a = elementKey({ screenId: "orders", role: "button", accessibleName: "Edit", index: 0 });
    const b = elementKey({ screenId: "orders", role: "button", accessibleName: "Edit", index: 1 });
    expect(a).not.toBe(b);
  });

  it("is stable for the same element", () => {
    const input = { screenId: "login", role: "button", accessibleName: "Log in", index: 0 };
    expect(elementKey(input)).toBe(elementKey({ ...input }));
  });

  it("distinguishes the same element on different screens", () => {
    expect(elementKey({ screenId: "a", role: "button", accessibleName: "Save", index: 0 }))
      .not.toBe(elementKey({ screenId: "b", role: "button", accessibleName: "Save", index: 0 }));
  });
});

describe("mergeScreenState", () => {
  it("adds the new texts to the same screen instead of creating another one", () => {
    const merged = mergeScreenState(screen, {
      id: "invalid-credentials",
      reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
      texts: ["Authentication failed. Please try again."],
      locators: [],
    });
    expect(merged.texts).toContain("Authentication failed. Please try again.");
    expect(merged.states).toHaveLength(1);
    expect(merged.states[0].addsTexts).toEqual(["Authentication failed. Please try again."]);
  });

  it("does not duplicate texts the screen already had", () => {
    const merged = mergeScreenState(screen, {
      id: "invalid-credentials",
      reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
      texts: ["Email", "Required"],
      locators: [],
    });
    expect(merged.texts.filter((t) => t === "Email")).toHaveLength(1);
    expect(merged.states[0].addsTexts).toEqual(["Required"]);
  });

  it("tags locators that only exist in that state", () => {
    const merged = mergeScreenState(screen, {
      id: "invalid-credentials",
      reachedBy: { action: "submit", locator: "log_in_button", data: "invalid" },
      texts: [],
      locators: [{
        name: "text_auth_failed", kind: "text",
        python: 'page.get_by_text("Authentication failed. Please try again.")',
        count: 1, verifiedAt: "2026-08-16T10:00:00.000Z",
      }],
    });
    expect(merged.locators[0].stateId).toBe("invalid-credentials");
  });
});
