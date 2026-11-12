// What programs Harbor starts expect to find in their environment.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/**
 * Variables to add for child programs: on macOS an app started from the Dock or Finder has no locale,
 * and shells and CLIs then treat text as ASCII (bash 3.2 drops what it can't read), so UTF-8 is set
 * when none is. Nothing elsewhere, or when the environment already says.
 */
export function childDefaults(env: Env = process.env): Record<string, string> {
  if (platform(env) === "win32") return windowsDefaults(env);
  if (platform(env) !== "darwin") return {};
  if (env.LC_ALL || env.LC_CTYPE || env.LANG) return {};
  return { LANG: "en_US.UTF-8" };
}

/**
 * Folders tools are installed to that an app's PATH may lack: macOS, Homebrew's (which only shells add);
 * Windows, Git Bash's (Git for Windows puts only git on PATH, Harbor runs `bash -lc`), Claude Code's native
 * install and npm's global folder (Codex).
 */
export function systemToolDirs(env: Env = process.env): string[] {
  if (platform(env) === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin"];
  if (platform(env) !== "win32") return [];
  const home = env.USERPROFILE || homedir();
  const out: string[] = [];
  const git = gitBashDir(env);
  if (git !== null) out.push(git);
  out.push(join(home, ".local", "bin"));
  if (env.APPDATA) out.push(join(env.APPDATA, "npm"));
  return out;
}

/**
 * Git for Windows' bin folder (bash.exe, sh.exe, git.exe): where its git.exe on PATH lives (…\Git\cmd beside
 * …\Git\bin), else its usual install folders. Null when Git for Windows isn't installed.
 */
export function gitBashDir(env: Env = process.env): string | null {
  const tries: string[] = [];
  for (const d of (env.PATH ?? env.Path ?? "").split(";")) {
    if (/[\\/]git[\\/](cmd|bin|mingw64[\\/]bin)[\\/]?$/i.test(d)) tries.push(join(d.replace(/[\\/]+$/, "").replace(/[\\/]mingw64[\\/]bin$/i, "\\mingw64"), "..", "bin"));
  }
  for (const root of [env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) {
    if (root) tries.push(join(root, "Git", "bin"));
  }
  for (const t of tries) if (existsSync(join(t, "bash.exe"))) return join(t);
  return null;
}

/** The suffixes a command's file may have (Windows: PATHEXT's, after the bare name); [""] elsewhere. */
export function execSuffixes(env: Env = process.env): string[] {
  if (platform(env) !== "win32") return [""];
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((x) => x !== "").map((x) => x.toLowerCase());
  return ["", ...exts];
}

/** Windows: the folders above at the front of PATH (Git Bash first: `bash` must be Git's, not WSL's), HOME when unset. */
function windowsDefaults(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  const path = env.PATH ?? env.Path ?? "";
  const have = path.split(delimiter).map((d) => d.toLowerCase());
  const add = systemToolDirs(env).filter((d) => !have.includes(d.toLowerCase()));
  // Git's Unix tools (sh, sleep, env…) after Windows' own, as Git Bash has them: what scripts and agents
  // expect, while `find` and `sort` stay Windows' for programs that call them.
  const git = gitBashDir(env);
  const tools = git === null ? null : join(git, "..", "usr", "bin");
  const after = tools !== null && !have.includes(tools.toLowerCase()) && existsSync(tools) ? [tools] : [];
  if (add.length + after.length > 0) out.PATH = [...add, path, ...after].filter((x) => x !== "").join(delimiter);
  if (!env.HOME) out.HOME = env.USERPROFILE || homedir();
  return out;
}
