// proc.ts's answers on Windows: the process list from Toolhelp32, the rest by opening each process
// for limited queries. Windows has no process groups and no states like Linux's: a process is "S" (alive)
// until it ends, its group is itself, and its start is its creation time in hundredths of a second since
// 1601 (with the pid, it names one process: pids are reused).
import type { Stat } from "../proc.ts";
import {
  EPOCH_DIFF_S,
  PROCESS_QUERY_LIMITED_INFORMATION,
  PROCESS_TERMINATE,
  commandLine,
  creationTime,
  entries,
  kernel32,
  sessionOf,
  splitCommandLine,
  stillActive,
  withProcess,
  workingSet,
  type Entry,
} from "./k32.ts";

const PAGE = 4096;

/** FILETIME → the start value proc.ts hands out. */
const startOf = (ft: number): number => Math.floor(ft / 1e5);

export function pids(): number[] {
  return entries().map((e) => e.pid).filter((p) => p !== 0);
}

function statOf(e: Entry): Stat | undefined {
  return (
    withProcess(e.pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) => {
      const ft = creationTime(h);
      if (ft === null) return undefined;
      const rss = workingSet(h) ?? 0;
      return { state: stillActive(h) ? "S" : "X", ppid: e.ppid, pgid: e.pid, start: startOf(ft), rssPages: Math.round(rss / PAGE) };
    }) ?? undefined
  );
}

export function stat(pid: number): Stat | undefined {
  const e = entries().find((x) => x.pid === pid);
  return e === undefined ? undefined : statOf(e);
}

export function table(): Map<number, Stat> {
  const out = new Map<number, Stat>();
  for (const e of entries()) {
    if (e.pid === 0) continue;
    const s = statOf(e);
    if (s) out.set(e.pid, s);
  }
  return out;
}

/** Just this process's start and liveness, without the whole list. */
export function startOfPid(pid: number): { start: number; active: boolean } | undefined {
  return (
    withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) => {
      const ft = creationTime(h);
      return ft === null ? undefined : { start: startOf(ft), active: stillActive(h) };
    }) ?? undefined
  );
}

export function exists(pid: number): boolean {
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, () => true) ?? entries().some((e) => e.pid === pid);
}

/** Seconds since the epoch from a start value. */
export function startedAtFrom(start: number): number {
  return Math.floor(start / 100) - EPOCH_DIFF_S;
}

export function cmdline(pid: number): string[] | undefined {
  const line = withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) => commandLine(h));
  if (line === null || line === undefined) return undefined;
  return splitCommandLine(line) ?? undefined;
}

/** The session a process runs in, standing in for its owner: one user's desktop is one session. */
export function ownerOf(pid: number): number | undefined {
  return sessionOf(pid) ?? undefined;
}

export function myUid(): number | undefined {
  return sessionOf(process.pid) ?? undefined;
}

/** `pid` and everything under it, by parent pid; a child must be younger than its parent (pids are reused). */
export function descendants(pid: number): number[] {
  const list = entries();
  const kids = new Map<number, number[]>();
  for (const e of list) {
    if (e.pid === 0 || e.pid === e.ppid) continue;
    const k = kids.get(e.ppid);
    if (k) k.push(e.pid);
    else kids.set(e.ppid, [e.pid]);
  }
  const born = new Map<number, number>();
  const bornOf = (p: number): number => {
    let v = born.get(p);
    if (v === undefined) {
      v = withProcess(p, PROCESS_QUERY_LIMITED_INFORMATION, (h) => creationTime(h)) ?? Number.POSITIVE_INFINITY;
      born.set(p, v);
    }
    return v;
  };
  const out = [pid];
  for (let i = 0; i < out.length; i++) {
    const parent = out[i] as number;
    for (const c of kids.get(parent) ?? []) if (!out.includes(c) && bornOf(c) >= bornOf(parent)) out.push(c);
  }
  return out;
}

export function terminate(pid: number, code = 1): boolean {
  const k = kernel32();
  return withProcess(pid, PROCESS_TERMINATE, (h) => !!k?.TerminateProcess(h, code)) ?? false;
}

/** The tree from the top down (a parent can't start new children once it's gone), twice for what started meanwhile. */
export function killTree(pid: number): void {
  for (let pass = 0; pass < 2; pass++) for (const p of descendants(pid)) terminate(p);
}
