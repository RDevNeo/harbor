// Chats deleted on a PC that had taken them over from a PC that was off (failover.ts `takeHere`, `adopt`). The PC the
// chat came from still has it as its own; it hears of the delete when it's back (the mesh's chat list and the
// workspace cloud carry these), and deletes its own too, unless someone wrote in it there since (then it stays, as a
// chat of its own). Kept for DROPPED_KEEP_MS.

/** kv: a chat this PC took over from its PC while that was off ({from, name, count}), to settle with it when it's back. */
export const takenKey = (gid: string): string => `failover_took:${gid}`;

/** kv: this PC's deletes of chats it had taken over (JSON list of `Dropped`). */
export const DROPPED_KEY = "dropped_chats";

/** How long a delete is told to the chat's old PC (it may stay off for weeks: a dual boot's other system). */
export const DROPPED_KEEP_MS = 90 * 86_400_000;

export interface Dropped {
  gid: string;
  /** The mesh id of the PC the chat was taken over from. */
  from: string;
  /** How many items it had when taken over: the old PC deletes its own only when nobody wrote in it there after these. */
  count: number;
  /** When it was deleted (ms). */
  at: number;
}

export function parseDropped(v: unknown): Dropped[] {
  let a: unknown = v;
  if (typeof v === "string") {
    try {
      a = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(a)) return [];
  const out: Dropped[] = [];
  for (const x of a) {
    if (typeof x !== "object" || x === null) continue;
    const o = x as Record<string, unknown>;
    if (typeof o.gid !== "string" || o.gid === "" || typeof o.from !== "string" || o.from === "") continue;
    out.push({ gid: o.gid, from: o.from, count: typeof o.count === "number" && o.count >= 0 ? Math.floor(o.count) : 0, at: typeof o.at === "number" ? o.at : 0 });
  }
  return out;
}

/** The list with `d` added (one per gid) and those older than DROPPED_KEEP_MS gone. */
export function withDropped(list: readonly Dropped[], d: Dropped | null, nowMs: number): Dropped[] {
  const keep = list.filter((x) => nowMs - x.at < DROPPED_KEEP_MS && x.gid !== d?.gid);
  return d === null ? keep : [...keep, d];
}
