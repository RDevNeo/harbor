import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, platform } from "@harbor/os";

type Env = Record<string, string | undefined>;

export const home = (env: Env = process.env): string => paths.home(env);

/** Harbor's data on this computer: harbor.db and the app sign-ins under `apps/`. */
export function dataDir(env: Env = process.env): string {
  return join(paths.dataHome(env), "harbor");
}

/** Harbor's state on this computer (running turns, process logs), owner-only. */
export function stateDir(env: Env = process.env): string {
  return privateDir(join(paths.stateHome(env), "harbor"));
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

/** Writes through a temporary file so a reader never sees half of it; owner-only. The temporary file is this
 *  writer's own: two processes writing the same file at once (turns starting together) each rename a whole
 *  one, where a shared name let one rename the other's away and fail. */
export function writePrivate(p: string, data: string): void {
  const tmp = `${p}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameInto(tmp, p);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * rename(2) over `to`. Windows refuses (EPERM, EACCES, EBUSY) while another process is replacing or reading
 * that file at the same moment: tried again for up to a quarter second, as the other is done by then.
 */
function renameInto(from: string, to: string): void {
  const retry = platform() === "win32";
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!retry || i >= 50 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
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
  // No uid on Windows: its temp folder is the user's own already.
  const uid = process.getuid?.();
  const rt = paths.runtimeDir(env);
  const runtime = rt !== undefined && existsSync(rt) ? rt : undefined;
  const base = runtime ?? paths.ramBase();
  const ours = (p: string): boolean => {
    try {
      const m = lstatSync(p);
      return m.isDirectory() && (uid === undefined || m.uid === uid);
    } catch {
      return false;
    }
  };
  let dir = join(base, runtime || uid === undefined ? "harbor" : `harbor-${uid}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    // exists already
  }
  for (let n = 0; !ours(dir) && n < 100; n++) {
    dir = join(base, `harbor-${uid ?? "u"}-${randomHex(8)}`);
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
