import type { Item, Mention, SentVia } from "@harbor/store";
import { sentBy } from "./senders.ts";

export interface Media {
  /** A local absolute path (for an https URL: where its download is cached). */
  path: string;
  caption: string;
  video: boolean;
  /** Shown on purpose (a markdown image): drawn large; else a file the text only names. */
  shown: boolean;
  url: string | null;
}

/** One transcript item as the desktop draws it and the phone API sends it (view.rs `Card`). */
export type Card =
  | { kind: "hidden" }
  | { kind: "user"; text: string; files: string[]; images: string[]; mentions: Mention[]; at: number; sender: string; intent: string; who: string; via: SentVia | ""; joined: boolean }
  | { kind: "text"; text: string; at: number; forkable: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; label: string; summary: string; input: string; result: string | null; is_error: boolean }
  | { kind: "forked_from"; chat: number; seq: number }
  | { kind: "chat_link"; gid: string; text: string }
  | { kind: "notice"; icon: string; text: string; detail: string; markdown: boolean; url: string | null }
  | { kind: "message"; from: string; to: string; text: string }
  | { kind: "error"; text: string };

export type CardKind = Card["kind"];

export type Action = "copy" | "quote" | "fork" | "mention";

export const ACTION_LABELS: Record<Action, string> = {
  copy: "Copy",
  quote: "Quote in reply",
  fork: "Fork from this response",
  mention: "Mention in your next message",
};

export function actionLabel(a: Action): string {
  return ACTION_LABELS[a];
}

/** A card's actions in the hover bar's order. */
export function actions(c: Card): Action[] {
  switch (c.kind) {
    case "user":
      return ["copy", "quote", "mention"];
    case "text":
      return c.forkable ? ["copy", "fork", "mention"] : ["copy", "mention"];
    case "tool":
    case "notice":
    case "message":
      return ["mention"];
    default:
      return [];
  }
}

const OLD_SHOW_MEDIA = "mcp__harbor__show_media";
const LEAD_ACTIVITY = ["bot", "report", "process", "wake", "webhook"];
/** openchat.rs: a message addressed to the chat itself, and a chat link notice's detail prefix. */
export const THIS_CHAT = "this chat";
export const CHAT_LINK = "harbor:gid/";
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

export function isImage(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 && IMAGE_EXTS.includes(base.slice(i + 1).toLowerCase());
}

export interface Shown {
  seq: number;
  card: Card;
  forksAfter: number[];
  /** The seq of the first card of the run of tool calls this card is folded into. */
  group: number | null;
}

/** "mcp__harbor__spawn_agent" → "Spawn agent"; "mcp__github__get_pr" → "github · get_pr". */
export function toolLabel(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice(5);
  const i = rest.indexOf("__");
  const [server, tool] = i < 0 ? ["", rest] : [rest.slice(0, i), rest.slice(i + 2)];
  if (server !== "harbor") return `${server} · ${tool}`;
  const t = tool.replaceAll("_", " ");
  const first = Array.from(t)[0];
  return first === undefined ? name : first.toUpperCase() + t.slice(first.length);
}

/** For each item, the Result that ends its turn when it's the turn's last reply (fork.rs `forkable`). */
export function forkable(items: readonly Item[]): (number | null)[] {
  const out: (number | null)[] = items.map(() => null);
  let last: number | null = null;
  items.forEach((it, i) => {
    if (it.kind === "text" && it.text.trim() !== "") last = i;
    else if (it.kind === "result") {
      if (last !== null) out[last] = i;
      last = null;
    } else if (it.kind === "user") last = null;
  });
  return out;
}

/** Which items a lead's transcript hides: its activity, not what the user has to know. */
export function hidden(items: readonly Item[], lead: boolean): boolean[] {
  if (!lead) return items.map(() => false);
  return items.map((it) => {
    switch (it.kind) {
      case "tool":
        return it.name !== OLD_SHOW_MEDIA || it.is_error;
      case "thinking":
        return true;
      case "notice":
        return LEAD_ACTIVITY.includes(it.icon);
      case "message":
        return it.to !== THIS_CHAT;
      case "text":
        return it.text.trim() === "";
      default:
        return false;
    }
  });
}

function card(it: Item, canFork: boolean): Card {
  switch (it.kind) {
    case "user":
      return { kind: "user", text: it.text, sender: it.sender, ...sentBy(it.sender, it.who, it.via), joined: false, intent: it.intent, files: it.files.filter((f) => !isImage(f)), images: it.files.filter(isImage), mentions: it.mentions, at: it.at };
    case "text":
      return { kind: "text", text: it.text, at: it.at, forkable: canFork };
    case "thinking":
      return { kind: "thinking", text: it.text };
    case "tool":
      return { kind: "tool", label: toolLabel(it.name), summary: it.summary, input: it.input, result: it.result, is_error: it.is_error };
    case "result":
      return { kind: "hidden" };
    case "notice": {
      if (it.icon === "fork" && it.detail.startsWith("harbor:chat/")) {
        const rest = it.detail.slice("harbor:chat/".length);
        const j = rest.indexOf("/");
        const [c, n] = j < 0 ? ["", ""] : [rest.slice(0, j), rest.slice(j + 1)];
        const p = (x: string) => (/^-?\d+$/.test(x) ? Number(x) : 0);
        return { kind: "forked_from", chat: p(c), seq: p(n) };
      }
      if (it.icon === "chat" && it.detail.startsWith(CHAT_LINK)) return { kind: "chat_link", gid: it.detail.slice(CHAT_LINK.length), text: it.text };
      const url = it.icon === "process" && it.detail.startsWith("http") ? it.detail : null;
      return { kind: "notice", icon: it.icon, text: it.text, detail: it.detail, markdown: it.icon === "bot" || it.icon === "report", url };
    }
    case "message":
      return { kind: "message", from: it.from, to: it.to, text: it.text };
    case "error":
      return { kind: "error", text: it.text };
  }
}

/** The transcript as cards; `forks` are [item index, forked chat] pairs. */
export function project(items: readonly Item[], lead: boolean, forks: readonly [number, number][]): Shown[] {
  const hide = hidden(items, lead);
  const fk = forkable(items);
  const out: Shown[] = items.map((it, i) => ({
    seq: i,
    card: hide[i] ? { kind: "hidden" } : card(it, fk[i] !== null),
    forksAfter: forks.filter(([at]) => at === i).map(([, f]) => f),
    group: null,
  }));
  if (!lead) markGroups(out);
  markJoined(out);
  return out;
}

/** Seconds within which a message from the same place joins the one before it. */
export const JOIN_SECS = 5 * 60;

/**
 * WhatsApp-style runs: a user card joins the card drawn before it (no sender row, a small gap)
 * when that one is a user card from the same person on the same kind of device (or both typed on
 * this PC), sent at most JOIN_SECS before it, with nothing drawn between (hidden cards don't count,
 * a fork divider does). Decided from the card before only, so a new message never changes it.
 */
function markJoined(cards: Shown[]): void {
  let prev: Shown | null = null;
  for (const s of cards) {
    const c = s.card;
    if (c.kind === "hidden") {
      if (s.forksAfter.length > 0) prev = null;
      continue;
    }
    const p = prev?.card;
    if (c.kind === "user" && p?.kind === "user" && prev?.forksAfter.length === 0 && p.who === c.who && p.via === c.via && c.at >= p.at && c.at - p.at <= JOIN_SECS) c.joined = true;
    prev = s;
  }
}

function markGroups(cards: Shown[]): void {
  const foldable = (c: Card) => c.kind === "tool" || c.kind === "thinking" || c.kind === "hidden";
  let i = 0;
  while (i < cards.length) {
    let j = i;
    while (j < cards.length && foldable((cards[j] as Shown).card)) j++;
    const run = cards.slice(i, j);
    if (run.some((s) => s.card.kind === "tool")) {
      const first = run.find((s) => s.card.kind !== "hidden")?.seq ?? null;
      for (const s of run) if (s.card.kind !== "hidden") s.group = first;
    }
    i = Math.max(j, i + 1);
  }
}

export interface Group {
  calls: number;
  pending: boolean;
}

/** Each run's chevron row, by its id. */
export function groups(cards: readonly Shown[]): Map<number, Group> {
  const out = new Map<number, Group>();
  for (const s of cards) {
    if (s.group === null || s.card.kind !== "tool") continue;
    const e = out.get(s.group) ?? { calls: 0, pending: false };
    e.calls += 1;
    e.pending = e.pending || s.card.result === null;
    out.set(s.group, e);
  }
  return out;
}

export function groupLabel(calls: number): string {
  return `${calls} tool call${calls === 1 ? "" : "s"}`;
}

/** The images and videos a card shows; `find` lists a text's media (media.rs `find`). */
export function cardMedia(c: Card, find: (text: string) => Media[]): Media[] {
  switch (c.kind) {
    case "user":
      return c.images.map((p) => ({ path: p, caption: "", video: false, shown: false, url: null }));
    case "text":
      return find(c.text);
    case "tool": {
      if (c.is_error) return [];
      const all = find(c.input);
      for (const m of c.result === null ? [] : find(c.result)) if (!all.some((x) => x.path === m.path)) all.push(m);
      return all.map((m) => ({ ...m, shown: false }));
    }
    default:
      return [];
  }
}

/** One card's images and videos in the order they show (large ones first), each once. */
export function gallery(c: Card, find: (text: string) => Media[]): string[] {
  const media = cardMedia(c, find);
  const large = (m: Media) => m.shown || m.video;
  const seen = new Set<string>();
  return [...media.filter(large), ...media.filter((m) => !large(m))].map((m) => m.path).filter((p) => !seen.has(p) && seen.add(p) !== undefined);
}
