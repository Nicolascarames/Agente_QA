import { promises as fs } from "node:fs";
import path from "node:path";
import { PatternSchema, type Pattern } from "../schemas/pattern.js";
import { slugify } from "../util/slugify.js";
import { loginPattern } from "./builtin/login.js";
import { logoutPattern } from "./builtin/logout.js";
import { signupPattern } from "./builtin/signup.js";
import { passwordResetPattern } from "./builtin/passwordReset.js";

function projectPatternsDir(projectRoot: string): string {
  return path.join(projectRoot, ".agente-qa", "templates");
}

export function loadBuiltinPatterns(): Pattern[] {
  return [loginPattern, logoutPattern, signupPattern, passwordResetPattern];
}

export async function loadProjectPatterns(projectRoot: string): Promise<Pattern[]> {
  const dir = projectPatternsDir(projectRoot);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  // One malformed file must not cost the project every OTHER pattern it has
  // saved — before this, a single invalid JSON file (or one still carrying the
  // pre-app-map pageObjectTemplate/navigationHints shape .strict() now rejects)
  // threw out of the whole function and `loadProjectPatterns` returned nothing
  // at all instead of just skipping the one file that failed to parse.
  const patterns: Pattern[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf-8");
      patterns.push(PatternSchema.parse(JSON.parse(raw)));
    } catch {
      continue;
    }
  }
  return patterns;
}

export async function loadAllPatterns(projectRoot: string): Promise<Pattern[]> {
  return [...loadBuiltinPatterns(), ...(await loadProjectPatterns(projectRoot))];
}

export async function saveProjectPattern(projectRoot: string, pattern: Pattern): Promise<void> {
  const dir = projectPatternsDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${slugify(pattern.name)}.json`;
  await fs.writeFile(path.join(dir, fileName), JSON.stringify(pattern, null, 2), "utf-8");
}
