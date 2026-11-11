// Memory: the chat top bar's pill and its popover, and the sidebar gauge's PCs, from `GET /mesh/v1/memory`'s shape.
import { ICONS } from "../icons.ts";

export interface Ram {
  total: number;
  used: number;
  swapTotal: number;
  swapUsed: number;
}

export interface MemPart {
  kind: string;
  label: string;
  bytes: number;
  idle?: boolean;
  /** Runs on this SSH device, not on the PC. */
  on?: string;
  /** Said instead of its bytes. */
  note?: string;
}

/** The SSH device a chat runs on (Runs on), and its RAM. */
export interface MemDevice {
  name: string;
  ram: Ram | null;
  /** Its RAM is being read. */
  asking: boolean;
}

export interface Mem {
  ram: Ram | null;
  /** Chats holding memory. */
  running: number;
  top: { title: string; bytes: number }[];
  /** The chat's parts when one was asked for. */
  parts: MemPart[] | null;
  /** The chat runs on an SSH device: the popover's RAM is that device's. */
  device?: MemDevice | null;
}

/** A popover row, as the window's `PopItem`. */
export interface MemRow {
  kind: "label" | "separator" | "item" | "usage-account" | "usage-note" | "mem-row" | "mem-ram" | "mem-warn" | "mem-pc";
  icon: string;
  label: string;
  desc: string;
  checked: boolean;
  enabled: boolean;
  badge: string;
  value: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The route's JSON; null when it isn't one (an older Harbor's 404, say). */
export function parseMem(v: unknown): Mem | null {
  const o = rec(v);
  if (!o || !("ram" in o)) return null;
  const ram = ramOf(o.ram);
  const top = Array.isArray(o.top) ? o.top.flatMap((t) => (rec(t) ? [{ title: String(rec(t)?.title ?? ""), bytes: num(rec(t)?.bytes) }] : [])) : [];
  const c = rec(o.chat);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const parts = c && Array.isArray(c.parts)
    ? c.parts.flatMap((v) => {
        const p = rec(v);
        if (!p) return [];
        const on = str(p.on);
        const note = str(p.note);
        return [{ kind: String(p.kind ?? ""), label: String(p.label ?? ""), bytes: num(p.bytes), ...(p.idle === true ? { idle: true } : {}), ...(on !== "" ? { on } : {}), ...(note !== "" ? { note } : {}) }];
      })
    : null;
  const d = rec(c?.device);
  const device = d && str(d.name) !== "" ? { name: str(d.name), ram: ramOf(d.ram), asking: d.asking === true } : null;
  return { ram, running: num(o.running), top, parts, ...(device ? { device } : {}) };
}

function ramOf(v: unknown): Ram | null {
  const r = rec(v);
  return r && num(r.total) > 0 ? { total: num(r.total), used: num(r.used), swapTotal: num(r.swap_total), swapUsed: num(r.swap_used) } : null;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** "0 MB", "412 MB", "1.2 GB", "16 GB". */
export function bytesText(b: number): string {
  if (b <= 0) return "0 MB";
  if (b >= GB) {
    const g = b / GB;
    return `${g >= 10 ? Math.round(g) : Math.round(g * 10) / 10} GB`;
  }
  return `${Math.max(1, Math.round(b / MB))} MB`;
}

/** "9.8 GB" of RAM used, the sidebar gauge's figure. */
export function usedText(r: Ram): string {
  const g = r.used / GB;
  return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB`;
}

export const ramFrac = (r: Ram): number => (r.total > 0 ? Math.min(1, r.used / r.total) : 0);

/** "9.8 of 15.5 GB  ·  63%". */
export function ramText(r: Ram): string {
  const g = (b: number) => Math.round((b / GB) * 10) / 10;
  return `${g(r.used)} of ${g(r.total)} GB  ·  ${Math.round(ramFrac(r) * 100)}%`;
}

export function low(r: Ram): boolean {
  const f = ramFrac(r);
  return f >= 0.9 || (f >= 0.8 && r.swapUsed >= 512 * MB);
}

function lowNote(r: Ram): string {
  return r.swapUsed >= 64 * MB ? `Low on memory: ${bytesText(r.swapUsed)} in swap.` : "Low on memory.";
}

const row = (kind: MemRow["kind"], label = "", extra: Partial<MemRow> = {}): MemRow => ({ kind, icon: "", label, desc: "", checked: false, enabled: false, badge: "", value: 0, ...extra });

export const partsTotal = (parts: readonly MemPart[]): number => parts.reduce((a, p) => a + p.bytes, 0);

/**
 * The pill's popover: the chat's total and where it runs, each process, then that PC's RAM. A chat whose Runs on is an
 * SSH device runs "on <device>": its agent's row is what it holds there, the PC's end of it is the SSH link's
 * row, and the RAM is the device's.
 */
export function chatRows(mem: Mem, pc: string): MemRow[] {
  const parts = mem.parts ?? [];
  const total = partsTotal(parts);
  const dev = mem.device ?? null;
  // The PC it's started from shows on the SSH link's row: the header has room for one name.
  const where = dev ? `on ${dev.name}` : pc === "" ? "" : `on ${pc}`;
  const out = [row("usage-account", "This chat", { badge: bytesText(total), desc: where })];
  if (parts.length === 0) out.push(row("usage-note", "Nothing of this chat is running now."));
  for (const p of parts) {
    const icon = p.kind === "proc" ? ICONS.TERMINAL : p.kind === "link" ? ICONS.LINK : ICONS.BOT;
    const label = p.kind === "link" && pc !== "" ? `${p.label} on ${pc}` : p.label;
    const desc = p.idle ? "Idle" : p.note !== undefined && p.note !== "" ? p.note : bytesText(p.bytes);
    out.push(row("mem-row", label, { icon, badge: p.kind === "sub" ? "subagent" : p.kind === "proc" ? "process" : "", desc, value: total > 0 ? p.bytes / total : 0 }));
  }
  if (dev) {
    out.push(row("separator"), ...(dev.ram ? ramRows(dev.ram, dev.name) : [row("usage-note", dev.asking ? `Asking ${dev.name} for its memory…` : `No memory figures from ${dev.name} now.`)]));
  } else if (mem.ram) {
    out.push(row("separator"), ...ramRows(mem.ram, pc === "" ? "This PC" : pc));
  }
  return out;
}

function ramRows(r: Ram, label: string): MemRow[] {
  const isLow = low(r);
  const out = [row("mem-ram", label, { desc: ramText(r), value: ramFrac(r), checked: isLow })];
  if (isLow) out.push(row("mem-warn", lowNote(r)));
  return out;
}


export interface PcMem {
  name: string;
  online: boolean;
  /** Null: off, or a Harbor too old to say. */
  mem: Mem | null;
  /** Still being asked. */
  asking?: boolean;
  /** A Runs on device reached over SSH, not a Harbor PC: its RAM, and this PC's chats running there. */
  ssh?: boolean;
  /** Why there are no numbers, said instead of the older-Harbor note. */
  note?: string;
}

/** A PC's card in the gauge's popover and the submenu beside it. `pc` names it for the sidebar's choice ("" = this PC). */
export interface PcCard {
  pc: string;
  sub: MemRow[];
}

/**
 * The gauge's popover: this PC first, then every other PC, each one card of one height ("mem-pc": `label` the name, `badge`
 * "This PC"/"SSH", `desc` its chats running or "Off", `icon` the RAM figures or why there are none, `value` the RAM used
 * or -1 for no meter, `checked` low on memory, `enabled` the PC the sidebar's gauge shows: its "Default" pill). `cards[i]` is
 * row i's PC and submenu: the swap line when low, then the chats holding the most or why there are none.
 */
export function deviceRows(here: PcMem, others: readonly PcMem[], sidebar = "", topN = 5): { rows: MemRow[]; cards: (PcCard | null)[] } {
  const rows = [row("label", "Memory")];
  const cards: (PcCard | null)[] = [null];
  const add = (r: MemRow, c: PcCard | null = null) => {
    rows.push(r);
    cards.push(c);
  };
  const pc = (p: PcMem, me: boolean) => {
    const key = me ? "" : p.name;
    const r = p.online ? (p.mem?.ram ?? null) : null;
    const isLow = r ? low(r) : false;
    const note = !p.online ? "Off: no numbers now." : !p.mem ? (p.asking ? "Asking…" : p.note || "No numbers: its Harbor is older.") : !r ? "No RAM figures." : "";
    const n = p.mem?.running ?? 0;
    const desc = !p.online ? "Off" : !p.mem ? "" : n === 0 ? "No chats" : n === 1 ? "1 chat" : `${n} chats`;
    add(row("mem-pc", p.name, { badge: me ? "This PC" : p.ssh ? "SSH" : "", desc, icon: r ? ramText(r) : note, value: r ? ramFrac(r) : -1, checked: isLow, enabled: key === sidebar }), { pc: key, sub: pcSub(p, r, isLow, note, topN) });
  };
  pc(here, true);
  for (const p of others) {
    add(row("separator"));
    pc(p, false);
  }
  return { rows, cards };
}

function pcSub(p: PcMem, r: Ram | null, isLow: boolean, note: string, topN: number): MemRow[] {
  const out: MemRow[] = [];
  if (r && isLow) out.push(row("mem-warn", lowNote(r)));
  if (note !== "" && (!p.mem || !p.online)) out.push(row("usage-note", note));
  else if (p.mem) {
    const top = p.mem.top.slice(0, topN);
    const sum = top.reduce((a, t) => a + t.bytes, 0);
    if (top.length === 0) out.push(row("usage-note", "Nothing running"));
    for (const t of top) out.push(row("mem-row", t.title, { icon: ICONS.MESSAGE, desc: bytesText(t.bytes), value: sum > 0 ? t.bytes / sum : 0 }));
  }
  return out;
}

/** The sidebar's gauge: the PC picked for it (`pick`, "" = this PC) when it answered with RAM figures, else this PC's. */
export function gauge(hereName: string, here: Ram | null, pick: string, peers: readonly PcMem[] | null): { pc: string; frac: number; low: boolean; tip: string } {
  const there = pick === "" ? null : (peers?.find((p) => p.name === pick) ?? null);
  const r2 = there?.online ? (there.mem?.ram ?? null) : null;
  const [name, r] = r2 ? [pick, r2] : [hereName || "this PC", here];
  if (!r) return { pc: "", frac: 0, low: false, tip: "" };
  const why = pick === "" || r2 || peers === null ? "" : there === null ? `. ${pick} isn't in your PCs now` : !there.online ? `. ${pick} is off` : `. No numbers from ${pick}`;
  return { pc: usedText(r), frac: ramFrac(r), low: low(r), tip: `Memory on ${name}: ${ramText(r)}${low(r) ? ". Low on memory" : ""}${why}` };
}
