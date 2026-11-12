// What a chat's processes and this PC hold in memory, read only when something shows it.
import { proc, sys } from "@harbor/os";
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
  const m = sys.parseMeminfo(text);
  return m === null ? null : ramOf(m);
}

function ramOf(m: sys.Memory): Ram {
  return { total: m.total, used: Math.max(0, m.total - m.available), swapTotal: m.swapTotal, swapUsed: Math.max(0, m.swapTotal - m.swapFree) };
}

/** The shell line that prints a device's RAM over SSH: /proc/meminfo on Linux, sysctl and vm_stat on macOS. */
export const DEVICE_RAM_SH = "cat /proc/meminfo 2>/dev/null || { sysctl hw.memsize vm.swapusage; vm_stat; }";

/** The words a turn's script on a device carries (a `: harbor-turn=<mark>` line), so `deviceProcsSh` finds its processes there. */
export const TURN_MARK = "harbor-turn=";

/** A turn's mark: this PC's mesh id and the chat's id here, in characters a shell and awk take as they are. */
export function turnMark(pc: string, chat: number): string {
  return `${pc.replace(/[^A-Za-z0-9._-]/g, "_")}.${chat}`;
}

/**
 * The shell line that prints, for each of `marks`, the resident KB of the processes under the turn's shell on a device
 * (`harbor-mem <mark> <kb>`, or `-` when none was found). Each process counts for its nearest marked ancestor. ps and awk on Linux and macOS alike;
 * the mark and its prefix go apart, so the awk reading them isn't taken for a turn.
 */
export function deviceProcsSh(marks: readonly string[]): string {
  const m = marks.filter((x) => /^[A-Za-z0-9._-]+$/.test(x)).join(" ");
  const awk =
    'BEGIN{n=split(m,ms," ")}' +
    "{par[$1]=$2;rss[$1]=$3;for(i=1;i<=n;i++)if(index($0,p ms[i])>0)root[$1]=ms[i]}" +
    'END{for(q in par){r=q;k=0;while(r!=""&&!(r in root)&&k<500){r=(r in par)?par[r]:"";k++}if(r in root)sum[root[r]]+=rss[q]}for(i=1;i<=n;i++)print "harbor-mem",ms[i],((ms[i] in sum)?sum[ms[i]]:"-")}';
  return `ps -A -ww -o pid= -o ppid= -o rss= -o args= 2>/dev/null | awk -v p=${TURN_MARK} -v m='${m}' '${awk}'`;
}

/** `deviceProcsSh`'s lines: each mark's bytes; a mark none of whose processes was found ("-": an older turn, or it ended) is left out. */
export function parseDeviceProcs(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(/^harbor-mem (\S+) (\d+)\s*$/gm)) if (m[1] !== undefined) out.set(m[1], Number(m[2]) * 1024);
  return out;
}

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
  const m = sys.memory();
  return m === null ? null : ramOf(m);
}

/** Every process once: its resident bytes, its children and the members of each process group. */
export interface ProcTable {
  rss: Map<number, number>;
  kids: Map<number, number[]>;
  groups: Map<number, number[]>;
}

/** /proc/<pid>/stat after "(comm)": ppid is field 4, pgrp 5, rss (pages) 24. */
export function parseStat(stat: string): { ppid: number; pgrp: number; pages: number } | null {
  const s = proc.parseStat(stat);
  return s !== undefined && Number.isInteger(s.rssPages) ? { ppid: s.ppid, pgrp: s.pgid, pages: s.rssPages } : null;
}

export function procTable(): ProcTable {
  const t: ProcTable = { rss: new Map(), kids: new Map(), groups: new Map() };
  const page = proc.pageSize();
  for (const [pid, s] of proc.table()) {
    if (!Number.isInteger(s.rssPages)) continue;
    t.rss.set(pid, s.rssPages * page);
    push(t.kids, s.ppid, pid);
    push(t.groups, s.pgid, pid);
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
  /** `link`: this PC's end of a turn on a device (the runner and its ssh), apart from the agent there. */
  kind: "agent" | "sub" | "proc" | "link";
  label: string;
  bytes: number;
  /** The chat's own agent between turns (a lead waiting on its subagents, say): nothing of it runs. */
  idle?: boolean;
  /** Runs on this device, not on this PC. */
  on?: string;
  /** Said instead of its bytes (a device not read yet). */
  note?: string;
}

/** A chat whose Runs on is a device reached over SSH: its name, its RAM and, while a turn runs, what that turn holds there. */
export interface DeviceInfo {
  name: string;
  ram: Ram | null;
  /** The turn's processes there; null: not read yet, or no numbers (an older turn, Windows, no answer). */
  bytes: number | null;
  /** Being read now, nothing known yet. */
  asking: boolean;
}

/** What the engine knows of a chat's processes. */
export interface MemSource {
  chats: readonly { id: number; title: string; name: string; role: string; parent: number | null; home: string; retired: boolean }[];
  /** A chat's running turn: its runner's pid and the agent's kind. */
  runner(id: number): { pid: number; kind: string } | null;
  /** For its row between turns ("": unknown). */
  kind?(id: number): Kind | "";
  procs: readonly { name: string; lead: number; owner: number; pid: number }[];
  /** The device a chat runs on (null: this PC), with what's known there. `running`: a turn of it runs now. */
  device?(id: number, running: boolean): DeviceInfo | null;
}

/** A turn on a device: its bytes there, or why there are none. */
const deviceNote = (d: DeviceInfo): string => (d.bytes !== null ? "" : d.asking ? `Asking ${d.name}…` : `No numbers from ${d.name}`);

/** A chat's processes: its agent (listed between turns too, idle), its subagents' (for a lead) and the processes started for it. */
export function chatParts(src: MemSource, id: number, t: ProcTable, seen: Set<number> = new Set()): MemPart[] {
  const chat = src.chats.find((c) => c.id === id);
  if (!chat) return [];
  const out: MemPart[] = [];
  const own = src.runner(id);
  const who = chat.role === "lead" ? "Lead" : "Agent";
  const ownBytes = own ? treeBytes(t, [own.pid], seen) : 0;
  const kind = own?.kind ?? src.kind?.(id) ?? "";
  const label = kind === "" ? who : `${who} · ${kind}`;
  const dev = src.device?.(id, own !== null) ?? null;
  // On a device the agent is there: this PC holds only the runner and its ssh, a row of their own.
  const agent: MemPart = dev && own ? { kind: "agent", label, bytes: dev.bytes ?? 0, on: dev.name, ...(dev.bytes === null ? { note: deviceNote(dev) } : {}) } : { kind: "agent", label, bytes: ownBytes };
  if (dev && own && ownBytes > 0) out.push({ kind: "link", label: "SSH link", bytes: ownBytes });
  if (chat.role === "lead") {
    for (const s of src.chats) {
      if (s.parent !== id || s.role !== "sub" || s.retired) continue;
      const r = src.runner(s.id);
      if (!r) continue;
      const here = treeBytes(t, [r.pid], seen);
      const sd = src.device?.(s.id, true) ?? null;
      out.push(sd ? { kind: "sub", label: s.name || s.title, bytes: here + (sd.bytes ?? 0), on: sd.name } : { kind: "sub", label: s.name || s.title, bytes: here });
    }
  }
  for (const p of src.procs) {
    if (p.owner !== id && p.lead !== id) continue;
    // Its process group (npm → node → vite…), and anything it forked into another group.
    out.push({ kind: "proc", label: p.name, bytes: treeBytes(t, [p.pid, ...(t.groups.get(p.pid) ?? [])], seen) });
  }
  const rest = out.filter((p) => p.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  // A lead ends its turn once its subagents are off: it still heads the breakdown, idle.
  if (dev && own) return [agent, ...rest].sort((a, b) => b.bytes - a.bytes);
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
    // What runs on a device is that device's memory, not this PC's.
    const bytes = chatParts(src, c.id, t, seen).reduce((a, p) => a + (p.on === undefined ? p.bytes : 0), 0);
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
  if (chat !== null) {
    const parts = chatParts(src, chat, t);
    // Where it runs, for the popover (said even between turns), and that device's RAM instead of this PC's.
    const d = src.device?.(chat, src.runner(chat) !== null) ?? null;
    const ramJson = (x: Ram | null) => (x === null ? null : { total: x.total, used: x.used, swap_total: x.swapTotal, swap_used: x.swapUsed });
    out.chat = d ? { parts, device: { name: d.name, ram: ramJson(d.ram), asking: d.asking && d.ram === null } } : { parts };
  }
  return out;
}

/** The engine's view of its chats, for the functions above. `device`: what's known of the device a chat runs on (devicemem.ts). */
export function engineSource(
  e: {
    chats: readonly (MemSource["chats"][number] & { account: string; device?: string })[];
    turns: ReadonlyMap<number, { turn: { meta: { pid: number; kind: string } } | null }>;
    procs: MemSource["procs"];
    account(id: string): { kind: Kind } | undefined;
  },
  device?: (chat: { id: number; device: string }, running: boolean) => DeviceInfo | null,
): MemSource {
  return {
    device: (id, running) => {
      const c = e.chats.find((x) => x.id === id);
      return c?.device && device ? device({ id, device: c.device }, running) : null;
    },
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
