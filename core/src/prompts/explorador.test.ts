import { describe, it, expect } from "vitest";
import { scenarioCandidatesPrompt } from "./explorador.js";
import type { AppMap } from "../appMap/schema.js";

const map: AppMap = {
  schemaVersion: 1, appUrl: "https://example.test/", createdAt: "t",
  complete: true, authenticated: true, scenarios: [],
  stats: { screens: 1, locators: 1, ambiguous: 0, durationMs: 0 },
  screens: [{
    id: "login", name: "Log in", className: "LoginPage", urlTemplate: "/",
    signature: "sha256:a", requiresAuth: false,
    texts: ["Welcome back", "Authentication failed. Please try again."],
    probeValues: ["agente-qa-probe@example.invalid"],
    states: [], ambiguous: [], transitions: [], writeActions: [],
    locators: [{ name: "log_in_button", kind: "button", accessibleName: "Log in", python: "x", count: 1, verifiedAt: "t" }],
  }],
};

describe("scenarioCandidatesPrompt", () => {
  it("includes each screen id and its texts", () => {
    const prompt = scenarioCandidatesPrompt(map);
    expect(prompt).toContain("login");
    expect(prompt).toContain("Authentication failed. Please try again.");
  });

  it("never includes the crawler's own probe values", () => {
    expect(scenarioCandidatesPrompt(map)).not.toContain("agente-qa-probe@example.invalid");
  });

  it("asks for JSON only", () => {
    expect(scenarioCandidatesPrompt(map)).toMatch(/JSON/);
  });

  it("strips a text that exactly equals a probe value", () => {
    const withMap: AppMap = {
      ...map,
      screens: [{
        ...map.screens[0],
        probeValues: ["usuario@empresa.com"],
        texts: [...map.screens[0].texts, "usuario@empresa.com"],
      }],
    };
    expect(scenarioCandidatesPrompt(withMap)).not.toContain("usuario@empresa.com");
  });

  it("strips a text that embeds a probe value inside a longer message", () => {
    const withMap: AppMap = {
      ...map,
      screens: [{
        ...map.screens[0],
        probeValues: ["usuario@empresa.com"],
        texts: [...map.screens[0].texts, "Cerrar sesión (usuario@empresa.com)"],
      }],
    };
    expect(scenarioCandidatesPrompt(withMap)).not.toContain("usuario@empresa.com");
  });

  it("strips a probe value reaching the prompt through acciones, not texts", () => {
    const withMap: AppMap = {
      ...map,
      screens: [{
        ...map.screens[0],
        probeValues: ["usuario@empresa.com"],
        locators: [
          ...map.screens[0].locators,
          {
            name: "cerrar_sesion_button", kind: "button",
            accessibleName: "Cerrar sesión (usuario@empresa.com)",
            python: 'page.get_by_role("button", name="Cerrar sesión (usuario@empresa.com)")',
            count: 1, verifiedAt: "t",
          },
        ],
      }],
    };
    expect(scenarioCandidatesPrompt(withMap)).not.toContain("usuario@empresa.com");
  });

  it("resolves a transition's toScreenId (a route template) to the destination screen's real id", () => {
    const withMap: AppMap = {
      ...map,
      screens: [
        { ...map.screens[0], transitions: [{ locator: "dashboard_link", action: "click", toScreenId: "/user/:id", urlChanged: true }] },
        { ...map.screens[0], id: "user_id", name: "User", urlTemplate: "/user/:id" },
      ],
    };
    const prompt = scenarioCandidatesPrompt(withMap);
    expect(prompt).toContain("dashboard_link -> user_id");
    expect(prompt).not.toContain("dashboard_link -> /user/:id");
  });

  it("marks a transition target that resolves to no known screen instead of printing the raw route template", () => {
    const withMap: AppMap = {
      ...map,
      screens: [
        { ...map.screens[0], transitions: [{ locator: "ghost_link", action: "click", toScreenId: "/nowhere", urlChanged: true }] },
      ],
    };
    expect(scenarioCandidatesPrompt(withMap)).toContain("ghost_link -> (sin resolver: /nowhere)");
  });
});
