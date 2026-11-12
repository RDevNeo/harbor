// What programs Harbor starts expect to find in their environment.

import { platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/**
 * Variables to add for child programs: on macOS an app started from the Dock or Finder has no locale,
 * and shells and CLIs then treat text as ASCII (bash 3.2 drops what it can't read), so UTF-8 is set
 * when none is. Nothing elsewhere, or when the environment already says.
 */
export function childDefaults(env: Env = process.env): Record<string, string> {
  if (platform(env) !== "darwin") return {};
  if (env.LC_ALL || env.LC_CTYPE || env.LANG) return {};
  return { LANG: "en_US.UTF-8" };
}

/** Folders tools are installed to that an app's PATH may lack (macOS: Homebrew's, which only shells add). */
export function systemToolDirs(env: Env = process.env): string[] {
  return platform(env) === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
}
