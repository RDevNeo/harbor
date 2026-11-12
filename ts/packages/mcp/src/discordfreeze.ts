import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform, proc } from "@harbor/os";

/** Reclaimed a little at a time: a tool call shouldn't wait for it, and all at once is hard on a PC. */
const STEP = "32M";
const PAUSE_MS = 30;
/** Below this there's nothing left worth the writes. */
const ENOUGH = 16 << 20;
const CGROUP_ROOT = "/sys/fs/cgroup";

export type Held = { kind: "cgroups"; paths: string[] } | { kind: "signals"; pids: number[] };

export interface StopFlag {
  stopped: boolean;
}

export const heldWord = (h: Held): "cgroup" | "signals" => (h.kind === "cgroups" ? "cgroup" : "signals");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `leader`'s process group and everything under it. */
export function tree(leader: number): number[] {
  const all: [pid: number, ppid: number, pgrp: number][] = [...proc.table()].map(([pid, s]) => [pid, s.ppid, s.pgid]);
  const set = new Set(all.filter((p) => p[0] === leader || p[2] === leader).map((p) => p[0]));
  for (;;) {
    const more = all.filter((p) => !set.has(p[0]) && set.has(p[1])).map((p) => p[0]);
    if (more.length === 0) return [...set];
    for (const m of more) set.add(m);
  }
}

/** The cgroup a /proc/<pid>/cgroup file names, under `root`; only the unified (v2) line counts. */
export function cgroupIn(text: string, root: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) return undefined;
  const rel = line.slice(3).trim().replace(/^\/+/, "");
  return rel === "" ? undefined : join(root, rel);
}

function cgroups(pids: number[]): string[] {
  const found = new Set<string>();
  for (const p of pids) {
    try {
      const text = proc.cgroupText(p);
      if (text === undefined) continue;
      const cg = cgroupIn(text, CGROUP_ROOT);
      if (cg !== undefined) found.add(cg);
    } catch {
      continue;
    }
  }
  return [...found].sort();
}

/** Whether a cgroup holds only these processes: freezing anything else would be a disaster. */
export function only(procs: string, pids: number[]): boolean {
  return procs
    .split(/\s+/)
    .map((p) => Number.parseInt(p, 10))
    .filter((p) => Number.isFinite(p))
    .every((p) => pids.includes(p));
}

function ours(cg: string, pids: number[]): boolean {
  if (!existsSync(join(cg, "cgroup.freeze"))) return false;
  try {
    return only(readFileSync(join(cg, "cgroup.procs"), "utf8"), pids);
  } catch {
    return false;
  }
}

function setFrozen(cg: string, on: boolean): boolean {
  try {
    writeFileSync(join(cg, "cgroup.freeze"), on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

function frozen(cg: string): boolean {
  try {
    return readFileSync(join(cg, "cgroup.events"), "utf8").split("\n").includes("frozen 1");
  } catch {
    return false;
  }
}

async function byCgroups(pids: number[]): Promise<Held | undefined> {
  if (process.env.HARBOR_DISCORD_NO_CGROUP !== undefined) return undefined;
  const cgs = cgroups(pids);
  if (cgs.length === 0 || !cgs.every((c) => ours(c, pids))) return undefined;
  const held: Held = { kind: "cgroups", paths: cgs };
  if (!cgs.every((c) => setFrozen(c, true))) {
    thaw(held);
    return undefined;
  }
  const until = Date.now() + 3000;
  while (!cgs.every(frozen)) {
    if (Date.now() > until) {
      thaw(held);
      return undefined;
    }
    await sleep(5);
  }
  return held;
}

export function signal(pids: number[], sig: "SIGSTOP" | "SIGCONT" | "SIGKILL"): void {
  // Through @harbor/os: Windows has no such signals (it suspends threads, and a kill there ends the tree).
  if (sig !== "SIGKILL") {
    proc.pause(pids, sig === "SIGSTOP");
    return;
  }
  for (const p of pids) {
    try {
      process.kill(p, sig);
    } catch {
      continue;
    }
  }
}

/** Stops `leader`'s whole tree. */
export async function freeze(leader: number): Promise<Held> {
  const pids = tree(leader);
  if (pids.length === 0) throw new Error("nothing to freeze");
  const h = await byCgroups(pids);
  if (h !== undefined) return h;
  signal(pids, "SIGSTOP");
  return { kind: "signals", pids };
}

export function thaw(h: Held): void {
  if (h.kind === "cgroups") {
    for (const c of h.paths) setFrozen(c, false);
  } else {
    signal(h.pids, "SIGCONT");
  }
}

/**
 * Pushes a frozen client's memory out, until there's little left, the kernel can't take more, or
 * `stop` says a tool call wants it back. Only a cgroup can do this.
 */
export async function reclaim(h: Held, stop: StopFlag): Promise<void> {
  if (h.kind !== "cgroups") return;
  for (const c of h.paths) {
    for (;;) {
      if (stop.stopped) return;
      let left = 0;
      try {
        left = Number.parseInt(readFileSync(join(c, "memory.current"), "utf8").trim(), 10) || 0;
      } catch {
        left = 0;
      }
      // The kernel says no once it can't free what was asked: without swap, soon.
      if (left < ENOUGH) break;
      try {
        writeFileSync(join(c, "memory.reclaim"), STEP);
      } catch {
        break;
      }
      await sleep(PAUSE_MS);
    }
  }
}

/** Clears what a dead host left: a shell can't notice its pipe closed while it's frozen. */
export function killLeftOver(leader: number): void {
  const pids = tree(leader);
  thaw({ kind: "cgroups", paths: cgroups(pids).filter((c) => ours(c, pids)) });
  signal(pids, "SIGCONT");
  if (platform() === "win32") {
    proc.killTree(leader);
    return;
  }
  try {
    process.kill(-leader, "SIGKILL");
  } catch {
    // the group is already gone
  }
  signal(pids, "SIGKILL");
}
