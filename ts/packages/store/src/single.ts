// One Harbor per session: an flock on `harbor.lock`, beside the control socket. The kernel
// drops the lock when its holder dies, so a crash never blocks the next start.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { runDir } from "./paths.ts";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { desktop, lock } from "@harbor/os";

/** Set by a restart (reload.ts): the pid of the process that is leaving. The Rust app's exec keeps its pid; the runtime starts a new process. */
export const RELOADED_PID = "HARBOR_RELOADED_PID";

/** The control socket: HARBOR_SOCK, else harbor.sock in the runtime folder. */
export function socketPath(env: Record<string, string | undefined> = process.env): string {
  if (env.HARBOR_SOCK) return env.HARBOR_SOCK;
  return join(env.XDG_RUNTIME_DIR || runDir(env), "harbor.sock");
}

export const lockPath = (env: Record<string, string | undefined> = process.env): string => socketPath(env).replace(/\.[^./]*$/, ".lock");

let held: lock.Held | undefined;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Takes the instance lock. False when another Harbor holds it. */
export async function acquire(env: Record<string, string | undefined> = process.env, waitMs?: number): Promise<boolean> {
  const path = lockPath(env);
  // After a restart the lock is released by the old process a moment from now.
  const reloaded = Number(env[RELOADED_PID]) > 0;
  const deadline = Date.now() + (waitMs ?? (reloaded ? 5000 : 0));
  for (;;) {
    const got = lock.hold(path, false);
    // undefined: no lock to take (no file locks, a read-only folder): start, as the only one.
    if (got !== null) {
      try {
        writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
      } catch {
        // the pid is only a hint for people
      }
      held = got ?? { release() {} };
      if (env === process.env) delete process.env[RELOADED_PID];
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

/** This process holds the instance lock: it is the session's Harbor. */
export const holding = (): boolean => held !== undefined;

/** Releases the lock (the process exit does it too). */
export function release(): void {
  held?.release();
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
  desktop.allowRaise();
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await ask(path, JSON.stringify({ focus: true }))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/** Asks the running Harbor to restart as an update does (its window comes back where it was); true when it answered. */
export function restartRunning(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return ask(socketPath(env), JSON.stringify({ restart: true }));
}

/** Asks the running Harbor to quit as its tray's Quit does (turns and agents stop, data saved); true when it answered. */
export function quitRunning(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return ask(socketPath(env), JSON.stringify({ quit: true }));
}

/** Whether something listens on the control socket (connects, says nothing). */
export function socketListening(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(socketPath(env));
    s.setTimeout(2000, () => (s.destroy(), resolve(false)));
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
}

/** Whether a Harbor holds the instance lock now (without taking it). Null when that can't be told (no lock to test). */
export function lockHeld(env: Record<string, string | undefined> = process.env): boolean | null {
  return lock.heldElsewhere(lockPath(env));
}

/** Raises this process's window through the compositor (Wayland clients can't raise themselves). False when there is no compositor IPC to ask. */
export function raise(env: Record<string, string | undefined> = process.env): boolean {
  return desktop.raise(env);
}

interface HyprClient {
  pid: number;
  mapped?: boolean;
  hidden?: boolean;
  floating?: boolean;
  at?: [number, number];
  size?: [number, number];
  workspace?: { id: number; name: string };
}

/** The Hyprland rule (Lua table) that opens a window where `c` is: its workspace, without focus unless it has it, a floating one at its place and size. */
export function placeRule(c: HyprClient, focused: boolean): string | null {
  const ws = c.workspace;
  if (!ws || ws.name === "") return null;
  const name = ws.id < 0 || /^-?\d+$/.test(ws.name) ? ws.name : `name:${ws.name}`;
  const parts = [`workspace = ${JSON.stringify(`${name} silent`)}`];
  if (!focused) parts.push("no_initial_focus = true", "focus_on_activate = false");
  if (c.floating && c.at && c.size) parts.push("float = true", `move = ${JSON.stringify(`${c.at[0]} ${c.at[1]}`)}`, `size = ${JSON.stringify(`${c.size[0]} ${c.size[1]}`)}`);
  return `{ ${parts.join(", ")} }`;
}

/**
 * The environment that makes a new Harbor's window open where this process's is, for a restart: on Hyprland an exec
 * rule's token (HL_EXEC_RULE_TOKEN, which Hyprland matches in the environment of the window's process), taken by
 * running a tiny command through `hl.dsp.exec_cmd` with the rule. Without it the new window opens on the workspace
 * that's shown and takes the focus. {} elsewhere, or when this process has no window.
 */
export async function placeEnv(env: Record<string, string | undefined> = process.env, pid = process.pid): Promise<Record<string, string>> {
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) return {};
  const json = (what: string): unknown => {
    const r = spawnSync("hyprctl", ["-j", what], { encoding: "utf8", timeout: 2000 });
    try {
      return r.error || r.status !== 0 ? null : JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };
  const clients = json("clients");
  const mine = Array.isArray(clients) ? (clients as HyprClient[]).find((c) => c.pid === pid && c.mapped !== false && c.hidden !== true) : undefined;
  if (!mine) return {};
  const active = json("activewindow") as { pid?: number } | null;
  const rule = placeRule(mine, active?.pid === pid);
  if (rule === null) return {};
  const file = join(env.XDG_RUNTIME_DIR || runDir(env), `harbor-place-${pid}`);
  rmSync(file, { force: true });
  const cmd = `sh -c 'printf %s "$HL_EXEC_RULE_TOKEN" > ${file.replaceAll("'", "")}'`;
  const r = spawnSync("hyprctl", ["dispatch", `hl.dsp.exec_cmd([==[${cmd}]==], ${rule})`], { encoding: "utf8", timeout: 2000 });
  if (r.error || r.stdout.trim() !== "ok") return {};
  for (let i = 0; i < 50; i++) {
    let tok = "";
    try {
      tok = readFileSync(file, "utf8").trim();
    } catch {
      // not yet
    }
    if (tok !== "") {
      rmSync(file, { force: true });
      return { HL_EXEC_RULE_TOKEN: tok };
    }
    await sleep(20);
  }
  rmSync(file, { force: true });
  return {};
}
