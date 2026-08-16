import type { AppMap } from "../../appMap/schema.js";
import { screenLiterals } from "../../appMap/mapQuery.js";

export interface MissingLiteral {
  literal: string;
  screenId: string;
}

export interface FeatureLiteralCheck {
  missing: MissingLiteral[];
  candidates: string[];
  /**
   * False when the featureText carries no `@screen:` tag anywhere. Without a
   * tag `currentScreen` never leaves `null`, so every literal check below is
   * skipped and `missing` comes back empty regardless of what the feature
   * actually quotes — that emptiness must not be read as "grounded".
   */
  screenTagFound: boolean;
}

const SCREEN_TAG = /@screen:([\p{L}\p{N}_-]+)/u;

/**
 * A `fill` step's second quoted group is test DATA the tester invented (an
 * email, a password) — never app copy. Demanding it exist in the map would
 * make it impossible to write any scenario with input. Only the first quoted
 * group (the field name) is a UI literal and must be grounded.
 */
const FILL_STEP = /I fill "([^"]*)" with "([^"]*)"/;

/**
 * The gate that stops an invented literal from ever reaching a generated test.
 * It runs on the .feature, which is the file a human can still fix — by the
 * time the code exists the value is baked into an assertion.
 */
export function checkFeatureLiterals(featureText: string, map: AppMap): FeatureLiteralCheck {
  const missing: MissingLiteral[] = [];
  const candidates = new Set<string>();
  let currentScreen: string | null = null;
  let screenTagFound = false;

  for (const rawLine of featureText.split(/\r?\n/)) {
    const line = rawLine.trim();

    const tag = line.match(SCREEN_TAG);
    if (tag) {
      currentScreen = tag[1];
      screenTagFound = true;
      for (const literal of screenLiterals(map, currentScreen)) candidates.add(literal);
      continue;
    }
    if (/^(Feature|Scenario Outline|Scenario):/i.test(line) && !SCREEN_TAG.test(line)) {
      if (/^Feature:/i.test(line)) currentScreen = null;
      continue;
    }
    if (currentScreen === null) continue;

    const allowed = screenLiterals(map, currentScreen);

    const fillMatch = line.match(FILL_STEP);
    if (fillMatch) {
      const fieldLiteral = fillMatch[1];
      if (fieldLiteral.length > 0 && !allowed.includes(fieldLiteral)) {
        missing.push({ literal: fieldLiteral, screenId: currentScreen });
      }
      continue;
    }

    for (const quoted of line.matchAll(/"([^"]*)"/g)) {
      const literal = quoted[1];
      if (literal.length === 0) continue;
      if (!allowed.includes(literal)) missing.push({ literal, screenId: currentScreen });
    }
  }

  return { missing, candidates: Array.from(candidates), screenTagFound };
}
