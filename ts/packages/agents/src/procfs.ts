// Processes from /proc, as detach.rs and agent.rs read them.
import { readdirSync, readFileSync, statSync } from "node:fs";

export function pids(): number[] {
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

/** The fields after "(comm)": comm may hold spaces and parentheses, so read after the last ')'. */
function statFields(pid: number): string[] | undefined {
  const stat = read(`/proc/${pid}/stat`);
  if (stat === undefined) return undefined;
  const i = stat.lastIndexOf(")");
  if (i < 0) return undefined;
  return stat.slice(i + 1).trim().split(/\s+/);
}

/** /proc stat field 22: when the process started, in clock ticks since boot. */
export function procStart(pid: number): number | undefined {
  const f = statFields(pid);
  const v = f?.[19];
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
}

export function parentOf(pid: number): number | undefined {
  const v = statFields(pid)?.[1];
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
}

/** The process is still the one that started at `start` (and not a zombie). */
export function alive(pid: number, start: number): boolean {
  const f = statFields(pid);
  if (!f) return false;
  const state = f[0] ?? "Z";
  const st = f[19];
  return state !== "Z" && state !== "X" && st !== undefined && /^\d+$/.test(st) && Number(st) === start;
}

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
  try {
    return statSync(`/proc/${pid}`).uid;
  } catch {
    return undefined;
  }
}

export function myUid(): number | undefined {
  try {
    return statSync("/proc/self").uid;
  } catch {
    return undefined;
  }
}

export function descendants(pid: number): number[] {
  const kids = new Map<number, number[]>();
  for (const p of pids()) {
    const pp = parentOf(p);
    if (pp === undefined) continue;
    const list = kids.get(pp);
    if (list) list.push(p);
    else kids.set(pp, [p]);
  }
  const out = [pid];
  for (let i = 0; i < out.length; i++) {
    const k = kids.get(out[i] as number);
    if (k) out.push(...k);
  }
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
