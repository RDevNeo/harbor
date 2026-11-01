import * as slint from "slint-ui";
import { ICONS, type IconName } from "./icons.ts";
import { actions, type Card, groupLabel, groups, project } from "@harbor/net";
import { clock } from "./logic/team.ts";
import type { Item } from "@harbor/store";
import { type Part, parts } from "./logic/usertext.ts";
import { type Block, blocks, escape, type Placed, place } from "./markdown.ts";
import type { CardData, MdBlockData, MediaRow } from "./window.ts";

/** Folded and opened state of one chat's cards, by seq. */
export interface Opened {
  /** How many of the latest cards are built; "Show earlier messages" raises it. */
  limit: number;
  /** Tool runs opened (by the seq of their first card). */
  groups: Set<number>;
  /** Tool calls, notices and thinking expanded. */
  cards: Set<number>;
}

export const PAGE = 80;
export const EARLIER = -5;

export const newOpened = (): Opened => ({ limit: PAGE, groups: new Set(), cards: new Set() });

const TOOL_TEXT_MAX = 4000;
const RESULT_MAX = 8000;
const DETAIL_MAX = 6000;

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function styled(md: string): slint.StyledText {
  try {
    return slint.StyledText.fromMarkdown(md);
  } catch {
    return slint.StyledText.fromPlainText(md);
  }
}

function blockData(b: Block, at: Placed): MdBlockData {
  const base: MdBlockData = {
    kind: b.kind,
    text: slint.StyledText.fromPlainText(""),
    code: "",
    level: 0,
    marker: "",
    depth: 0,
    quote: b.quote,
    cols: [],
    rows: 0,
    gap: at.gap,
    after: at.after,
    bar_top: at.barTop,
    bar_bottom: at.barBottom,
  };
  switch (b.kind) {
    case "p":
      return { ...base, text: styled(b.text) };
    case "h":
      return { ...base, text: styled(b.level <= 1 ? `**${b.text}**` : b.text), level: b.level };
    case "li":
      return { ...base, text: styled(b.text), marker: b.marker, depth: b.depth };
    case "code":
      return { ...base, code: b.text };
    case "hr":
      return base;
    case "table": {
      const width = Math.max(0, ...b.rows.map((r) => r.length));
      const cols = Array.from({ length: width }, (_, c) => ({ cells: b.rows.map((r) => styled(r[c] ?? "")) }));
      return { ...base, cols, rows: b.rows.length };
    }
  }
}

export function mdBlocks(md: string): MdBlockData[] {
  const bs = blocks(md);
  const at = place(bs);
  return bs.map((b, i) => blockData(b, at[i] as Placed));
}

export function userText(ps: readonly Part[]): slint.StyledText {
  let md = "";
  for (const p of ps) {
    const lines = p.text.split("\n");
    const one = (s: string) => {
      if (s === "") return "";
      switch (p.kind) {
        case "plain":
          return escape(s);
        case "chat":
          return `[${escape(s)}](harbor:chat/${p.chat})`;
        default:
          return `[${escape(s)}](harbor:token)`;
      }
    };
    md += lines.map(one).join("\\\n");
  }
  try {
    return slint.StyledText.fromMarkdown(md);
  } catch {
    return slint.StyledText.fromPlainText(ps.map((p) => p.text).join(""));
  }
}

const NOTICE_ICONS: Record<string, IconName> = {
  bot: "BOT",
  report: "BOT",
  wake: "ALARM",
  webhook: "WEBHOOK",
  alert: "ALERT",
  fork: "FORK",
  process: "ACTIVITY",
  clock: "CLOCK",
  restart: "ROTATE_CW",
  folder: "FOLDER",
  worktree: "FOLDER_GIT",
  users: "USERS",
  monitor: "MONITOR",
  lock: "LOCK",
};

function blank(seq: number): CardData {
  return { kind: "", seq, blocks: [], text: "", label: "", icon: "", tone: "", detail: "", result: "", open: false, pending: false, expandable: false, sender: "", files: [], steer: false, url: "", actions: [], time: "", media: [] };
}

function base(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? name : name.slice(i + 1);
}

/** An image drawn under the reply leaves its markdown reference out of the text (media.rs `strip_refs`). */
export function stripDrawn(text: string, drawn: readonly string[]): string {
  if (drawn.length === 0) return text;
  return text.replace(/!\[[^\]]*\]\(([^)\s]*)[^)]*\)/g, (ref, target: string) => (drawn.some((p) => p.endsWith(target.replace(/^~\//, "").replace(/^\.\//, ""))) ? "" : ref));
}

/** The images a card shows, as the window draws them; none until they are decoded. */
export type MediaOf = (c: Card) => MediaRow[];

function cardData(c: Card, seq: number, open: Opened, off: number, mediaOf: MediaOf): CardData | null {
  const at = c.kind === "user" || c.kind === "text" ? c.at : 0;
  const d = { ...blank(seq), actions: c.kind === "user" || c.kind === "text" ? actions(c) : [], time: at > 0 ? clock(at, off) : "", media: mediaOf(c) };
  switch (c.kind) {
    case "hidden":
      return null;
    case "user":
      return { ...d, kind: "user", blocks: [{ kind: "p", text: userText(parts(c.text, c.mentions)), code: "", level: 0, marker: "", depth: 0, quote: 0, cols: [], rows: 0, gap: 0, after: 0, bar_top: 0, bar_bottom: 0 }], text: c.text, sender: c.sender, files: c.files.map(base), steer: c.intent !== "" };
    case "text": {
      const md = stripDrawn(c.text, d.media.filter((m) => m.large).map((m) => m.path));
      return { ...d, kind: "text", blocks: mdBlocks(md), text: c.text };
    }
    case "thinking":
      return { ...d, kind: "thinking", text: c.text, open: open.cards.has(seq) };
    case "tool": {
      const [icon, tone]: [IconName, string] = c.result === null ? ["LOADER", ""] : c.is_error ? ["CIRCLE_X", "red"] : ["CIRCLE_CHECK", "green"];
      return { ...d, kind: "tool", label: c.label, text: c.summary, icon: ICONS[icon], tone, detail: clip(c.input, TOOL_TEXT_MAX), result: c.result === null ? "" : clip(c.result, RESULT_MAX), open: open.cards.has(seq) };
    }
    case "forked_from":
      return { ...d, kind: "divider", icon: ICONS.FORK, text: "Forked from conversation", label: "Open source conversation", url: `harbor:chat-id/${c.chat}/${c.seq}` };
    case "chat_link":
      return { ...d, kind: "divider", icon: ICONS.BOT, text: c.text, label: "Open chat", url: `harbor:chat/${c.gid}` };
    case "notice": {
      const expandable = c.detail !== "" && !c.detail.startsWith("http");
      const opened = expandable && open.cards.has(seq);
      return {
        ...d,
        kind: "notice",
        icon: ICONS[NOTICE_ICONS[c.icon] ?? "CIRCLE_CHECK"],
        text: c.text,
        detail: c.markdown ? "" : clip(c.detail, DETAIL_MAX),
        blocks: opened && c.markdown ? mdBlocks(c.detail) : [],
        expandable: c.url === null && expandable,
        open: c.url === null && opened,
        url: c.url ?? "",
      };
    }
    case "message":
      return { ...d, kind: "message", label: `${c.from} → ${c.to}`, text: clip(c.text, DETAIL_MAX) };
    case "error":
      return { ...d, kind: "error", text: clip(c.text, TOOL_TEXT_MAX) };
  }
}

/** Every card the transcript draws, a 24px space at each end and the status line if any. */
// Streaming changes one item at a time: the others keep their card, so their markdown isn't parsed again.
const memo = new WeakMap<Item, { sig: string; data: CardData | null }>();

function signature(it: Item, open: Opened, seq: number, media: number): string {
  const body = it.kind === "tool" ? `${it.input.length}:${it.result?.length ?? -1}:${it.is_error}` : "text" in it ? String(it.text.length) : "";
  return `${seq}:${body}:${open.cards.has(seq)}:${media}`;
}

export function transcriptCards(items: readonly Item[], lead: boolean, forks: [number, number][], open: Opened, status: string, off = 0, mediaOf: MediaOf = () => []): CardData[] {
  const all = project(items, lead, forks);
  const runs = groups(all);
  const visible = all.filter((s) => s.card.kind !== "hidden" && (s.group === null || s.group === s.seq));
  const from = visible.length > open.limit ? (visible[visible.length - open.limit]?.seq ?? 0) : 0;
  const shown = all.filter((s) => s.seq >= from && (s.group === null || s.group >= from));
  const out: CardData[] = [{ ...blank(-1), kind: "space" }];
  if (from > 0) out.push({ ...blank(EARLIER), kind: "earlier", label: `Show earlier messages (${visible.length - open.limit})` });
  const fork = (seq: number, f: number) => out.push({ ...blank(seq), kind: "divider", icon: ICONS.FORK, text: "Conversation fork", label: "Open fork", url: `harbor:chat-id/${f}/0` });
  for (const s of shown) {
    if (s.group !== null) {
      const g = runs.get(s.group) ?? { calls: 0, pending: false };
      const opened = open.groups.has(s.group);
      if (s.group === s.seq) out.push({ ...blank(groupSeq(s.seq)), kind: "group", label: groupLabel(g.calls), open: opened, pending: g.pending });
      if (!opened) {
        for (const f of s.forksAfter) fork(s.seq, f);
        continue;
      }
    }
    const item = items[s.seq];
    const media = mediaOf(s.card);
    const sig = item ? signature(item, open, s.seq, media.length) : "";
    const hit = item ? memo.get(item) : undefined;
    const c = hit && hit.sig === sig ? hit.data : cardData(s.card, s.seq, open, off, () => media);
    if (item) memo.set(item, { sig, data: c });
    if (c) out.push(c);
    for (const f of s.forksAfter) fork(s.seq, f);
  }
  if (status !== "") out.push({ ...blank(-2), kind: "status", text: status });
  out.push({ ...blank(-3), kind: "space" });
  return out;
}

/** A run's chevron row stands for the run, not its first card: its own (negative) seq. */
export function groupSeq(first: number): number {
  return -(first + 10);
}

/** Opens or folds what a click on card `seq` toggles: a run's row, a tool call, a notice, thinking. */
export function toggle(open: Opened, seq: number): void {
  if (seq === EARLIER) {
    open.limit += PAGE;
    return;
  }
  const [set, key] = seq <= -10 ? [open.groups, -seq - 10] : [open.cards, seq];
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

export interface QueuedView {
  id: number;
  text: string;
  files: number;
  written: boolean;
  steering: boolean;
  note: string;
  editing: string;
}

export interface QueueState {
  running: boolean;
  steerable: boolean;
  held: boolean;
  editing: number | null;
  unfolded: boolean;
}

export const QUEUE_MORE = -7;
const QUEUE_HEAD = -6;

/** queue.rs `steering_bubbles` and `queued_bubbles`: steers on their way in, then "Up next". */
export function queueCards(q: readonly QueuedView[], s: QueueState): { steers: CardData[]; next: CardData[] } {
  const label = (m: QueuedView) => (m.text === "" ? `${m.files} attachment(s)` : m.text);
  const steers = q.filter((m) => m.steering).map((m) => ({ ...blank(m.id), kind: "steering" as const, text: label(m) }));
  const waiting = q.filter((m) => !m.steering);
  if (waiting.length === 0) return { steers, next: [] };
  const open = waiting.filter((m) => !m.written).length;
  const fold = waiting.length > 3 && !s.unfolded;
  const next: CardData[] = [{ ...blank(QUEUE_HEAD), kind: "queue-head", label: `Up next · ${waiting.length} queued${s.held ? " · paused" : ""}` }];
  let place = 0;
  for (const m of waiting.slice(0, fold ? 2 : waiting.length)) {
    const at = place;
    if (!m.written) place++;
    const steerTip = s.running ? (at === 0 ? "Send as a steer instead (Ctrl+Shift+Enter)" : "Send as a steer instead") : "Send it now";
    next.push({
      ...blank(m.id),
      kind: "queued",
      text: label(m),
      pending: m.written,
      tone: s.editing === m.id ? "mine" : m.editing !== "" ? "other" : "",
      result: m.note,
      label: s.running ? "Steer" : "Send now",
      expandable: !s.running || s.steerable,
      url: s.running && !s.steerable ? "The agent can't be steered now: it waits for the turn to end" : steerTip,
      icon: at === open - 1 ? "Edit in the composer (Alt+↑)" : "Edit in the composer",
      detail: !m.written && open > 1 ? String(at + 1) : "",
      open: !m.written && open > 1,
    });
  }
  if (fold) next.push({ ...blank(QUEUE_MORE), kind: "queue-more", label: `Show all ${waiting.length} queued` });
  return { steers, next };
}

/** Steers go in with the turn, over "Working…"; "Up next" comes after it. */
export function withQueue(cards: CardData[], q: { steers: CardData[]; next: CardData[] }): CardData[] {
  const end = cards.length - 1;
  const status = cards[end - 1]?.kind === "status" ? end - 1 : end;
  return [...cards.slice(0, status), ...q.steers, ...cards.slice(status, end), ...q.next, ...cards.slice(end)];
}

/** waiting.rs `subs_running`: what follows "Working… 12s" while sub-agents run too. */
export function subsRunning(n: number): string {
  return n === 0 ? "" : n === 1 ? "  ·  1 sub-agent running" : `  ·  ${n} sub-agents running`;
}
