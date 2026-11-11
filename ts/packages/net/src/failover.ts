/**
 * When the PC a chat or a project lives on is off, Harbor carries on on another PC of the mesh
 * by itself and says so (no prompt, no setting). What can and can't carry over:
 *
 * - An existing chat's agent session is a file on the PC that is off: it can't resume. Every PC
 *   keeps a full copy of every chat's messages, so the PC that takes it starts a new session with
 *   the conversation so far (engine.ts `handOver`, as a switch of provider does) and the chat is
 *   its own from then on. Work that PC never pushed (uncommitted changes, unpushed commits) isn't
 *   there.
 * - A new chat in a project whose folder is on the PC that is off starts on a PC that has the
 *   project (its checkout of the same Git remote) or can clone it.
 * - None usable: what is sent waits on the PC that got it, and goes out when the chat's PC or
 *   another usable one is back.
 *
 * "Usable": on, sharing chats with this one (it's in the mesh, so in the user's workspace), with a
 * Claude account (only Claude runs a chat on another PC), and the project: its folder already, or
 * a Git remote to clone it from.
 */

/** A PC that could take over: "" is this PC. */
export interface FailoverPc {
  id: string;
  name: string;
  /** Free memory (MB, 10-min average); null: not said. */
  ram: number | null;
  /** It has the project's folder (or the chat has no project). */
  hasProject: boolean;
  /** It can clone the project (it has a Git remote). */
  canClone: boolean;
  /** It runs Claude. */
  claude: boolean;
}

export type FailoverPick = { to: FailoverPc } | { to: null; why: string };

/** Ranks the usable PCs: one with the project's folder, then the most free memory, then the name (every PC picks the same). */
export function pickFailover(cands: readonly FailoverPc[]): FailoverPick {
  const usable = cands.filter((c) => c.claude && (c.hasProject || c.canClone));
  if (usable.length === 0) return { to: null, why: noneWhy(cands) };
  const ram = (c: FailoverPc) => c.ram ?? -1;
  const best = [...usable].sort((a, b) => Number(b.hasProject) - Number(a.hasProject) || ram(b) - ram(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))[0];
  return best ? { to: best } : { to: null, why: noneWhy(cands) };
}

/** Why no PC is usable, in a few words (the candidates are the PCs that are on). */
function noneWhy(cands: readonly FailoverPc[]): string {
  if (cands.length === 0) return "no other PC is on";
  if (!cands.some((c) => c.claude)) return "no PC that's on has a Claude account";
  return "no PC that's on has this project, and it has no Git remote to clone";
}

/** Where a chat goes, by name (also this PC: on a phone, "this PC" would be no PC in particular). */
const toName = (to: FailoverPc): string => to.name;

/** "1 waiting" after the none-usable line, when anything waits. */
const waiting = (held: number): string => (held > 0 ? ` ${held} waiting.` : "");

/** The line over the composer of a chat whose PC is off (the same on the desktop and the phone). */
export function failoverLine(off: string, pick: FailoverPick, held: number): string {
  if (pick.to === null) return `${off} is off and no PC can run this. Messages wait until one is back.${waiting(held)}`;
  return `${off} is off. Next message runs on ${toName(pick.to)}.`;
}

/** The line over a new chat's composer in a project whose folder is on a PC that is off. */
export function failoverDraftLine(off: string, pick: FailoverPick): string {
  if (pick.to === null) return `${off} is off and no PC can run this. Try again when one is back.`;
  return `${off} is off. This chat runs on ${toName(pick.to)}.`;
}

/** The notice a chat gets when it moved: its text and its detail (shown when tapped). */
export function switchedNotice(off: string, to: string, started: boolean): { text: string; detail: string } {
  if (!started) return { text: `${off} is off: started on ${to}`, detail: `${to} has the project.` };
  return { text: `${off} is off: moved to ${to}`, detail: `A new session with the conversation so far. Unpushed work stays on ${off}.` };
}

/** The answer to a message that waits because no PC can run the chat (`why`: the reason, for the log and the detail). */
export function heldNotice(off: string, why: string): string {
  return `${off} is off and no PC can run this (${why}). Messages wait until one is back.`;
}

/** kv: a chat this PC took over from its PC while that was off ({from, name, count}), to settle with it when it's back. */
export const takenKey = (gid: string): string => `failover_took:${gid}`;

/** kv: messages waiting for a usable PC (JSON list of {text, mentions, files}). */
export const heldKey = (gid: string): string => `failover_held:${gid}`;

export interface WaitingMessage {
  text: string;
  files: string[];
  mentions: unknown[];
}

export function parseHeld(v: string | null): WaitingMessage[] {
  if (v === null || v === "") return [];
  try {
    const a: unknown = JSON.parse(v);
    if (!Array.isArray(a)) return [];
    return a
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && typeof (x as { text?: unknown }).text === "string")
      .map((x) => ({ text: x.text as string, files: Array.isArray(x.files) ? x.files.filter((f): f is string => typeof f === "string") : [], mentions: Array.isArray(x.mentions) ? x.mentions : [] }));
  } catch {
    return [];
  }
}
