// Processes: what runs, who started it, when, and under whom. Linux reads /proc; other systems get
// their own reader behind these functions (until then they answer as if nothing were running).
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { platform } from "./platform.ts";

const procfs = (): boolean => platform() === "linux";

export function pids(): number[] {
  if (!procfs()) return [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const n of names) if (/^\d+$/.test(n)) out.push(Number(n));
  return out;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** One process, as the kernel describes it. */
export interface Stat {
  /** R, S, D, Z (ended, not reaped), X (dead), T… */
  state: string;
  ppid: number;
  /** Its process group. */
  pgid: number;
  /** When it started, in clock ticks since boot: with the pid, it names one process (pids are reused). */
  start: number;
  /** Resident memory in pages (pageSize() bytes each). */
  rssPages: number;
}

/** /proc/<pid>/stat's fields after "(comm)": comm may hold spaces and parentheses, so read after the last ')'. */
export function parseStat(text: string): Stat | undefined {
  const i = text.lastIndexOf(")");
  if (i < 0) return undefined;
  const f = text.slice(i + 1).trim().split(/\s+/);
  const n = (k: number): number => (/^-?\d+$/.test(f[k] ?? "") ? Number(f[k]) : Number.NaN);
  const s = { state: f[0] ?? "", ppid: n(1), pgid: n(2), start: n(19), rssPages: n(21) };
  return s.state !== "" && Number.isInteger(s.ppid) && Number.isInteger(s.pgid) ? s : undefined;
}

export function stat(pid: number | "self"): Stat | undefined {
  if (!procfs()) return undefined;
  const t = read(`/proc/${pid}/stat`);
  return t === undefined ? undefined : parseStat(t);
}

/** Every process once, by pid. */
export function table(): Map<number, Stat> {
  const out = new Map<number, Stat>();
  for (const p of pids()) {
    const s = stat(p);
    if (s) out.set(p, s);
  }
  return out;
}

/** When the process started, in clock ticks since boot. */
export function procStart(pid: number | "self"): number | undefined {
  const v = stat(pid)?.start;
  return v !== undefined && Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function parentOf(pid: number): number | undefined {
  const v = stat(pid)?.ppid;
  return v !== undefined && Number.isInteger(v) ? v : undefined;
}

const ended = (s: Stat): boolean => s.state === "Z" || s.state === "X";

/** The process is still the one that started at `start` (and not a zombie). */
export function alive(pid: number, start: number): boolean {
  const s = stat(pid);
  return s !== undefined && !ended(s) && s.start === start;
}

/** When a process that hasn't ended started (clock ticks since boot); undefined for an ended one or none. */
export function liveStart(pid: number | "self"): number | undefined {
  const s = stat(pid);
  return s !== undefined && !ended(s) && Number.isInteger(s.start) && s.start >= 0 ? s.start : undefined;
}

/** `pid` names a process that hasn't ended (a zombie has). */
export function running(pid: number): boolean {
  const s = stat(pid);
  return s !== undefined && !ended(s);
}

/** `pid` names a process, a zombie included. */
export function exists(pid: number): boolean {
  if (!procfs()) return false;
  try {
    statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

/** When the process started, in seconds since the epoch. */
export function startedAt(pid: number): number | undefined {
  const ticks = procStart(pid);
  if (ticks === undefined) return undefined;
  const line = read("/proc/stat")?.split("\n").find((l) => l.startsWith("btime "));
  if (!line) return undefined;
  const btime = Number(line.slice(6).trim());
  if (!Number.isInteger(btime)) return undefined;
  return btime + Math.floor(ticks / 100);
}

export function cmdline(pid: number): string[] | undefined {
  if (!procfs()) return undefined;
  let raw: Buffer;
  try {
    raw = readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return undefined;
  }
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === 0) {
      if (i > from) out.push(raw.subarray(from, i).toString("utf8"));
      from = i + 1;
    }
  }
  return out;
}

export function ownerOf(pid: number): number | undefined {
  if (!procfs()) return undefined;
  try {
    return statSync(`/proc/${pid}`).uid;
  } catch {
    return undefined;
  }
}

export function myUid(): number | undefined {
  if (!procfs()) return process.getuid?.();
  try {
    return statSync("/proc/self").uid;
  } catch {
    return undefined;
  }
}

/** `pid` and everything under it, by parent pid. */
export function descendants(pid: number): number[] {
  const kids = new Map<number, number[]>();
  for (const [p, s] of table()) {
    const list = kids.get(s.ppid);
    if (list) list.push(p);
    else kids.set(s.ppid, [p]);
  }
  const out = [pid];
  for (let i = 0; i < out.length; i++) {
    const k = kids.get(out[i] as number);
    if (k) out.push(...k);
  }
  return out;
}

/** The live processes of process group `pgid`. */
export function group(pgid: number): number[] {
  const out: number[] = [];
  for (const [p, s] of table()) if (s.state !== "Z" && s.pgid === pgid) out.push(p);
  return out;
}

function signal(sig: NodeJS.Signals, list: number[]): void {
  for (const p of list) {
    try {
      process.kill(p, sig);
    } catch {
      // the process ended meanwhile
    }
  }
}

/** By parent pid, not process group: agents run Bash commands in their own sessions, which a group kill would miss. */
export function killTree(pid: number): void {
  let tree = [pid];
  for (let i = 0; i < 8; i++) {
    signal("SIGSTOP", tree);
    const found = descendants(pid);
    if (found.length === tree.length) break;
    tree = found;
  }
  signal("SIGKILL", tree);
}

/** A path that reads `<dir>/<name>` as `pid` has it open, also once the file was deleted. */
export function openFile(pid: number, dir: string, name: string): string | undefined {
  if (!procfs()) return undefined;
  const want = join(dir, name);
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return undefined;
  }
  for (const fd of fds) {
    const p = `/proc/${pid}/fd/${fd}`;
    try {
      const t = readlinkSync(p);
      if (t === want || t === `${want} (deleted)`) return p;
    } catch {
      // an fd closed meanwhile
    }
  }
  return undefined;
}

/** The text of /proc/<pid>/cgroup; undefined where there are no cgroups to ask. */
export function cgroupText(pid: number | "self"): string | undefined {
  return procfs() ? read(`/proc/${pid}/cgroup`) : undefined;
}

/** This process's executable was replaced on disk since it started (an update swapped it). */
export function selfExeReplaced(): boolean {
  if (procfs()) {
    try {
      return readlinkSync("/proc/self/exe").endsWith(" (deleted)");
    } catch {
      // fall through
    }
  }
  return process.execPath.endsWith(" (deleted)");
}

let pageBytes: number | null = null;

/** The memory page size, for Stat.rssPages. */
export function pageSize(): number {
  if (pageBytes === null) {
    const out = spawnSync("getconf", ["PAGESIZE"], { encoding: "utf8", timeout: 2000 }).stdout ?? "";
    pageBytes = /^\d+\s*$/.test(out) ? Number(out) : 4096;
  }
  return pageBytes;
}
