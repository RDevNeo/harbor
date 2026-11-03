// What a chat's processes and this PC hold in memory, read from /proc only when something shows it.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/** Bytes. */
export interface Ram {
  total: number;
  used: number;
  swapTotal: number;
  swapUsed: number;
}

/** /proc/meminfo: used is what isn't available (the kernel's own estimate, caches it can drop aside). */
export function parseMeminfo(text: string): Ram | null {
  const kb = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return m?.[1] === undefined ? null : Number(m[1]) * 1024;
  };
  const total = kb("MemTotal");
  const avail = kb("MemAvailable") ?? kb("MemFree");
  if (total === null || avail === null || total <= 0) return null;
  const swapTotal = kb("SwapTotal") ?? 0;
  return { total, used: Math.max(0, total - avail), swapTotal, swapUsed: Math.max(0, swapTotal - (kb("SwapFree") ?? swapTotal)) };
}

export function ram(): Ram | null {
  try {
    return parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

/** Every process once: its resident bytes, its children and the members of each process group. */
export interface ProcTable {
  rss: Map<number, number>;
  kids: Map<number, number[]>;
  groups: Map<number, number[]>;
}

/** /proc/<pid>/stat after "(comm)": ppid is field 4, pgrp 5, rss (pages) 24. */
export function parseStat(stat: string): { ppid: number; pgrp: number; pages: number } | null {
  const i = stat.lastIndexOf(")");
  if (i < 0) return null;
  const f = stat.slice(i + 1).trim().split(/\s+/);
  const n = (k: number): number => Number(f[k]);
  const out = { ppid: n(1), pgrp: n(2), pages: n(21) };
  return Number.isInteger(out.ppid) && Number.isInteger(out.pgrp) && Number.isInteger(out.pages) ? out : null;
}

let pageBytes: number | null = null;

function pageSize(): number {
  if (pageBytes === null) {
    const out = spawnSync("getconf", ["PAGESIZE"], { encoding: "utf8", timeout: 2000 }).stdout ?? "";
    pageBytes = /^\d+\s*$/.test(out) ? Number(out) : 4096;
  }
  return pageBytes;
}

export function procTable(): ProcTable {
  const t: ProcTable = { rss: new Map(), kids: new Map(), groups: new Map() };
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return t;
  }
  const page = pageSize();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let s;
    try {
      s = parseStat(readFileSync(`/proc/${n}/stat`, "utf8"));
    } catch {
      continue;
    }
    if (!s) continue;
    const pid = Number(n);
    t.rss.set(pid, s.pages * page);
    push(t.kids, s.ppid, pid);
    push(t.groups, s.pgrp, pid);
  }
  return t;
}

function push(m: Map<number, number[]>, k: number, v: number): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

/** The roots and everything under them, each process counted once across calls that share `seen`. */
export function treeBytes(t: ProcTable, roots: readonly number[], seen: Set<number>): number {
  let sum = 0;
  const todo = roots.filter((p) => p > 0);
  while (todo.length > 0) {
    const p = todo.pop() as number;
    if (seen.has(p) || !t.rss.has(p)) continue;
    seen.add(p);
    sum += t.rss.get(p) ?? 0;
    todo.push(...(t.kids.get(p) ?? []));
  }
  return sum;
}

export interface MemPart {
  kind: "agent" | "sub" | "proc";
  label: string;
  bytes: number;
}

/** What the engine knows of a chat's processes. */
export interface MemSource {
  chats: readonly { id: number; title: string; name: string; role: string; parent: number | null; home: string; retired: boolean }[];
  /** A chat's running turn: its runner's pid and the agent's kind. */
  runner(id: number): { pid: number; kind: string } | null;
  procs: readonly { name: string; lead: number; owner: number; pid: number }[];
}

/** A chat's processes: its agent, its subagents' (for a lead) and the processes started for it. */
export function chatParts(src: MemSource, id: number, t: ProcTable, seen: Set<number> = new Set()): MemPart[] {
  const chat = src.chats.find((c) => c.id === id);
  if (!chat) return [];
  const out: MemPart[] = [];
  const own = src.runner(id);
  if (own) out.push({ kind: "agent", label: `${chat.role === "lead" ? "Lead" : "Agent"} · ${own.kind}`, bytes: treeBytes(t, [own.pid], seen) });
  if (chat.role === "lead") {
    for (const s of src.chats) {
      if (s.parent !== id || s.role !== "sub" || s.retired) continue;
      const r = src.runner(s.id);
      if (r) out.push({ kind: "sub", label: s.name || s.title, bytes: treeBytes(t, [r.pid], seen) });
    }
  }
  for (const p of src.procs) {
    if (p.owner !== id && p.lead !== id) continue;
    // Its process group (npm → node → vite…), and anything it forked into another group.
    out.push({ kind: "proc", label: p.name, bytes: treeBytes(t, [p.pid, ...(t.groups.get(p.pid) ?? [])], seen) });
  }
  return out.filter((p) => p.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

export interface MemChat {
  id: number;
  title: string;
  bytes: number;
}

/** This PC's chats holding memory, the most first: a lead with its team, each other chat on its own. */
export function topChats(src: MemSource, t: ProcTable): MemChat[] {
  const seen = new Set<number>();
  const out: MemChat[] = [];
  for (const c of src.chats) {
    if (c.home !== "" || c.role === "sub") continue;
    const bytes = chatParts(src, c.id, t, seen).reduce((a, p) => a + p.bytes, 0);
    if (bytes > 0) out.push({ id: c.id, title: c.title, bytes });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** `GET /mesh/v1/memory` (and the window's own numbers): RAM, the chats holding memory and, asked for one, a chat's parts. */
export function snapshot(src: MemSource, chat: number | null, top = 5): Record<string, unknown> {
  const t = procTable();
  const r = ram();
  const chats = topChats(src, t);
  const out: Record<string, unknown> = {
    ram: r === null ? null : { total: r.total, used: r.used, swap_total: r.swapTotal, swap_used: r.swapUsed },
    running: chats.length,
    top: chats.slice(0, top).map((c) => ({ id: c.id, title: c.title, bytes: c.bytes })),
  };
  if (chat !== null) out.chat = { parts: chatParts(src, chat, t) };
  return out;
}

/** The engine's view of its chats, for the functions above. */
export function engineSource(e: {
  chats: MemSource["chats"];
  turns: ReadonlyMap<number, { turn: { meta: { pid: number; kind: string } } | null }>;
  procs: MemSource["procs"];
}): MemSource {
  return {
    chats: e.chats,
    runner: (id) => {
      const m = e.turns.get(id)?.turn?.meta;
      return m && m.pid > 0 ? { pid: m.pid, kind: m.kind } : null;
    },
    procs: e.procs,
  };
}
