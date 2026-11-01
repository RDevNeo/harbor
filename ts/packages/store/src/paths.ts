import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

export function home(env: Env = process.env): string {
  return env.HOME || homedir() || "/";
}

/** Harbor's data on this computer: harbor.db and the app sign-ins under `apps/`. */
export function dataDir(env: Env = process.env): string {
  return join(env.XDG_DATA_HOME || join(home(env), ".local", "share"), "harbor");
}

/** Harbor's state on this computer (running turns, process logs), owner-only. */
export function stateDir(env: Env = process.env): string {
  return privateDir(join(env.XDG_STATE_HOME || join(home(env), ".local", "state"), "harbor"));
}

export function privateDir(p: string): string {
  try {
    mkdirSync(p, { recursive: true, mode: 0o700 });
    chmodSync(p, 0o700);
  } catch {
    // a read-only or foreign folder: callers meet the error when they use it
  }
  return p;
}

/** Writes through a temporary file so a reader never sees half of it; owner-only. */
export function writePrivate(p: string, data: string): void {
  const tmp = `${p.replace(/([^/])\.[^./]*$/, "$1")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomHex(n: number): string {
  return randomBytes(n).toString("hex");
}

export function newUuid(): string {
  return crypto.randomUUID();
}

/**
 * A folder only this user can open, in RAM, for frames and other short-lived files:
 * `$XDG_RUNTIME_DIR/harbor` (else /dev/shm/harbor-<uid>), mode 0700.
 */
export function runDir(env: Env = process.env): string {
  const uid = process.getuid?.() ?? -1;
  const runtime = env.XDG_RUNTIME_DIR && env.XDG_RUNTIME_DIR.startsWith("/") && existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : undefined;
  const base = runtime ?? "/dev/shm";
  const ours = (p: string): boolean => {
    try {
      const m = lstatSync(p);
      return m.isDirectory() && m.uid === uid;
    } catch {
      return false;
    }
  };
  let dir = join(base, runtime ? "harbor" : `harbor-${uid}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    // exists already
  }
  for (let n = 0; !ours(dir) && n < 100; n++) {
    dir = join(base, `harbor-${uid}-${randomHex(8)}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      // try another name
    }
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours
  }
  return dir;
}
