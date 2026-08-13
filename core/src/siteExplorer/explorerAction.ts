import { z } from "zod";

export const ClickableRoleSchema = z.enum(["button", "link", "menuitem", "tab", "checkbox"]);

export const ExplorerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), target: z.string().min(1) }),
  z.object({ action: z.literal("click"), role: ClickableRoleSchema, name: z.string().min(1) }),
  z.object({
    action: z.literal("fill_credential"),
    labelText: z.string().min(1),
    field: z.enum(["username", "password"]),
  }),
  z.object({ action: z.literal("done") }),
  z.object({ action: z.literal("fail"), reason: z.string().min(1) }),
]);
export type ExplorerAction = z.infer<typeof ExplorerActionSchema>;
