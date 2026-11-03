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
}

export interface Mem {
  ram: Ram | null;
  /** Chats holding memory. */
  running: number;
  top: { title: string; bytes: number }[];
  /** The chat's parts when one was asked for. */
  parts: MemPart[] | null;
}

/** A popover row, as the window's `PopItem`. */
export interface MemRow {
  kind: "label" | "separator" | "usage-account" | "usage-note" | "mem-row" | "mem-ram" | "mem-warn";
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
  const r = rec(o.ram);
  const ram = r && num(r.total) > 0 ? { total: num(r.total), used: num(r.used), swapTotal: num(r.swap_total), swapUsed: num(r.swap_used) } : null;
  const top = Array.isArray(o.top) ? o.top.flatMap((t) => (rec(t) ? [{ title: String(rec(t)?.title ?? ""), bytes: num(rec(t)?.bytes) }] : [])) : [];
  const c = rec(o.chat);
  const parts = c && Array.isArray(c.parts) ? c.parts.flatMap((p) => (rec(p) ? [{ kind: String(rec(p)?.kind ?? ""), label: String(rec(p)?.label ?? ""), bytes: num(rec(p)?.bytes) }] : [])) : null;
  return { ram, running: num(o.running), top, parts };
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** "412 MB", "1.2 GB", "16 GB". */
export function bytesText(b: number): string {
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

/** The pill's popover: the chat's total and where it runs, each process, then that PC's RAM. */
export function chatRows(mem: Mem, pc: string): MemRow[] {
  const parts = mem.parts ?? [];
  const total = partsTotal(parts);
  const out = [row("usage-account", "This chat", { badge: bytesText(total), desc: pc === "" ? "" : `on ${pc}` })];
  if (parts.length === 0) out.push(row("usage-note", "Nothing of this chat is running now."));
  for (const p of parts) {
    const icon = p.kind === "proc" ? ICONS.TERMINAL : ICONS.BOT;
    out.push(row("mem-row", p.label, { icon, badge: p.kind === "sub" ? "subagent" : p.kind === "proc" ? "process" : "", desc: bytesText(p.bytes), value: total > 0 ? p.bytes / total : 0 }));
  }
  if (mem.ram) {
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

const runningText = (n: number): string => (n === 0 ? "Nothing running" : n === 1 ? "1 chat running" : `${n} chats running`);

export interface PcMem {
  name: string;
  online: boolean;
  /** Null: off, or a Harbor too old to say. */
  mem: Mem | null;
  /** Still being asked. */
  asking?: boolean;
}

/** The gauge's popover: this PC first, then every other PC with its RAM and the chats holding the most. */
export function deviceRows(here: PcMem, others: readonly PcMem[], topN = 3): MemRow[] {
  const out = [row("label", "Memory")];
  const pc = (p: PcMem, me: boolean) => {
    const desc = !p.online ? "Off" : p.mem ? runningText(p.mem.running) : "";
    out.push(row("usage-account", p.name, { badge: me ? "This PC" : "", desc }));
    if (!p.online) return;
    if (!p.mem) {
      out.push(row("usage-note", p.asking ? "Asking…" : "No numbers: its Harbor is older."));
      return;
    }
    if (p.mem.ram) out.push(...ramRows(p.mem.ram, "RAM"));
    const top = p.mem.top.slice(0, topN);
    const sum = top.reduce((a, t) => a + t.bytes, 0);
    for (const t of top) out.push(row("mem-row", t.title, { icon: ICONS.MESSAGE, desc: bytesText(t.bytes), value: sum > 0 ? t.bytes / sum : 0 }));
  };
  pc(here, true);
  for (const p of others) {
    out.push(row("separator"));
    pc(p, false);
  }
  return out;
}
