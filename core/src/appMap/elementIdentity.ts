import type { LocatorEntry, Screen, ScreenState } from "./schema.js";

/**
 * The crawler never clicks the same element twice. Position is part of the
 * identity because two "Edit" buttons in different table rows are different
 * elements with the same accessible name.
 */
export function elementKey(input: {
  screenId: string;
  role: string;
  accessibleName: string;
  index: number;
}): string {
  return `${input.screenId}|${input.role}|${input.accessibleName}|${input.index}`;
}

/**
 * An error message under a form is not a new screen: it is a state of the same
 * one. Merging keeps "one Page Object per route" intact — without it the login
 * screen would get one map entry per possible combination of error messages,
 * and the loop detector would see new screens where there are only states.
 */
export function mergeScreenState(
  screen: Screen,
  state: { id: string; reachedBy: ScreenState["reachedBy"]; texts: string[]; locators: LocatorEntry[] }
): Screen {
  // Deduplicate incoming texts, then filter against screen's texts
  const uniqueIncomingTexts = Array.from(new Set(state.texts));
  const newTexts = uniqueIncomingTexts.filter((text) => !screen.texts.includes(text));

  // Tag locators with stateId, but skip if name already exists on screen
  const existingLocatorNames = new Set(screen.locators.map((l) => l.name));
  const taggedLocators: LocatorEntry[] = state.locators
    .filter((locator) => !existingLocatorNames.has(locator.name))
    .map((locator) => ({ ...locator, stateId: state.id }));

  return {
    ...screen,
    texts: [...screen.texts, ...newTexts],
    locators: [...screen.locators, ...taggedLocators],
    states: [...screen.states, { id: state.id, reachedBy: state.reachedBy, addsTexts: newTexts }],
  };
}
