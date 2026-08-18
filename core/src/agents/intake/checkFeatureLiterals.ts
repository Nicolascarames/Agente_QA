import type { AppMap } from "../../appMap/schema.js";
import { findScreen, screenLiterals } from "../../appMap/mapQuery.js";

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
 * group (the field name) is a UI literal and must be grounded. The
 * `the test username`/`the test password` forms carry no second quoted
 * group at all — valid credentials always come from `.env`, never a literal
 * the model could invent — and still match here so the field name is checked
 * the same way either form is written.
 */
const FILL_STEP = /I fill "([^"]*)" with (?:"([^"]*)"|the test (?:username|password))/;

/**
 * Every literal a scenario on this screen may legitimately quote — `screenLiterals`
 * (map texts + states' `addsTexts`) minus the crawler's own probe values, PLUS the
 * screen's own `name` and `id`. The prompt (`prompts/intake.ts`) mandates
 * `Given I am on the "<pantalla>" screen`, which quotes `screen.name` — and
 * `realCrawler` always sets `name: screenId`, a route slug that is never among a
 * screen's own texts. Admitting both here is what keeps that step (and a future
 * `Then I am on the "<pantalla>" screen`, same vocabulary) from being rejected as
 * an invented literal on every real crawl: they are facts of the map, not
 * something the model made up, which is the exact distinction this gate exists
 * to enforce. The probe-value exclusion mirrors `gherkinGenerationPrompt`'s own
 * filter — this is the one place both the prompt and this check must agree on
 * what may be quoted, so a probe value never leaks back to the user as a "real"
 * text in the exhaustion message either.
 */
function allowedLiterals(map: AppMap, screenId: string): string[] {
  const screen = findScreen(map, screenId);
  if (!screen) return screenLiterals(map, screenId);
  const literals = screenLiterals(map, screenId).filter((literal) => !screen.probeValues.includes(literal));
  return Array.from(new Set([...literals, screen.name, screen.id]));
}

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
      for (const literal of allowedLiterals(map, currentScreen)) candidates.add(literal);
      continue;
    }
    if (/^(Feature|Scenario Outline|Scenario):/i.test(line) && !SCREEN_TAG.test(line)) {
      if (/^Feature:/i.test(line)) currentScreen = null;
      continue;
    }
    if (currentScreen === null) continue;

    const allowed = allowedLiterals(map, currentScreen);

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
