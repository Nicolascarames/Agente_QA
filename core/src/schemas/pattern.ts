import { z } from "zod";

// .strict(): a saved pattern still carrying the retired pageObjectTemplate/
// navigationHints fields (from before the app-map pipeline replaced the site
// explorer) must fail to parse, loudly, instead of silently having those
// fields stripped — that silence is exactly what would let the explorer-era
// shape wire itself back in unnoticed.
export const PatternSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    gherkinTemplate: z.string().min(1),
  })
  .strict();
export type Pattern = z.infer<typeof PatternSchema>;
