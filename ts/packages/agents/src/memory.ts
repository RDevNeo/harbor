// What a chat's processes and this PC hold in memory, read from /proc only when something shows it.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { Kind } from "./providers.ts";

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

/** The shell line that prints a device's RAM over SSH: /proc/meminfo on Linux, sysctl and vm_stat on macOS. */
export const DEVICE_RAM_SH = "cat /proc/meminfo 2>/dev/null || { sysctl hw.memsize vm.swapusage; vm_stat; }";

/** DEVICE_RAM_SH's output. macOS's used is what Activity Monitor calls Memory Used: app memory, wired and compressed. */
export function parseDeviceRam(text: string): Ram | null {
  const linux = parseMeminfo(text);
  if (linux) return linux;
  const total = Number(text.match(/^hw\.memsize:\s*(\d+)/m)?.[1] ?? NaN);
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? NaN);
  if (!(total > 0) || !(page > 0)) return null;
  const pages = (name: string): number | null => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"));
    return m?.[1] === undefined ? null : Number(m[1]);
  };
  const anon = pages("Anonymous pages");
  const app = anon !== null ? Math.max(0, anon - (pages("Pages purgeable") ?? 0)) : (pages("Pages active") ?? 0);
  const used = (app + (pages("Pages wired down") ?? 0) + (pages("Pages occupied by compressor") ?? 0)) * page;
  const mb = (k: string): number => {
    const m = text.match(new RegExp(`vm\\.swapusage:.*?${k} = ([\\d.]+)([KMG])`));
    return m?.[1] === undefined ? 0 : Number(m[1]) * 1024 ** ({ K: 1, M: 2, G: 3 }[m[2] as "K" | "M" | "G"] ?? 2);
  };
  return { total, used: Math.min(total, used), swapTotal: mb("total"), swapUsed: mb("used") };
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
  /** The chat's own agent between turns (a lead waiting on its subagents, say): nothing of it runs. */
  idle?: boolean;
}

/** What the engine knows of a chat's processes. */
export interface MemSource {
  chats: readonly { id: number; title: string; name: string; role: string; parent: number | null; home: string; retired: boolean }[];
  /** A chat's running turn: its runner's pid and the agent's kind. */
  runner(id: number): { pid: number; kind: string } | null;
  /** For its row between turns ("": unknown). */
  kind?(id: number): Kind | "";
  procs: readonly { name: string; lead: number; owner: number; pid: number }[];
}

/** A chat's processes: its agent (listed between turns too, idle), its subagents' (for a lead) and the processes started for it. */
export function chatParts(src: MemSource, id: number, t: ProcTable, seen: Set<number> = new Set()): MemPart[] {
  const chat = src.chats.find((c) => c.id === id);
  if (!chat) return [];
  const out: MemPart[] = [];
  const own = src.runner(id);
  const who = chat.role === "lead" ? "Lead" : "Agent";
  const ownBytes = own ? treeBytes(t, [own.pid], seen) : 0;
  const kind = own?.kind ?? src.kind?.(id) ?? "";
  const agent: MemPart = { kind: "agent", label: kind === "" ? who : `${who} · ${kind}`, bytes: ownBytes };
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
  const rest = out.filter((p) => p.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  // A lead ends its turn once its subagents are off: it still heads the breakdown, idle.
  return ownBytes > 0 ? [agent, ...rest].sort((a, b) => b.bytes - a.bytes) : [{ ...agent, idle: true }, ...rest];
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
  chats: readonly (MemSource["chats"][number] & { account: string })[];
  turns: ReadonlyMap<number, { turn: { meta: { pid: number; kind: string } } | null }>;
  procs: MemSource["procs"];
  account(id: string): { kind: Kind } | undefined;
}): MemSource {
  return {
    chats: e.chats,
    kind: (id) => {
      const c = e.chats.find((x) => x.id === id);
      return c ? (e.account(c.account)?.kind ?? "") : "";
    },
    runner: (id) => {
      const m = e.turns.get(id)?.turn?.meta;
      return m && m.pid > 0 ? { pid: m.pid, kind: m.kind } : null;
    },
    procs: e.procs,
  };
}
