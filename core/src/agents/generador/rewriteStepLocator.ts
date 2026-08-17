const SCREEN_TAG = /@screen:([\p{L}\p{N}_-]+)/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pin an ambiguous step to one locator by name. Only `I click "<x>"` and the
 * FIRST quoted group of `I fill "<x>" with "<y>"` name a locator; the fill
 * step's second group is test data and a `Then I see "<x>"` asserts app copy —
 * neither is ever rewritten.
 *
 * Scoped to the scenarios under `screenId`: the same words on another screen
 * are another screen's locators, and answering for one must not answer for the
 * other.
 */
export function rewriteStepLocator(
  featureText: string,
  screenId: string,
  quoted: string,
  locatorName: string
): string {
  const literal = escapeRegExp(quoted);
  const click = new RegExp(`(I click ")${literal}(")`);
  const fill = new RegExp(`(I fill ")${literal}(" with ")`);

  let current: string | null = null;
  return featureText
    .split(/\r?\n/)
    .map((line) => {
      const tag = line.match(SCREEN_TAG);
      if (tag) {
        current = tag[1];
        return line;
      }
      if (/^\s*Feature:/i.test(line)) {
        current = null;
        return line;
      }
      if (current !== screenId) return line;
      const rewritten = line.replace(fill, `$1${locatorName}$2`);
      return rewritten === line ? line.replace(click, `$1${locatorName}$2`) : rewritten;
    })
    .join(featureText.includes("\r\n") ? "\r\n" : "\n");
}
