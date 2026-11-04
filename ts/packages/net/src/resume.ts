/** Resume: what an empty composer's send (the button or Enter) does in an idle chat, the same on the desktop and the
 * phone (the phone's `/send` with `resume: true` asks its chat's home PC for it). */

/** The message Resume sends when nothing is queued: the agent goes on. */
export const RESUME_TEXT = "Resume from where you left off: continue what you were saying or doing.";

/** What the send button's Resume does in an empty composer (no text but spaces, no files, no mentions) of an idle chat:
 * start the queue a stop held, or ask the agent to go on in a chat with a transcript; null: it stays Send. */
export function resumeKind(s: { empty: boolean; running: boolean; editing: boolean; held: boolean; transcript: boolean }): "queue" | "reply" | null {
  if (!s.empty || s.running || s.editing) return null;
  return s.held ? "queue" : s.transcript ? "reply" : null;
}

/** The engine as far as Resume needs it. */
export interface ResumeEngine {
  running(id: number): boolean;
  held(id: number): boolean;
  queued(id: number): readonly unknown[];
  transcript(id: number): { items: readonly unknown[] };
}

/** What Resume does now in chat `id` (on its home PC), with an empty composer nobody is editing a queued message in. */
export function resumeNow(e: ResumeEngine, id: number): "queue" | "reply" | null {
  return resumeKind({ empty: true, running: e.running(id), editing: false, held: e.held(id) && e.queued(id).length > 0, transcript: e.transcript(id).items.length > 0 });
}
