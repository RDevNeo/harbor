// One Harbor per session: an flock on `harbor.lock`, beside the control socket. The kernel
// drops the lock when its holder dies, so a crash never blocks the next start.

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { runDir } from "./paths.ts";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Set on the exec of a hot reload: this pid is a reload, not a second launch. */
export const RELOADED_PID = "HARBOR_RELOADED_PID";

const LOCK_EX = 2;
const LOCK_NB = 4;

const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/** The control socket: HARBOR_SOCK, else harbor.sock in the runtime folder. */
export function socketPath(env: Record<string, string | undefined> = process.env): string {
  if (env.HARBOR_SOCK) return env.HARBOR_SOCK;
  return join(env.XDG_RUNTIME_DIR || runDir(env), "harbor.sock");
}

export const lockPath = (env: Record<string, string | undefined> = process.env): string => socketPath(env).replace(/\.[^./]*$/, ".lock");

let held: number | undefined;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Takes the instance lock. False when another Harbor holds it. */
export async function acquire(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  let fd: number;
  try {
    fd = openSync(lockPath(env), "a+", 0o600);
  } catch {
    // No lock file (read-only runtime dir?): don't keep Harbor from starting.
    return true;
  }
  // After a hot reload the lock was released by the exec a moment ago.
  const reloaded = Number(env[RELOADED_PID]) === process.pid;
  const deadline = Date.now() + (reloaded ? 3000 : 0);
  for (;;) {
    if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) {
      ftruncateSync(fd, 0);
      writeSync(fd, `${process.pid}\n`, 0);
      held = fd;
      return true;
    }
    if (Date.now() >= deadline) {
      closeSync(fd);
      return false;
    }
    await sleep(50);
  }
}

/** Releases the lock (the process exit does it too). */
export function release(): void {
  if (held !== undefined) closeSync(held);
  held = undefined;
}

function ask(path: string, line: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    let buf = "";
    s.setTimeout(5000, () => {
      s.destroy();
      resolve(false);
    });
    s.on("connect", () => s.write(`${line}\n`));
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        s.destroy();
        resolve(buf.includes('"ok":true'));
      }
    });
    s.on("error", () => resolve(false));
    s.on("close", () => resolve(buf.includes('"ok":true')));
  });
}

/** Asks the running Harbor to show itself; true when it answered. Retries for a few seconds, in case it is still starting. */
export async function focusRunning(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const path = socketPath(env);
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await ask(path, JSON.stringify({ focus: true }))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/** Raises this process's window through the compositor (Wayland clients can't raise themselves). False when there is no compositor IPC to ask. */
export function raise(env: Record<string, string | undefined> = process.env): boolean {
  const pid = process.pid;
  if (env.HYPRLAND_INSTANCE_SIGNATURE) {
    const hypr = (args: string[]): boolean => {
      const r = spawnSync("hyprctl", args, { encoding: "utf8" });
      return !r.error && r.stdout.trim() === "ok";
    };
    return hypr(["dispatch", `hl.dsp.focus({ window = "pid:${pid}" })`]) || hypr(["dispatch", "focuswindow", `pid:${pid}`]);
  }
  if (env.SWAYSOCK) {
    const r = spawnSync("swaymsg", [`[pid=${pid}] focus`], { encoding: "utf8" });
    return !r.error && r.status === 0;
  }
  return false;
}
