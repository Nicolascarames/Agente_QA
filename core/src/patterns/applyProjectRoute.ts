import type { Pattern } from "../schemas/pattern.js";

// Never synthesises navigationHints from scratch: a user-saved pattern without
// hints plus a configured route would produce requiresLogin:false and silently
// skip the real login for a flow that needs it.
export function applyProjectRoute(
  pattern: Pattern | null,
  routes: Record<string, string>
): Pattern | null {
  if (!pattern) return null;
  const route = routes[pattern.name];
  if (!route || !pattern.navigationHints) return pattern;

  return {
    ...pattern,
    navigationHints: {
      ...pattern.navigationHints,
      routeCandidates: [route, ...pattern.navigationHints.routeCandidates],
    },
  };
}
