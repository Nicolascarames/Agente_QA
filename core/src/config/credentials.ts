import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ProviderNameSchema = z.enum(["anthropic", "openai", "google"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const CredentialsSchema = z.object({
  provider: ProviderNameSchema,
  apiKey: z.string().min(1),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export function credentialsPath(homeDir: string): string {
  return path.join(homeDir, ".agente-qa", "credentials.json");
}

export async function saveCredentials(creds: Credentials, homeDir: string): Promise<void> {
  const filePath = credentialsPath(homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(creds, null, 2), "utf-8");
}

export async function loadCredentials(homeDir: string): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(credentialsPath(homeDir), "utf-8");
    return CredentialsSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
