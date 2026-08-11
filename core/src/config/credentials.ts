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
  CredentialsSchema.parse(creds);
  const filePath = credentialsPath(homeDir);
  const dirPath = path.dirname(filePath);
  // mode options on mkdir/writeFile keep a freshly created directory/file from ever
  // existing at loose (OS-default) permissions, even momentarily. The chmod calls
  // below are still needed on top: mode only applies at creation time, so it's a
  // no-op on a pre-existing directory/file from before this change.
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(creds, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(dirPath, 0o700);
  await fs.chmod(filePath, 0o600);
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
