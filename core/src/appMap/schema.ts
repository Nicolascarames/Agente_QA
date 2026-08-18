import { z } from "zod";

/**
 * A locator only ever enters the map with count 1. Anything the crawler could
 * not pin down to a single element lives in `ambiguous` instead, so consumers
 * never have to reason about ambiguity.
 */
export const LocatorEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["input", "button", "link", "select", "text", "heading"]),
  accessibleName: z.string().optional(),
  python: z.string().min(1),
  count: z.literal(1),
  /** Set when the raw candidate matched more than one element and a region scoped it down. */
  disambiguatedBy: z.string().optional(),
  /** Set when the locator only exists in a non-default state of the screen. */
  stateId: z.string().optional(),
  /**
   * Semantic attributes only: what the element IS, never how it looks.
   * A class is rewritten by any restyle without a behavioural change, and
   * under utility CSS it is not even unique.
   */
  attributes: z.record(z.string(), z.string()).optional(),
  verifiedAt: z.string(),
});

export const ScreenStateSchema = z.object({
  id: z.string().min(1),
  reachedBy: z.object({
    action: z.enum(["click", "submit"]),
    locator: z.string(),
    data: z.enum(["valid", "invalid", "none"]),
  }),
  addsTexts: z.array(z.string()),
});

export const TransitionSchema = z.object({
  locator: z.string(),
  action: z.enum(["click", "submit"]),
  /** The destination `Screen.id`. Null when the click leaves the app, or led nowhere the map knows. */
  toScreenId: z.string().nullable(),
  urlChanged: z.boolean(),
  /** Set for links that leave the app's host: recorded, never followed. */
  externalUrl: z.string().optional(),
});

export const WriteActionSchema = z.object({
  locator: z.string(),
  label: z.string(),
  kind: z.enum(["submit"]),
  formFields: z.array(z.string()),
});

/**
 * `count` records what the candidate REALLY matched. A candidate that matched
 * zero elements — a text that only exists in another state of the screen, for
 * instance — is as ambiguous as one that matched five, and a floor of 2 here
 * only bought a schema that forced the crawler to write down a count it never
 * measured.
 */
export const AmbiguousCandidateSchema = z.object({
  candidate: z.string(),
  count: z.number().int().min(0),
  reason: z.string(),
});

export const ScreenReachedBySchema = z.object({
  entryScreenId: z.string().min(1),
  path: z
    .array(
      z.object({
        action: z.enum(["click", "submit"]),
        locator: z.string().min(1),
        data: z.enum(["valid", "invalid", "none"]),
      })
    )
    .min(1),
});

export const ScreenSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  className: z.string().min(1),
  urlTemplate: z.string().min(1),
  signature: z.string().min(1),
  requiresAuth: z.boolean(),
  texts: z.array(z.string()),
  /** Values the crawler itself typed. Excluded from `texts`: they are our input, not app copy. */
  probeValues: z.array(z.string()),
  locators: z.array(LocatorEntrySchema),
  states: z.array(ScreenStateSchema),
  ambiguous: z.array(AmbiguousCandidateSchema),
  transitions: z.array(TransitionSchema),
  writeActions: z.array(WriteActionSchema),
  /** Presente solo en una vista sin URL propia: cómo se llega a ella desde `entryScreenId`. */
  reachedBy: ScreenReachedBySchema.optional(),
});

export const ScenarioCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  screenId: z.string().min(1),
  involvedScreens: z.array(z.string()),
  rationale: z.string(),
});

export const AppMapSchema = z.object({
  schemaVersion: z.literal(2),
  appUrl: z.string().url(),
  createdAt: z.string(),
  /** false when the crawl was interrupted or hit a safety limit. */
  complete: z.boolean(),
  authenticated: z.boolean(),
  screens: z.array(ScreenSchema),
  scenarios: z.array(ScenarioCandidateSchema),
  stats: z.object({
    screens: z.number().int().min(0),
    locators: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    durationMs: z.number().int().min(0),
  }),
});

export const LocatorOverrideSchema = z.object({
  screenId: z.string().min(1),
  name: z.string().min(1),
  python: z.string().min(1),
  note: z.string().optional(),
});

export const OverridesFileSchema = z.object({
  schemaVersion: z.literal(1),
  locators: z.array(LocatorOverrideSchema),
});

export type LocatorEntry = z.infer<typeof LocatorEntrySchema>;
export type ScreenState = z.infer<typeof ScreenStateSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type WriteAction = z.infer<typeof WriteActionSchema>;
export type AmbiguousCandidate = z.infer<typeof AmbiguousCandidateSchema>;
export type ScreenReachedBy = z.infer<typeof ScreenReachedBySchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type ScenarioCandidate = z.infer<typeof ScenarioCandidateSchema>;
export type AppMap = z.infer<typeof AppMapSchema>;
export type LocatorOverride = z.infer<typeof LocatorOverrideSchema>;
export type OverridesFile = z.infer<typeof OverridesFileSchema>;
