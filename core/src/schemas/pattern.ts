import { z } from "zod";

export const PatternSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  gherkinTemplate: z.string().min(1),
  pageObjectTemplate: z.string(),
});
export type Pattern = z.infer<typeof PatternSchema>;
