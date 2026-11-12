// Where per-user files go, by the system's conventions: XDG on Linux (and on macOS, so paths stay
// shell-friendly); on Windows data in %APPDATA%, state in %LOCALAPPDATA%, caches in %LOCALAPPDATA%\Cache.
// The XDG_* variables win everywhere (tests and rigs set them).
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

const win = (): boolean => platform() === "win32";

export function home(env: Env = process.env): string {
  return env.HOME || (win() ? env.USERPROFILE : undefined) || homedir() || "/";
}

/** %APPDATA% (roaming) and %LOCALAPPDATA% (this PC's) on Windows. */
const appData = (env: Env): string => env.APPDATA || join(home(env), "AppData", "Roaming");
const localAppData = (env: Env): string => env.LOCALAPPDATA || join(home(env), "AppData", "Local");

/** User data (XDG_DATA_HOME): Harbor keeps harbor.db under it. */
export function dataHome(env: Env = process.env): string {
  return env.XDG_DATA_HOME || (win() ? appData(env) : join(home(env), ".local", "share"));
}

/** The desktop's Trash (freedesktop.org: `files/` and `info/*.trashinfo` under the data folder). */
export function trashHome(env: Env = process.env): string {
  return join(dataHome(env), "Trash");
}

/** State worth keeping across restarts but not backing up (XDG_STATE_HOME). */
export function stateHome(env: Env = process.env): string {
  return env.XDG_STATE_HOME || (win() ? localAppData(env) : join(home(env), ".local", "state"));
}

/** Caches (XDG_CACHE_HOME). */
export function cacheHome(env: Env = process.env): string {
  return env.XDG_CACHE_HOME || (win() ? join(localAppData(env), "Cache") : join(home(env), ".cache"));
}

/** Settings (XDG_CONFIG_HOME). */
export function configHome(env: Env = process.env): string {
  return env.XDG_CONFIG_HOME || (win() ? appData(env) : join(home(env), ".config"));
}

/** The session's runtime folder (XDG_RUNTIME_DIR), when it is set to an absolute path. */
export function runtimeDir(env: Env = process.env): string | undefined {
  const d = env.XDG_RUNTIME_DIR;
  return d && isAbsolute(d) ? d : undefined;
}

/** A folder in RAM for short-lived files when there is no runtime folder: /dev/shm on Linux, else the temp folder. */
export function ramBase(): string {
  return platform() === "linux" ? "/dev/shm" : tmpdir();
}

/**
 * `path` with the home folder `home` written `~`: "~" for the home itself, "~/x/y" under it, else `path` as it is.
 * Windows: either separator and any case match, and what's under the home is written with "/" ("~/Projects/x",
 * as Git Bash writes it; Harbor reads it back). `trimEnd`: a trailing "/" of `path` is dropped first.
 */
export function tilde(path: string, home: string, trimEnd = false): string {
  const w = win();
  const norm = (s: string): string => (w ? s.replaceAll("\\", "/") : s);
  const h = norm(home).replace(/\/+$/, "");
  if (h === "") return path;
  let p = norm(path);
  if (trimEnd) p = p.replace(/\/+$/, "");
  const same = (a: string, b: string): boolean => (w ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p, h) || same(p, `${h}/`)) return "~";
  if (same(p.slice(0, h.length + 1), `${h}/`)) return `~/${p.slice(h.length + 1).replace(/^\/+/, "")}`;
  return path;
}

/**
 * Whether `path` is the folder `dir` or inside it: null when not, else what follows `dir` ("" for `dir` itself),
 * `path`'s own text. Windows: either separator and any case match.
 */
export function under(path: string, dir: string): string | null {
  const w = win();
  const d = w ? dir.replace(/[\\/]+$/, "") : dir;
  const same = (a: string, b: string): boolean => (w ? a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase() : a === b);
  if (same(path, d)) return "";
  const head = path.slice(0, d.length);
  const next = path[d.length];
  if (!same(head, d) || !(next === "/" || (w && next === "\\"))) return null;
  return path.slice(d.length + 1);
}
