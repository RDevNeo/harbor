// What programs Harbor starts expect to find in their environment.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setenv } from "./libc.ts";
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

/**
 * Windows: this process's environment as Harbor's code expects it, before anything reads it. The variable
 * is called "Path" there, and a copy of process.env (`{ ...process.env, PATH: … }`, as many spawns make) would
 * hand a child both "Path" and "PATH": it's renamed PATH (Windows' names ignore case, so nothing else changes).
 * Then the tool folders and HOME (childDefaults), for every Harbor process: the app, its turn runners, its MCP
 * servers. Nothing elsewhere.
 */
export function normalize(env: NodeJS.ProcessEnv = process.env): void {
  if (platform(env) !== "win32") return;
  const path = env.PATH;
  if (path !== undefined && !Object.keys(env).includes("PATH")) {
    delete env.PATH;
    env.PATH = path;
  }
  const add = windowsDefaults(env);
  Object.assign(env, add);
  // Bun looks programs up (Bun.spawn without env, Bun.which) in the process's own environment block, which
  // assignments to process.env don't reach on Windows: PATH goes there too.
  if (env === process.env && add.PATH !== undefined) setenv("PATH", add.PATH, true);
  if (env === process.env) currentEnvForBun();
}

let wrapped = false;

/**
 * Windows: Bun.spawn, Bun.spawnSync and Bun.which without an `env` look programs up in Bun's copy of the
 * environment from the process's start, not in process.env as it is now (node:child_process uses the current
 * one). They're given the current one, so what normalize() added (Git Bash's tools) is found by every spawn.
 */
function currentEnvForBun(): void {
  if (wrapped || typeof Bun === "undefined") return;
  wrapped = true;
  type Spawn = (...a: unknown[]) => unknown;
  const b = Bun as unknown as Record<"spawn" | "spawnSync" | "which", Spawn>;
  const withEnv = (f: Spawn): Spawn =>
    function (this: unknown, ...a: unknown[]): unknown {
      const [first, second] = a;
      if (Array.isArray(first)) {
        const o = (second ?? {}) as { env?: unknown };
        return f.call(this, first, o.env === undefined ? { ...o, env: process.env } : o, ...a.slice(2));
      }
      if (first !== null && typeof first === "object" && (first as { env?: unknown }).env === undefined) {
        return f.call(this, { ...(first as object), env: process.env }, ...a.slice(1));
      }
      return f.apply(this, a);
    };
  const which = b.which;
  try {
    b.spawn = withEnv(b.spawn);
    b.spawnSync = withEnv(b.spawnSync);
    b.which = function (this: unknown, name: unknown, opts?: unknown): unknown {
      const o = (opts ?? {}) as { PATH?: string };
      return which.call(this, name, o.PATH === undefined ? { ...o, PATH: process.env.PATH ?? "" } : o);
    };
  } catch {
    // Bun's own functions can't be replaced: programs are then found on the start PATH only
  }
}

/**
 * The command line that runs `program` (a resolved path): itself, except on Windows for npm's .cmd shims (Codex,
 * Claude Code from npm), which become node and the package's script, so arguments with quotes, `&` or `%` (a
 * prompt, a JSON config) reach the program as they are, and for `#!` scripts (a wrapper in ~/.local/bin), which
 * run with their interpreter as Git Bash would. Spawn `[...argvOf(p), ...args]`.
 */
export function argvOf(program: string, env: Env = process.env): string[] {
  if (platform() !== "win32") return [program];
  const { argvOf: shim } = require("./win32/shim.ts") as typeof import("./win32/shim.ts");
  return shim(program, (name) => Bun.which(name, { PATH: env.PATH ?? env.Path ?? "" }), gitBashDir(env));
}
