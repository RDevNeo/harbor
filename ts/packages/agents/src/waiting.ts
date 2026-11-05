/** "Waiting": a chat whose own turn has ended but that something will wake again: a process it
 *  started (start_process) that will report its exit, its subagents (their reports wake the lead),
 *  a wake-up it asked for (snooze), or a key it asked the user for (request_secret). It ends when
 *  none is left, or when a turn starts (working comes first). */

/** What a chat waits on; null from `waitingOf` when it waits on nothing. */
export interface Waiting {
  /** Processes that will wake it when they exit (one that serves a URL is serving, not awaited). */
  procs: number;
  /** Its subagents running or with work queued (a lead's). */
  subs: number;
  /** The next wake-up it asked for (unix seconds), null for none. */
  wake: number | null;
  /** Keys it asked the user for, still unanswered. */
  keys: number;
}

/** The parts of the engine `waitingOf` reads. */
export interface WaitSource {
  chats: readonly { id: number; role: string; parent: number | null; retired: boolean }[];
  procs: readonly { lead: number; owner: number; url: string | null }[];
  timers: readonly { chatId: number; at: number }[];
  pending: ReadonlyMap<number, readonly string[]>;
  /** Its turn runs (here, or at its home PC for a copy). */
  live(id: number): boolean;
}

/** The chat a process's exit wakes: whoever started it, or its lead once that agent is retired (engine `onProcEvent`). */
export function procWakes(s: WaitSource, p: { lead: number; owner: number }): number {
  const o = s.chats.find((c) => c.id === p.owner);
  if (!o) return p.lead;
  return o.retired && o.parent !== null ? o.parent : o.id;
}

/** What chat `id` waits on (a lead: its subagents' waits too, as their reports come back to it); null for nothing.
 *  `asks`: the secret cards waiting for the user (kv `secret_asks`), read once by the caller. */
export function waitingOf(s: WaitSource, id: number, asks: readonly { chat: number }[] = []): Waiting | null {
  const me = s.chats.find((c) => c.id === id);
  if (!me || me.retired) return null;
  const subs = me.role === "lead" ? s.chats.filter((c) => c.role === "sub" && c.parent === id && !c.retired) : [];
  const team = new Set([id, ...subs.map((c) => c.id)]);
  const procs = s.procs.filter((p) => p.url === null && team.has(procWakes(s, p))).length;
  const busy = subs.filter((c) => s.live(c.id) || (s.pending.get(c.id)?.length ?? 0) > 0).length;
  const wakes = s.timers.filter((t) => team.has(t.chatId)).map((t) => t.at);
  const keys = asks.filter((a) => team.has(a.chat)).length;
  const w: Waiting = { procs, subs: busy, wake: wakes.length === 0 ? null : Math.min(...wakes), keys };
  return procs === 0 && busy === 0 && w.wake === null && keys === 0 ? null : w;
}

/** The local zone's UTC offset in seconds at `at` (unix seconds). */
export function utcOffset(at: number = Date.now() / 1000): number {
  return -new Date(at * 1000).getTimezoneOffset() * 60;
}

/** A copy's `wait` as its home PC sent it (statusbars.ts `waitJson`), null when it's none or unreadable. */
export function fromJson(v: unknown): Waiting | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const n = (k: string): number => (typeof o[k] === "number" && Number.isFinite(o[k]) ? Math.max(0, Math.floor(o[k] as number)) : 0);
  const wake = typeof o.wake_ms === "number" && Number.isFinite(o.wake_ms) ? Math.floor(o.wake_ms / 1000) : null;
  const w: Waiting = { procs: n("procs"), subs: n("subs"), wake, keys: n("keys") };
  return w.procs === 0 && w.subs === 0 && w.wake === null && w.keys === 0 ? null : w;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`);

/** "14:30" for a wake-up today, "Thu 14:30" within the week, else "12 Nov 14:30"; `off`: the local zone's UTC offset in seconds. */
export function wakeTime(at: number, now: number, off: number): string {
  const d = new Date((at + off) * 1000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const day = (t: number): number => Math.floor((t + off) / 86400);
  const ahead = day(at) - day(now);
  if (ahead <= 0) return hm;
  if (ahead < 7) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${hm}`;
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${hm}`;
}

/** What it waits for, most telling first: "2 processes", "subagent", "wake 14:30", "key". */
export function waitParts(w: Waiting, now: number, off: number): string[] {
  const out: string[] = [];
  if (w.subs > 0) out.push(plural(w.subs, "subagent", "subagents"));
  if (w.procs > 0) out.push(plural(w.procs, "process", "processes"));
  if (w.wake !== null) out.push(`wake ${wakeTime(w.wake, now, off)}`);
  if (w.keys > 0) out.push(plural(w.keys, "key", "keys"));
  return out;
}

/** The status line's words: "Waiting · 2 processes · wake 14:30". */
export function waitText(w: Waiting, now: number, off: number): string {
  return ["Waiting", ...waitParts(w, now, off)].join(" · ");
}

/** For the agents' own tools (list_chats, list_agents): "waiting on 2 processes, wake 14:30". */
export function waitWords(w: Waiting, now: number, off: number): string {
  return `waiting on ${waitParts(w, now, off).join(", ")}`;
}
