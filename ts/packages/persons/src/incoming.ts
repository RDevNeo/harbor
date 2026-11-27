// A person's new messages, as Hub's phone notifications want them (kind "person", ts/packages/net/src/notify.ts):
// only what they just wrote. Not what the user sent, not history (a page loaded, a backfill, a sync after a
// restart), not an edit or a tick moving on a message already there, not what was already read in the app.
import { preview } from "./model/conversation.ts";
import type { Conversation, Message } from "./model/types.ts";

/** A message older than this when it reaches Hub is history, not news (ms). */
export const FRESH_MS = 10 * 60_000;

/** One incoming message as the note carries it. */
export interface IncomingLine {
  id: string;
  text: string;
  /** Unix seconds. */
  at: number;
}

/** The messages of a connection's "messages" event that are news: from them, not in the chat before (`before`), not
 *  announced already (`announced`, ids), written within FRESH_MS of `now`, and newer than the chat's read mark. */
export function freshIncoming(before: Conversation | undefined, msgs: readonly Message[], now: number, announced: ReadonlySet<string>, seen?: string): IncomingLine[] {
  const had = new Set((before?.messages ?? []).map((m) => m.id));
  const seenAt = seen ? Date.parse(seen) : NaN;
  const out: IncomingLine[] = [];
  for (const m of msgs) {
    if (m.fromMe || had.has(m.id) || announced.has(m.id)) continue;
    const t = Date.parse(m.timestamp);
    if (!Number.isFinite(t) || now - t > FRESH_MS || t - now > FRESH_MS) continue;
    if (Number.isFinite(seenAt) && t <= seenAt) continue;
    const text = (m.subject && m.threadId ? `${m.subject}: ` : "") + preview(m);
    out.push({ id: m.id, text: text.trim() === "" ? "Message" : text, at: Math.floor(t / 1000) });
  }
  return out.sort((a, b) => a.at - b.at);
}
