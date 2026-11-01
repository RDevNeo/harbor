import { quote } from "./chatmention.ts";
import { clock } from "./team.ts";
import { defuse } from "./usertext.ts";
import { toolLabel } from "@harbor/net";
import { charCount, lines, takeChars, words } from "./text.ts";

/** Longest quote sent to the agent, in characters. */
export const MAX_CHARS = 4000;
/** How long a message stays highlighted after its chip is clicked, in seconds. */
export const FLASH_SECS = 1.6;

/** A mentioned message: where it is (its item in the same chat) and what it said; or a whole chat (`kind` "chat"). */
export interface Mention {
  item: number;
  from: string;
  at: number;
  /** The message, cut at `MAX_CHARS`. */
  text: string;
  /** Its full length in characters (more than `text` holds when cut). */
  len: number;
  /** `text` is a part of the message the user selected, not all of it. */
  excerpt: boolean;
  /** What the user wrote about it, sent right under its quote. */
  note: string;
  /** A whole chat: `chat` and `title` say which, `text` gets its context when sent. */
  kind: "" | "chat";
  /** The mentioned chat's global id. */
  chat: string;
  title: string;
}

/** A mention with every field not given at its default. */
export function newMention(m: Partial<Mention>): Mention {
  return { item: 0, from: "", at: 0, text: "", len: 0, excerpt: false, note: "", kind: "", chat: "", title: "", ...m };
}

/** A mention from its stored JSON (missing fields at their defaults); null when a field has the wrong type. */
export function mentionFromJson(v: unknown): Mention | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = new Map(Object.entries(v));
  const m = newMention({});
  for (const k of ["item", "at", "len"] as const) {
    const x = o.get(k);
    if (x === undefined) continue;
    if (typeof x !== "number" || !Number.isSafeInteger(x) || (k !== "at" && x < 0)) return null;
    m[k] = x;
  }
  for (const k of ["from", "text", "note", "chat", "title"] as const) {
    const x = o.get(k);
    if (x === undefined) continue;
    if (typeof x !== "string") return null;
    m[k] = x;
  }
  const kind = o.get("kind");
  if (kind !== undefined && typeof kind !== "string") return null;
  m.kind = kind === "chat" ? "chat" : "";
  const ex = o.get("excerpt");
  if (ex !== undefined) {
    if (typeof ex !== "boolean") return null;
    m.excerpt = ex;
  }
  return m;
}

/** A mention as stored: `excerpt` only when set, `note`, `kind`, `chat` and `title` only when not empty. */
export function mentionToJson(m: Mention): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { item: m.item, from: m.from, at: m.at, text: m.text, len: m.len };
  if (m.excerpt) out.excerpt = true;
  if (m.note !== "") out.note = m.note;
  if (m.kind !== "") out.kind = m.kind;
  if (m.chat !== "") out.chat = m.chat;
  if (m.title !== "") out.title = m.title;
  return out;
}

/** A whole chat, mentioned with `$`. */
export function isChat(m: Mention): boolean {
  return m.kind === "chat";
}

/** First non-empty line, for chips. */
export function snippet(m: Mention): string {
  if (isChat(m)) return m.from;
  return lines(m.text).map((l) => l.trim()).find((l) => l !== "") ?? "";
}

/** The same message and text (excerpts of one message are told apart by their text). */
export function sameMention(a: Mention, b: Mention): boolean {
  if (isChat(a) || isChat(b)) return a.chat === b.chat && a.kind === b.kind;
  return a.item === b.item && a.excerpt === b.excerpt && (!a.excerpt || a.text === b.text);
}

export function add(list: Mention[], m: Mention): void {
  if (!list.some((x) => sameMention(x, m))) list.push(m);
}

/** Text with its whitespace runs folded to one space, to compare a selection with a message. */
export function folded(s: string): string {
  return words(s).join(" ");
}

/** `m` holding only `text` (cut at `MAX_CHARS`). */
export function excerpt(m: Mention, text: string): Mention {
  return { ...m, text: takeChars(text, MAX_CHARS), len: charCount(text), excerpt: true };
}

/** The mention of `text`, selected in the message `whole` mentions: a selection of the whole message is a mention of the message. */
export function excerptOf(whole: Mention, text: string): Mention | null {
  const t = text.trim();
  if (t === "") return null;
  return whole.len <= MAX_CHARS && folded(t) === folded(whole.text) ? whole : excerpt(whole, t);
}

/** The quoted blocks that go before the user's text. */
export function prompt(ms: readonly Mention[]): string {
  let out = "";
  for (const m of ms) {
    if (isChat(m)) {
      out += quote(m);
      continue;
    }
    const when = m.at > 0 ? `, ${clock(m.at, -new Date(m.at * 1000).getTimezoneOffset() * 60)}` : "";
    out += m.excerpt ? `> [excerpt of a message from ${m.from}${when}]\n` : `> [mentioned message from ${m.from}${when}]\n`;
    for (const l of lines(defuse(m.text))) out += `> ${l}\n`;
    const shown = charCount(m.text);
    if (m.len > shown) out += `> (truncated: the first ${shown} of ${m.len} characters)\n`;
    const note = m.note.trim();
    if (note !== "") out += `${note}\n`;
    out += "\n";
  }
  return out;
}

/** The transcript items a mention can be made of (store's Item, the fields used). */
export type MentionableItem =
  | { kind: "user"; text: string; files: readonly string[]; at: number }
  | { kind: "text"; text: string; at: number }
  | { kind: "tool"; name: string; summary: string; input: string; result: string | null }
  | { kind: "notice"; text: string; detail: string }
  | { kind: "message"; from: string; to: string; text: string }
  | { kind: "error"; text: string }
  | { kind: "thinking" }
  | { kind: "result" };

export function mentionAgent(chat: { sub: boolean; name: string } | null, kindLabel: string | null): string {
  if (chat === null) return "the agent";
  if (chat.sub && chat.name !== "") return chat.name;
  return kindLabel ?? "the agent";
}

/** A mention of a chat's `i`th item (`agent`: see `mentionAgent`); null for items that aren't messages. */
export function mentionOf(item: MentionableItem, i: number, agent: string): Mention | null {
  let from: string;
  let at = 0;
  let text: string;
  switch (item.kind) {
    case "user":
      from = "you";
      at = item.at;
      text = item.text + item.files.map((f) => `\n(attached: ${f})`).join("");
      break;
    case "text":
      from = agent;
      at = item.at;
      text = item.text;
      break;
    case "tool": {
      const label = toolLabel(item.name);
      from = `${agent} · ${label}`;
      text = `${label} ${item.summary}\ninput: ${item.input}` + (item.result === null ? "" : `\nresult: ${item.result}`);
      break;
    }
    case "notice":
      from = takeChars(item.text, 40);
      text = item.detail === "" ? item.text : `${item.text}\n\n${item.detail}`;
      break;
    case "message":
      from = `${item.from} → ${item.to}`;
      text = item.text;
      break;
    case "error":
      from = "error";
      text = item.text;
      break;
    case "thinking":
    case "result":
      return null;
  }
  const len = charCount(text);
  return newMention({ item: i, from, at, text: len > MAX_CHARS ? takeChars(text, MAX_CHARS) : text, len });
}


export function chipHead(m: Mention): string {
  return isChat(m) ? m.title : m.from;
}

/** A chip's dimmed text: an excerpt reads as a quote. */
export function chipSnippet(m: Mention): string {
  return m.excerpt ? `“${snippet(m)}”` : snippet(m);
}

/** A chip's tooltip; `framed`: a chip of its own (one in the composer's card has its note box in view). */
export function chipTip(m: Mention, framed: boolean): string {
  let tip = isChat(m) ? `${m.title}\n${m.from}` : takeChars(m.text, 300);
  if (framed && m.note.trim() !== "") tip += `\n\nYour note: ${m.note.trim()}`;
  const what = isChat(m) ? "Click to open this chat" : m.excerpt ? "Excerpt. Click to see its message in the chat" : "Click to see it in the chat";
  return `${tip}\n\n${what}`;
}

export function noteHint(m: Mention): string {
  return isChat(m) ? "Add a note about this chat" : m.excerpt ? "Add a note about this excerpt" : "Add a note about this message";
}

/** How strong the highlight of a message pointed at is, `age` seconds after (1 to 0); null once it's over. */
export function flashAlpha(age: number): number | null {
  return age > FLASH_SECS ? null : 1 - age / FLASH_SECS;
}
