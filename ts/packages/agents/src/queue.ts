import type { Item, Mention, SentVia } from "@harbor/store";
import { now } from "./paths.ts";

/** What a follow-up does while the agent works. */
export type Mode = "queue" | "steer";

export function parseMode(s: string): Mode | null {
  return s === "queue" || s === "steer" ? s : null;
}

export function opposite(m: Mode): Mode {
  return m === "queue" ? "steer" : "queue";
}
export const STEER = "steer";
export const PROMOTED = "promoted";
export const NOT_LANDED = "Steer didn't land: queued";

/** Empty while it waits in the queue. */
export type Intent = "" | typeof STEER | typeof PROMOTED;
export type Note = "" | typeof NOT_LANDED;

export interface Queued {
  /** The API's `queue/{id}`. */
  id: number;
  text: string;
  files: string[];
  mentions: Mention[];
  /** Written into the running turn, waiting for Claude to take it in. */
  written: boolean;
  /** Where it was written, when not on this PC (`Item::User::sender`). */
  sender: string;
  device: string;
  /** Who wrote it there and on what (`Item::User::who`, `via`). */
  who?: string;
  via?: SentVia;
  intent: Intent;
  note: Note;
  /** The device editing it in its composer; empty when nobody is. */
  editing: string;
}

/** Where a message was written, for the agent (which otherwise takes the user to be at this PC). */
export function sentFrom(sender: string, device: string, back: boolean, hostname = "this PC"): string {
  if (sender === "") return back ? `[The user sent this from '${hostname}', the PC running Harbor.]\n\n` : "";
  return device.startsWith("tok:")
    ? `[The user sent this from the Harbor app on their phone ('${sender}'), not from this PC.]\n\n`
    : `[The user sent this from Harbor on '${sender}', another PC, not from this one.]\n\n`;
}

/** What the agent gets for a queued message: mentioned messages quoted first, then the text as `said`. */
export function queuedPrompt(q: Queued, said: string, mentions: string): string {
  const from = sentFrom(q.sender, q.device, false);
  // A slash command only runs at the start: where it came from follows it.
  if (said.startsWith("/") && from !== "") return `${mentions}${said}\n\n${from.trimEnd()}`;
  return `${from}${mentions}${said}`;
}

export function queuedItem(q: Queued): Item {
  return withWho({ kind: "user", text: q.text, files: [...q.files], at: now(), mentions: q.mentions, sender: q.sender, intent: q.intent }, q.who, q.via);
}

/** A user item with who wrote it and on what, set only when known (old items and this PC's leave them out). */
export function withWho(it: Item, who: string | undefined, via: SentVia | undefined): Item {
  if (it.kind !== "user" || it.sender === "") return it;
  if (who) it.who = who;
  if (via) it.via = via;
  return it;
}

export const steering = (q: Queued): boolean => q.intent !== "";

/** The follow-up queues of every chat, and which ones a Stop holds. */
export class QueueState {
  chats = new Map<number, Queued[]>();
  held = new Set<number>();
  next = 0;

  id(): number {
    return ++this.next;
  }

  list(chat: number): Queued[] {
    let l = this.chats.get(chat);
    if (!l) this.chats.set(chat, (l = []));
    return l;
  }

  queued(chat: number): readonly Queued[] {
    return this.chats.get(chat) ?? [];
  }

  find(chat: number, id: number): Queued | undefined {
    return this.chats.get(chat)?.find((q) => q.id === id && !steering(q));
  }

  tidy(chat: number): void {
    if (this.chats.get(chat)?.length === 0) {
      this.chats.delete(chat);
      this.held.delete(chat);
    }
  }

  /** Moves queued message `id` to position `to` among the waiting ones (steers and written ones stay put). */
  moveTo(chat: number, id: number, to: number): boolean {
    const list = this.chats.get(chat);
    if (!list) return false;
    const from = list.findIndex((q) => q.id === id && !steering(q) && !q.written);
    if (from < 0) return false;
    const [m] = list.splice(from, 1) as [Queued];
    const slots = list.flatMap((q, i) => (!steering(q) && !q.written ? [i] : []));
    const slot = slots[to];
    const at = slot !== undefined ? slot : slots.length > 0 ? (slots[slots.length - 1] as number) + 1 : list.length;
    list.splice(at, 0, m);
    return true;
  }

  /** The queues, for the next process after a reload. */
  snapshot(): unknown {
    const chats: Record<string, unknown[]> = {};
    for (const [k, v] of this.chats) chats[String(k)] = v.map(queuedJson);
    return { chats, held: [...this.held].sort((a, b) => a - b) };
  }

  /** Also takes the bare chats map, whose messages may have no ids. */
  restore(v: unknown): void {
    const o = (v ?? {}) as Record<string, unknown>;
    const chats = (o.chats !== undefined ? o.chats : o) as Record<string, unknown>;
    const held = o.chats !== undefined ? o.held : null;
    this.chats.clear();
    for (const [k, list] of Object.entries(chats ?? {})) {
      if (!/^-?\d+$/.test(k) || !Array.isArray(list)) continue;
      this.chats.set(Number(k), list.map(queuedFrom).filter((q): q is Queued => q !== null));
    }
    this.held = new Set(Array.isArray(held) ? held.filter((x): x is number => typeof x === "number") : []);
    this.next = Math.max(0, ...[...this.chats.values()].flat().map((q) => q.id));
    for (const q of [...this.chats.values()].flat()) {
      q.editing = "";
      if (q.id === 0) q.id = ++this.next;
    }
  }
}

/** serde's form of a queued message: optional strings left out when empty. */
function queuedJson(q: Queued): Record<string, unknown> {
  const v: Record<string, unknown> = { id: q.id, text: q.text, files: q.files, mentions: q.mentions, written: q.written, sender: q.sender, device: q.device };
  if (q.intent !== "") v.intent = q.intent;
  if (q.note !== "") v.note = q.note;
  if (q.editing !== "") v.editing = q.editing;
  if (q.who) v.who = q.who;
  if (q.via) v.via = q.via;
  return v;
}

function queuedFrom(v: unknown): Queued | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.text !== "string" || !Array.isArray(o.files) || !Array.isArray(o.mentions) || typeof o.written !== "boolean") return null;
  const s = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const q: Queued = {
    id: typeof o.id === "number" ? o.id : 0,
    text: o.text,
    files: o.files.filter((f): f is string => typeof f === "string"),
    mentions: o.mentions as Mention[],
    written: o.written,
    sender: s("sender"),
    device: s("device"),
    intent: s("intent") === STEER ? STEER : s("intent") === PROMOTED ? PROMOTED : "",
    note: s("note") === NOT_LANDED ? NOT_LANDED : "",
    editing: s("editing"),
  };
  if (s("who") !== "") q.who = s("who");
  if (o.via === "phone" || o.via === "pc") q.via = o.via;
  return q;
}

