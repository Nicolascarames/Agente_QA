import { z } from "zod";

export const NegativeProbeSchema = z.object({
  kind: z.literal("invalid-credentials"),
});
export type NegativeProbe = z.infer<typeof NegativeProbeSchema>;

export const NavigationHintsSchema = z.object({
  routeCandidates: z.array(z.string()).min(1),
  requiresLogin: z.boolean(),
  negativeProbe: NegativeProbeSchema.optional(),
});
export type NavigationHints = z.infer<typeof NavigationHintsSchema>;

export const PatternSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  gherkinTemplate: z.string().min(1),
  pageObjectTemplate: z.string(),
  navigationHints: NavigationHintsSchema.optional(),
});
export type Pattern = z.infer<typeof PatternSchema>;
