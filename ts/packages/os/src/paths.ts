// Where per-user files go, by the system's conventions (XDG on Linux).
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

export function home(env: Env = process.env): string {
  return env.HOME || homedir() || "/";
}

/** User data (XDG_DATA_HOME): Harbor keeps harbor.db under it. */
export function dataHome(env: Env = process.env): string {
  return env.XDG_DATA_HOME || join(home(env), ".local", "share");
}

/** The desktop's Trash (freedesktop.org: `files/` and `info/*.trashinfo` under the data folder). */
export function trashHome(env: Env = process.env): string {
  return join(dataHome(env), "Trash");
}

/** State worth keeping across restarts but not backing up (XDG_STATE_HOME). */
export function stateHome(env: Env = process.env): string {
  return env.XDG_STATE_HOME || join(home(env), ".local", "state");
}

/** Caches (XDG_CACHE_HOME). */
export function cacheHome(env: Env = process.env): string {
  return env.XDG_CACHE_HOME || join(home(env), ".cache");
}

/** Settings (XDG_CONFIG_HOME). */
export function configHome(env: Env = process.env): string {
  return env.XDG_CONFIG_HOME || join(home(env), ".config");
}

/** The session's runtime folder (XDG_RUNTIME_DIR), when it is set to an absolute path. */
export function runtimeDir(env: Env = process.env): string | undefined {
  const d = env.XDG_RUNTIME_DIR;
  return d && d.startsWith("/") ? d : undefined;
}

/** A folder in RAM for short-lived files when there is no runtime folder: /dev/shm on Linux, else the temp folder. */
export function ramBase(): string {
  return platform() === "linux" ? "/dev/shm" : tmpdir();
}
