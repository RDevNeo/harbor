import type { Mention } from "./mentions.ts";
import { replace } from "./slash.ts";
import { MAX_ROWS, textScore } from "./tags.ts";
import { charCount, charList, isSpace, lines, takeChars } from "./text.ts";
import { label } from "./usertext.ts";

/** Most of a mentioned chat sent to the agent, in characters (about 8 KB). */
export const MAX_CHARS = 8000;
/** Its last turns sent: user prompts and final answers. */
export const TURNS = 6;

const LINK_SCHEME = "harbor://chat/";

/** The `$word` being typed: where it is (in chars) and what follows the `$` up to the cursor. */
export interface Word {
  start: number;
  end: number;
  query: string;
}

/** The `$word` at char `cursor` of `text`, if the cursor is in one: `$` at the start of a word (after a space or an opening bracket). `$$` and `$5` (money) are not. */
export function word(text: string, cursor: number): Word | null {
  const cs = charList(text);
  const cur = Math.min(cursor, cs.length);
  let start = 0;
  for (let i = cur - 1; i >= 0; i--) {
    if (isSpace(cs[i])) {
      start = i + 1;
      break;
    }
  }
  while (start < cur && "([{\"'`".includes(cs[start] ?? "")) start++;
  if (cs[start] !== "$" || start === cur) return null;
  const query = cs.slice(start + 1, cur).join("");
  if (/^[$0-9]/.test(query)) return null;
  let end = cs.length;
  for (let i = cur; i < cs.length; i++) {
    if (isSpace(cs[i])) {
      end = i;
      break;
    }
  }
  return { start, end, query };
}


/** A chat the menu can offer. */
export interface Cand {
  gid: string;
  title: string;
  project: string;
  /** The PC it runs on. */
  pc: string;
  status: "working" | "idle" | "settled";
  updated: number;
  /** In the composer's project. */
  here: boolean;
  settled: boolean;
}

/** "harbor · desk · working": where it is and how it is, under its title. */
export function candLine(c: Cand): string {
  return [c.project, c.pc].filter((x) => x !== "").concat(c.status).join(" · ");
}

export function chatLink(gid: string): string {
  return `${LINK_SCHEME}${gid}`;
}

/** A row as the phone gets it. */
export function candJson(c: Cand): Record<string, string | number> {
  return {
    kind: "chat", insert: "", chat: c.gid, title: c.title, project: c.project, pc: c.pc, status: c.status, updated: c.updated, line: candLine(c),
    label: label(c.title),
  };
}

/** What it becomes in the composer: a mention, its context filled when sent. */
export function candMention(c: Cand): Mention {
  return { item: 0, from: candLine(c), at: 0, text: "", len: 0, excerpt: false, note: "", kind: "chat", chat: c.gid, title: c.title };
}

// How well `q` matches a chat (lower is better): its title, then its project, PC, status.
function score(c: Cand, q: string): number | null {
  const v = [textScore(c.title, q), add(textScore(c.project, q), 5), add(textScore(c.pc, q), 8), add(textScore(c.status, q), 40)].filter((s): s is number => s !== null);
  return v.length === 0 ? null : Math.min(...v);
}

function add(s: number | null, n: number): number | null {
  return s === null ? null : s + n;
}

/** The chats for `query`, best first: by match, then this project's first, active before settled, the latest first. */
export function rank(cands: readonly Cand[], query: string, limit: number): Cand[] {
  const v: [number, Cand][] = [];
  for (const c of cands) {
    const s = score(c, query);
    if (s !== null) v.push([s, c]);
  }
  // Close matches count as one: the order inside them is the list's.
  v.sort(([sa, a], [sb, b]) => Math.floor(sa / 10) - Math.floor(sb / 10) || Number(!a.here) - Number(!b.here) || Number(a.settled) - Number(b.settled) || b.updated - a.updated);
  return v.slice(0, limit).map((x) => x[1]);
}

/** A chat as Harbor knows it, the fields the menu needs. */
export interface CandChat {
  id: number;
  gid: string;
  title: string;
  repoId: number | null;
  /** A subagent's chat (never offered). */
  sub: boolean;
  settled: boolean;
  updated: number;
  /** A turn runs in it. */
  running: boolean;
  /** Its project's name ("" without one). */
  project: string;
  /** The PC it runs on. */
  pc: string;
}

/** A chat as the menu and the context see it (`repo`: the composer's project). */
export function chatCand(c: CandChat, repo: number | null): Cand {
  return {
    gid: c.gid,
    title: c.title.trim() === "" ? "Untitled chat" : c.title,
    project: c.project,
    pc: c.pc,
    status: c.running ? "working" : c.settled ? "settled" : "idle",
    updated: c.updated,
    here: repo !== null && c.repoId === repo,
    settled: c.settled,
  };
}

/** Every chat composer `key` can mention: the user's chats (not subagents), not itself. */
export function chatCands(chats: readonly CandChat[], key: number, repo: number | null): Cand[] {
  return chats.filter((c) => c.id !== key && !c.sub && c.gid !== "").map((c) => chatCand(c, repo));
}

/** The menu's rows (and the phone's) for `query`. */
export function chatRows(chats: readonly CandChat[], key: number, repo: number | null, query: string): Cand[] {
  return rank(chatCands(chats, key, repo), query, MAX_ROWS);
}

/** The menu row's tooltip. */
export function candTip(c: Cand): string {
  return `${c.title}\n${candLine(c)}\n\nMention this chat: the agent gets its recap and last turns`;
}

/** A chat picked for `w` in `draft`: the `$word` becomes the chat's title (a link once sent), and the mention to add. */
export function accept(draft: string, w: Word, c: Cand): { text: string; cursor: number; mention: Mention } {
  const title = label(c.title);
  return { ...replace(draft, w, title), mention: { ...candMention(c), title } };
}


function clip(s: string, max: number): string {
  return charCount(s) <= max ? s : `${takeChars(s, max)}…`;
}

/** A transcript item, the fields read (store's Item fits). */
export interface TurnItem {
  kind: string;
  text?: string;
}

/** The chat's last `TURNS` turns: each user prompt and the final answer that followed it. */
export function lastTurns(items: readonly TurnItem[]): [string, string][] {
  const turns: [string, string][] = [];
  for (const it of items) {
    const text = (it.text ?? "").trim();
    if (it.kind === "user") turns.push([text, ""]);
    // The last text of the turn is its final answer.
    else if (it.kind === "text" && text !== "") {
      const last = turns[turns.length - 1];
      if (last !== undefined) last[1] = text;
      else turns.push(["", text]);
    }
  }
  return turns.slice(Math.max(turns.length - TURNS, 0));
}

/** The context block of a chat (without quote marks), within `MAX_CHARS`: its facts and recap first, then as many of its last turns as fit (the newest kept; long ones cut). */
export function context(c: Cand, recap: string | null, items: readonly TurnItem[]): string {
  let head = `Title: ${c.title}\n`;
  if (c.project !== "") head += `Project: ${c.project}\n`;
  if (c.pc !== "") head += `PC: ${c.pc}\n`;
  head += `Status: ${c.status}\n`;
  const r = recap?.trim() ?? "";
  if (r !== "") head += `Recap: ${clip(r, 1200)}\n`;
  const turns = lastTurns(items);
  if (turns.length === 0) return `${head}(no messages yet)`;
  const room = Math.max(MAX_CHARS - (charCount(head) + 80), 0);
  // Each turn gets an equal share at first; what short ones leave goes to the newest.
  const share = Math.floor(room / turns.length);
  const parts: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const [user, answer] = turns[i] ?? ["", ""];
    const left = Math.max(room - used, 0);
    if (left < 200) break;
    const cap = i === turns.length - 1 ? Math.max(Math.max(left - share * i, 0), share) : Math.min(share, left);
    const u = clip(user, Math.max(Math.floor(cap / 3), 120));
    const a = clip(answer, Math.max(cap - charCount(u), 120));
    let t = "";
    if (u !== "") t += `User: ${u}\n`;
    if (a !== "") t += `Agent: ${a}\n`;
    used += charCount(t);
    parts.push(t);
  }
  parts.reverse();
  const out = `${head}Last ${parts.length} turn${parts.length === 1 ? "" : "s"}:\n${parts.join("")}`;
  return takeChars(out, MAX_CHARS).trimEnd();
}

/** A mentioned chat as the agent reads it, before the user's text. */
export function quote(m: Mention): string {
  let out = `> [mentioned chat “${m.title}”, chat id ${m.chat} (message_chat takes it; link it as ${chatLink(m.chat)})]\n`;
  const body = m.text.trim() === "" ? "(its context couldn't be read)" : m.text;
  for (const l of lines(body)) out += `> ${l}\n`;
  const note = m.note.trim();
  if (note !== "") out += `${note}\n`;
  return `${out}\n`;
}

/** Before a message goes out: a mentioned chat gets its context. */
export function fillChatMention(m: Mention, found: { cand: Cand; recap: string | null; items: readonly TurnItem[] } | null): void {
  if (m.kind !== "chat" || m.text.trim() !== "") return;
  if (found === null) {
    m.text = "(this chat isn't on this PC)";
    return;
  }
  m.text = context(found.cand, found.recap, found.items);
  m.len = charCount(m.text);
  if (m.title === "") m.title = found.cand.title;
  m.from = candLine(found.cand);
}
