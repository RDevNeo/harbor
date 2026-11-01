import type { IconName } from "../icons.ts";
import { ago } from "./app.ts";
import { parseInt64 } from "./item.ts";
import { when } from "./limits.ts";
import { localHm, until } from "./team.ts";
import { minutes } from "./widgets.ts";

/** Agents idle this long settle on their own, in seconds. */
export const SETTLE_AFTER = 30 * 60;

/** The fields of a store `Chat` the panel reads. */
export interface TeamChat {
  id: number;
  repoId: number | null;
  role: "lead" | "sub" | "chat";
  title: string;
  name: string;
  updated: number;
}

/** Settle and Unsettle decisions per agent: id → [settled, when]. */
export type Marks = Map<number, [boolean, number]>;

/** The marks as kv `agent_settle` keeps them (`{"12": [true, 1793197200]}`); anything unreadable is none. */
export function loadMarks(json: string | null): Marks {
  const out: Marks = new Map();
  if (json === null) return out;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return out;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries<unknown>(v as Record<string, unknown>)) {
    const id = parseInt64(k);
    if (id === null || !Array.isArray(x)) continue;
    const pair: readonly unknown[] = x;
    const [settled, at] = pair;
    if (pair.length === 2 && typeof settled === "boolean" && typeof at === "number" && Number.isInteger(at)) out.set(id, [settled, at]);
  }
  return out;
}

/** The marks as kv `agent_settle` stores them. */
export function saveMarks(marks: Marks): string {
  return JSON.stringify(Object.fromEntries([...marks].map(([k, v]) => [String(k), v])));
}

/** `marks` with agent `id` settled (or unsettled) now, agents that no longer exist (`exists`) forgotten. */
export function mark(marks: Marks, id: number, settled: boolean, now: number, exists: (id: number) => boolean): Marks {
  const out: Marks = new Map(marks);
  out.set(id, [settled, now]);
  for (const k of [...out.keys()]) if (!exists(k)) out.delete(k);
  return out;
}

/** A Settle or Unsettle holds until the agent works again; without one (or after new work) an agent settles once idle for `SETTLE_AFTER`. An Unsettle lasts as long again. */
export function markedSettled(marks: Marks, c: Pick<TeamChat, "id" | "updated">, now: number): boolean {
  const m = marks.get(c.id);
  if (m && c.updated <= m[1]) return m[0] ? true : now - m[1] > SETTLE_AFTER;
  return now - c.updated > SETTLE_AFTER;
}

/** What keeps an agent out of Settled: it runs, has messages waiting, or waits out a limit. */
export interface Busy {
  running: boolean;
  pending: number;
  queued: number;
  paused: boolean;
}

/** Whether an agent sits under Settled (the phone API asks too). */
export function agentSettled(busy: Busy, marks: Marks, c: Pick<TeamChat, "id" | "updated">, now: number): boolean {
  return !busy.running && busy.pending === 0 && busy.queued === 0 && !busy.paused && markedSettled(marks, c, now);
}

/** The lead's agents, running first, then the latest: those still active and those settled. */
export function teamAgents<C extends TeamChat>(subs: readonly C[], running: (id: number) => boolean, settled: (c: C) => boolean): { active: C[]; settled: C[] } {
  const sorted = [...subs].sort((a, b) => Number(!running(a.id)) - Number(!running(b.id)) || b.updated - a.updated);
  return { active: sorted.filter((c) => !settled(c)), settled: sorted.filter(settled) };
}

/** What the Agents section says when none is active; null when some are. */
export function agentsHint(active: number, settled: number): string | null {
  if (active > 0) return null;
  return settled === 0 ? "The lead spawns subagents here as it delegates work." : "No agents working. Earlier ones are under Settled.";
}

/** A section's header: its icon, title, and the count shown after it (null for none). */
export function header(icon: IconName, title: string, n: number): { icon: IconName; title: string; count: string | null } {
  return { icon, title, count: n > 0 ? String(n) : null };
}

/** The banner while a project's automatic turns are paused. */
export const PAUSED_BANNER = { icon: "ALERT", title: "Automatic turns paused", text: "More than 60 in the last hour. Queued events are kept.", action: "Resume", actionIcon: "PLAY" } as const;

/** What Resume starts: each of the project's chats that doesn't run and has messages waiting, with them joined into one turn. */
export function resumeTurns(chats: readonly number[], running: (id: number) => boolean, pending: (id: number) => readonly string[]): [number, string][] {
  return chats.filter((id) => !running(id) && pending(id).length > 0).map((id) => [id, pending(id).join("\n\n---\n\n")]);
}

export const WAKE_UPS_HINT = 'Ask the lead to check back later, e.g. "look at the deploy in 20 minutes".';
export const WEBHOOKS_HINT = "Ask the lead for a webhook to react to GitHub, Vercel, Stripe…";

/** A wake-up's card: its local time and, on hover, how long until it. */
export function wakeUp(at: number, now: number, off: number): { time: string; tip: string } {
  return { time: localHm(at, off), tip: `in ${until(at, now)}` };
}

/** The fields of a webhook the panel reads. */
export interface Hook {
  name: string;
  description: string;
  hits: number;
  lastHit: number;
}

/** A webhook's card: its badge, the URL Copy takes, and its lines. */
export function webhookCard(h: Hook, local: string, publicUrl: string | null, now: number): { badge: "Public" | "Local"; tone: "green" | "gray"; url: string; copyTip: string; calls: string; description: string | null } {
  const url = publicUrl ?? local;
  return {
    badge: publicUrl === null ? "Local" : "Public",
    tone: publicUrl === null ? "gray" : "green",
    url,
    copyTip: `Copy ${url}`,
    calls: `${h.hits} calls${h.lastHit > 0 ? ` · last ${ago(h.lastHit, now)}` : ""}`,
    description: h.description === "" ? null : h.description,
  };
}

/** Whether to offer "Enable public URLs…": webhooks, and no way to reach them from outside yet. */
export function offerPublicUrls(hooks: number, funnel: boolean, publicBase: boolean): boolean {
  return hooks > 0 && !funnel && !publicBase;
}

/** The project's chats from before projects had a single thread. */
export function earlierChats<C extends TeamChat>(chats: readonly C[], project: number): C[] {
  return chats.filter((c) => c.role === "chat" && c.repoId === project);
}

export function earlierChatsLabel(n: number): string {
  return `Earlier chats (${n})`;
}

/** The Settled group's row at the bottom of the panel. */
export function settledHeader(n: number, open: boolean): { label: string; chevron: IconName; tip: string } {
  return { label: `Settled (${n})`, chevron: open ? "DOWN" : "UP", tip: `Agents idle for ${SETTLE_AFTER / 60} min or more` };
}

/** What an agent's card is made of. */
export interface AgentFacts {
  /** Seconds its running turn has run; null when idle. */
  running: number | null;
  /** Messages waiting for it. */
  queued: number;
  /** Waiting out a usage limit: when it lifts (null: unknown). */
  paused: { at: number | null } | null;
  updated: number;
}

/** An agent card's decisions: its status line and colour, border, and which hover controls it has. */
export function agentCard(
  f: AgentFacts,
  settled: boolean,
  hovered: boolean,
  now: number,
  off: number,
): { status: { icon: IconName | null; text: string; color: string }; border: string; fill: string; settle: { icon: IconName; label: string; tip: string } | null; stop: boolean } {
  let status: { icon: IconName | null; text: string; color: string };
  if (f.running !== null) status = { icon: null, text: `working ${minutes(f.running)}`, color: "blue-900" };
  else if (f.paused) status = { icon: "CLOCK", text: `paused · ${f.paused.at === null ? "usage limit" : when(f.paused.at, now, off)}`, color: "amber-900" };
  else if (f.queued > 0) status = { icon: null, text: `${f.queued} queued`, color: "amber-900" };
  else status = { icon: null, text: `idle · ${ago(f.updated, now)}`, color: "subtle" };
  // On hover, Settle / Unsettle takes the status's place (idle agents only).
  const canSettle = hovered && f.running === null && f.paused === null;
  return {
    status,
    border: f.running !== null ? "blue-600" : "border",
    fill: hovered ? "gray-100" : "bg100",
    settle: canSettle ? (settled ? { icon: "UNARCHIVE", label: "Unsettle", tip: "Back to the active agents" } : { icon: "CHECK", label: "Settle", tip: "Move to Settled" }) : null,
    stop: hovered && f.running !== null,
  };
}

/** A running process's card: the output toggle's icon, whether it opens in the browser, and its output. */
export function procCard(open: boolean, url: string | null, tail: string): { chevron: IconName; browser: boolean; output: string } {
  return { chevron: open ? "UP" : "DOWN", browser: url !== null, output: tail === "" ? "(no output yet)" : tail };
}
