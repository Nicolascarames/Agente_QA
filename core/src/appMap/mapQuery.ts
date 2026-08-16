import type { AppMap, LocatorEntry, Screen } from "./schema.js";

export function findScreen(map: AppMap, screenId: string): Screen | null {
  return map.screens.find((screen) => screen.id === screenId) ?? null;
}

/**
 * Every text a scenario on this screen may legitimately quote: what the screen
 * shows on arrival PLUS what any of its states adds. An error message exists
 * only after a bad submit, and a reset panel only after a click — both are
 * still literals of this screen, and a test is entitled to assert them.
 */
export function screenLiterals(map: AppMap, screenId: string): string[] {
  const screen = findScreen(map, screenId);
  if (!screen) return [];
  const fromStates = screen.states.flatMap((state) => state.addsTexts);
  return Array.from(new Set([...screen.texts, ...fromStates]));
}

/** The texts that appear as a direct result of clicking one locator. */
export function textsAfterClick(map: AppMap, screenId: string, locatorName: string): string[] {
  const screen = findScreen(map, screenId);
  if (!screen) return [];
  return screen.states
    .filter((state) => state.reachedBy.locator === locatorName && state.reachedBy.action === "click")
    .flatMap((state) => state.addsTexts);
}

export function findLocator(map: AppMap, screenId: string, locatorName: string): LocatorEntry | null {
  return findScreen(map, screenId)?.locators.find((l) => l.name === locatorName) ?? null;
}
