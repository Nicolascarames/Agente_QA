import { spawn } from "node:child_process";

export type FileKind = "markdown" | "html";

export interface OpenCommand {
  command: string;
  args: string[];
}

export function resolveOpenCommand(
  kind: FileKind,
  filePath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): OpenCommand {
  if (kind === "markdown" && env.TERM_PROGRAM === "vscode") {
    return { command: "code", args: [filePath] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", filePath] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [filePath] };
  }
  return { command: "xdg-open", args: [filePath] };
}

function trySpawn(cmd: OpenCommand): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd.command, cmd.args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function openFile(kind: FileKind, filePath: string): Promise<void> {
  const primary = resolveOpenCommand(kind, filePath, process.env, process.platform);
  const launched = await trySpawn(primary);
  if (launched || primary.command !== "code") return;

  // "code" wasn't on PATH even though we're inside a VSCode terminal — fall
  // back to the operating system's own opener instead of failing silently.
  const fallback = resolveOpenCommand(kind, filePath, {}, process.platform);
  await trySpawn(fallback);
}
