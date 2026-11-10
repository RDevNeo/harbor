import * as slint from "slint-ui";
import { actions, type Card, CHAT_SCHEME, chatLinks, dividerLook, FORK_DIVIDER, groups, labelChatLinks, noticeLook, project, runLook, senderLook, toolLook, type Viewer } from "@harbor/net";
import { clock } from "./logic/team.ts";
import type { Item } from "@harbor/store";
import { captchaRoles, type CaptchaRole, captchaText } from "./logic/captchacard.ts";
import { chipHead, chipSnippet, chipTip, isChat, mentionFromJson } from "./logic/mentions.ts";
import { type Part, parts } from "./logic/usertext.ts";
import { type Block, blockScope, blocks, escape, type Placed, place, registerBlock, releaseBlocks } from "./markdown.ts";
import type { CardData, CiteData, MdBlockData, MediaRow } from "./window.ts";

/** Folded and opened state of one chat's cards, by seq. */
export interface Opened {
  /** Names its cards' markdown blocks (`blockOwner`): their keys go when the card is built again or leaves. */
  id: string;
  /** How many of the latest cards are built: scrolling up (or "Show earlier messages") raises it by PAGE,
   * and `trim` puts it back once the reader is at the end again. */
  limit: number;
  /** When `limit` last grew (ms), for `trim`. */
  grew: number;
  /** The cards built for the cards shown, by seq: streaming changes one item at a time, so the others keep
   * their card and their markdown isn't parsed again. Cards that leave the window leave this too. */
  memo: Map<number, { item: Item; sig: string; data: CardData | null; joins?: Joins }>;
  /** Tool runs opened (by the seq of their first card). */
  groups: Set<number>;
  /** Tool calls, notices and thinking expanded. */
  cards: Set<number>;
}

/** A user card's look in a run of joined messages, kept with its memo so the same card is the same object. */
interface Joins {
  joined: boolean;
  tight: boolean;
  data: CardData;
}

export const PAGE = 15;
export const EARLIER = -5;

export const newOpened = (): Opened => ({ id: blockScope(), limit: PAGE, grew: 0, memo: new Map(), groups: new Set(), cards: new Set() });

/** The owner of card `seq`'s markdown blocks in a chat's transcript (markdown.ts `registerBlock`). */
export const blockOwner = (open: Opened, seq: number): string => `${open.id}.${seq}`;

/** One more page of earlier cards. */
export function earlier(open: Opened, at = Date.now()): void {
  open.limit += PAGE;
  open.grew = at;
}

/** Back to the latest PAGE cards; the next build lets the others' cards (and so their images) go. False: nothing to trim. */
export function trim(open: Opened): boolean {
  if (open.limit <= PAGE) return false;
  open.limit = PAGE;
  return true;
}

/** A chat no longer shown keeps none of its built cards. */
export function forget(open: Opened): void {
  open.limit = PAGE;
  for (const seq of open.memo.keys()) releaseBlocks(blockOwner(open, seq));
  open.memo.clear();
}

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

function blockData(b: Block, at: Placed, seq: number, owner: string | null, index: number): MdBlockData {
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
    trim: 0,
    plain: "",
    key: "",
  };
  switch (b.kind) {
    case "p":
      return { ...base, text: styled(b.text), plain: b.plain, key: registerBlock(b.plain, b.links, seq, owner, index) };
    case "h":
      return { ...base, text: styled(b.level <= 1 ? `**${b.text}**` : b.text), level: b.level, plain: b.plain, key: registerBlock(b.plain, b.links, seq, owner, index) };
    case "li":
      return { ...base, text: styled(b.text), marker: b.marker, depth: b.depth, plain: b.plain, key: registerBlock(b.plain, b.links, seq, owner, index) };
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

const sources = new WeakMap<MdBlockData, string>();

/** `seq`: the transcript item the text is in, so a selection of it can be mentioned (-1: none). `owner`: the card
 * whose blocks these are (`blockOwner`), so their keys are its own and go with it; null: numbered ones (other pages). */
export function mdBlocks(md: string, seq = -1, owner: string | null = null): MdBlockData[] {
  const bs = blocks(md);
  const at = place(bs);
  const out = bs.map((b, i) => {
    const d = blockData(b, at[i] as Placed, seq, owner, i);
    sources.set(d, JSON.stringify([b, at[i], seq]));
    return d;
  });
  const last = out.at(-1);
  if (last && (last.kind === "p" || last.kind === "li" || last.kind === "h") && last.after === 0) last.trim = 3;
  return out;
}

/**
 * A page's parsed markdown (PR and issue bodies, comments) by its text: the same text gives the same blocks, so
 * the window's rows stay as they are. What the last render (`drawn`) didn't draw goes, its blocks' keys with it:
 * kept by the page for the life of the process, it once held every body and comment ever opened.
 */
export class PageBlocks {
  private now = new Map<string, { blocks: MdBlockData[]; owner: string }>();
  private before = new Map<string, { blocks: MdBlockData[]; owner: string }>();

  constructor(private shape: (b: MdBlockData[]) => MdBlockData[] = (b) => b) {}

  get(md: string): MdBlockData[] {
    let e = this.now.get(md) ?? this.before.get(md);
    if (e === undefined) {
      const owner = blockScope("p");
      e = { blocks: this.shape(mdBlocks(md, -1, owner)), owner };
    }
    this.before.delete(md);
    this.now.set(md, e);
    return e.blocks;
  }

  /** After a render that drew everything shown: what it didn't ask for goes. */
  drawn(): void {
    for (const e of this.before.values()) releaseBlocks(e.owner);
    this.before = this.now;
    this.now = new Map();
  }

  get size(): number {
    return this.now.size + this.before.size;
  }
}

/** Two parses of the same markdown block: the older one can stay on screen, its key (the same one) still points at the same text. */
export function sameBlock(a: MdBlockData, b: MdBlockData): boolean {
  if (a === b) return true;
  const s = sources.get(a);
  return s !== undefined && s === sources.get(b) && a.trim === b.trim && a.key === b.key;
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

/** The messages a user's message mentions, as the composer's chips over its text, each with the note written under it
 * (a mentioned chat is a link in the text instead: `parts`). */
export function cites(ms: readonly unknown[]): CiteData[] {
  return ms.flatMap((v) => {
    const m = mentionFromJson(v);
    return m === null || isChat(m) ? [] : [{ head: chipHead(m), snippet: chipSnippet(m), tip: chipTip(m, false), note: m.note.trim() }];
  });
}

/** A message with no text, as its mentions read in one bubble of plain text: each one's note, else its chip. */
export function citesLabel(ms: readonly unknown[]): string {
  return cites(ms)
    .map((c) => (c.note !== "" ? c.note : `@${c.head} ${c.snippet}`))
    .join("\n");
}

function blank(seq: number): CardData {
  return { kind: "", seq, blocks: [], text: "", label: "", icon: "", tone: "", detail: "", result: "", open: false, pending: false, expandable: false, sender: "", joined: false, tight: false, files: [], steer: false, url: "", actions: [], time: "", media: [], cites: [] };
}

/** The row over the bubble for a message written elsewhere: a phone or PC icon and the person (net's look.ts `senderLook`). */
function senderLine(c: Extract<Card, { kind: "user" }>): { sender: string; icon: string } {
  const l = senderLook(c);
  return { sender: l.name, icon: l.glyph };
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

/** Whether a captcha (by id) is known to wait no more: its card says so in one line. */
export type CaptchaGone = (id: string) => boolean;
/** The title a chat link (`harbor://chat/…`, as written) reads as: the chat's, or why it can't open (net's chatlink.ts `chatLinkTarget`). */
export type LinkTitle = (url: string) => string;

/** A reply's text with its bare chat links as markdown links labelled with their chat's title (chat.rs `labelled`). */
export function labelLinks(md: string, title: LinkTitle | null): string {
  return title === null || !md.includes(CHAT_SCHEME) ? md : labelChatLinks(md, title);
}

/** What a reply's chat links read as now, for its card's signature: a renamed chat redraws it. */
function linkSig(text: string, title: LinkTitle | null): string {
  if (title === null || !text.includes(CHAT_SCHEME)) return "";
  return chatLinks(text)
    .map(([u]) => title(u))
    .join("|");
}

/** A Discord captcha notice (logic/captchacard.ts `captchaRoles`): the live card, its outcome line, or nothing. */
function captchaCard(d: CardData, c: Extract<Card, { kind: "notice" }>, r: CaptchaRole, gone: CaptchaGone): CardData | null {
  if (r.role === "none") return null;
  const l = noticeLook(c, r);
  if (r.role === "card") return { ...d, kind: "captcha", actions: [], icon: l.glyph, text: captchaText(r.note.guild), label: r.note.guild ?? "", detail: r.note.captcha, result: gone(r.note.captcha) ? "gone" : "" };
  return { ...d, kind: "notice", icon: l.glyph, text: l.text };
}

function cardData(c: Card, seq: number, open: Opened, off: number, mediaOf: MediaOf, captcha?: CaptchaRole, gone: CaptchaGone = () => false, linkTitle: LinkTitle | null = null): CardData | null {
  const at = c.kind === "user" || c.kind === "text" ? c.at : 0;
  const d = { ...blank(seq), actions: c.kind === "user" || c.kind === "text" ? actions(c) : [], time: at > 0 ? clock(at, off) : "", media: mediaOf(c) };
  switch (c.kind) {
    case "hidden":
      return null;
    case "user": {
      // A message of mentions alone has no text line: its bubble is the chips.
      const ps = parts(c.text, c.mentions);
      const body = ps.length === 0 ? [] : [{ kind: "p", text: userText(ps), code: "", level: 0, marker: "", depth: 0, quote: 0, cols: [], rows: 0, gap: 0, after: 0, bar_top: 0, bar_bottom: 0, trim: 0, plain: "", key: "" }];
      return { ...d, kind: "user", blocks: body, text: c.text, ...senderLine(c), joined: c.joined, files: c.files.map(base), steer: c.intent !== "", cites: cites(c.mentions) };
    }
    case "text": {
      const md = labelLinks(stripDrawn(c.text, d.media.filter((m) => m.large).map((m) => m.path)), linkTitle);
      return { ...d, kind: "text", blocks: mdBlocks(md, seq, blockOwner(open, seq)), text: c.text };
    }
    case "thinking":
      return { ...d, kind: "thinking", text: c.text, open: open.cards.has(seq) };
    case "tool": {
      const { glyph, tone } = toolLook(c);
      return { ...d, kind: "tool", label: c.label, text: c.summary, icon: glyph, tone, detail: clip(c.input, TOOL_TEXT_MAX), result: c.result === null ? "" : clip(c.result, RESULT_MAX), open: open.cards.has(seq) };
    }
    case "forked_from":
    case "chat_link": {
      const l = dividerLook(c);
      return { ...d, kind: "divider", icon: l.glyph, text: l.text, label: l.link, url: c.kind === "forked_from" ? `harbor:chat-id/${c.chat}/${c.seq}` : `harbor:chat/${c.gid}` };
    }
    case "notice": {
      if (captcha !== undefined) return captchaCard(d, c, captcha, gone);
      const l = noticeLook(c);
      const opened = l.expandable && open.cards.has(seq);
      return {
        ...d,
        kind: "notice",
        icon: l.glyph,
        text: l.text,
        detail: l.markdown ? "" : clip(c.detail, DETAIL_MAX),
        blocks: opened && l.markdown ? mdBlocks(c.detail, -1, blockOwner(open, seq)) : [],
        expandable: l.expandable,
        open: opened,
        url: l.url ?? "",
      };
    }
    case "message":
      return { ...d, kind: "message", label: `${c.from} → ${c.to}`, text: clip(c.text, DETAIL_MAX) };
    case "error":
      return { ...d, kind: "error", text: clip(c.text, TOOL_TEXT_MAX) };
  }
}

/** Every card the transcript draws, a 24px space at each end and the status line if any. */

function signature(it: Item, open: Opened, seq: number, media: string): string {
  const body = it.kind === "tool" ? `${it.input.length}:${it.result?.length ?? -1}:${it.is_error}` : "text" in it ? String(it.text.length) : "";
  return `${seq}:${body}:${open.cards.has(seq)}:${media}`;
}

export function transcriptCards(items: readonly Item[], lead: boolean, forks: [number, number][], open: Opened, status: string | { text: string; tone: "waiting" }, off = 0, mediaOf: MediaOf = () => [], gone: CaptchaGone = () => false, viewer: Viewer | null = null, linkTitle: LinkTitle | null = null): CardData[] {
  // A copy of another PC's chat: the sender rows are this PC's view of it (senders.ts Viewer).
  const all = project(items, lead, forks, viewer);
  const who = viewer ? `${viewer.dev}|${viewer.label}|${viewer.home.name}|${viewer.home.owner}` : "";
  const captchas = captchaRoles(items);
  const runs = groups(all);
  const visible = all.filter((s) => s.card.kind !== "hidden" && (s.group === null || s.group === s.seq));
  const from = visible.length > open.limit ? (visible[visible.length - open.limit]?.seq ?? 0) : 0;
  const shown = all.filter((s) => s.seq >= from && (s.group === null || s.group >= from));
  const out: CardData[] = [{ ...blank(-1), kind: "space" }];
  const built = new Set<number>();
  if (from > 0) out.push({ ...blank(EARLIER), kind: "earlier", label: `Show earlier messages (${visible.length - open.limit})` });
  const fork = (seq: number, f: number) => out.push({ ...blank(seq), kind: "divider", icon: FORK_DIVIDER.glyph, text: FORK_DIVIDER.text, label: FORK_DIVIDER.link, url: `harbor:chat-id/${f}/0` });
  for (const s of shown) {
    if (s.group !== null) {
      const g = runs.get(s.group) ?? { calls: 0, pending: false };
      const opened = open.groups.has(s.group);
      if (s.group === s.seq) out.push({ ...blank(groupSeq(s.seq)), kind: "group", ...runLook(g), open: opened });
      if (!opened) {
        for (const f of s.forksAfter) fork(s.seq, f);
        continue;
      }
    }
    const item = items[s.seq];
    const media = mediaOf(s.card);
    const cap = captchas.get(s.seq);
    const sig = item ? signature(item, open, s.seq, media.map((m) => m.image.width).join(",")) + (cap ? `:${cap.role}:${gone(cap.note.captcha)}` : "") + (item.kind === "user" ? `:${who}` : "") + (s.card.kind === "text" ? linkSig(s.card.text, linkTitle) : "") : "";
    const hit = open.memo.get(s.seq);
    const same = hit !== undefined && hit.item === item && hit.sig === sig;
    // Built again: its old blocks' keys go first (the new ones are the same where the blocks are).
    if (!same) releaseBlocks(blockOwner(open, s.seq));
    const c = same ? hit.data : cardData(s.card, s.seq, open, off, () => media, cap, gone, linkTitle);
    if (item) {
      open.memo.set(s.seq, same && hit.joins ? { item, sig, data: c, joins: hit.joins } : { item, sig, data: c });
      built.add(s.seq);
    }
    if (c) out.push(c);
    for (const f of s.forksAfter) fork(s.seq, f);
  }
  for (const k of open.memo.keys()) {
    if (built.has(k)) continue;
    open.memo.delete(k);
    releaseBlocks(blockOwner(open, k));
  }
  joinRuns(out, open);
  // "Working… 12s", or (tone "waiting") what wakes the chat once its turn is done: "Waiting · 2 processes".
  if (typeof status !== "string") out.push({ ...blank(-2), kind: "status", text: status.text, tone: status.tone });
  else if (status !== "") out.push({ ...blank(-2), kind: "status", text: status });
  out.push({ ...blank(-3), kind: "space" });
  return out;
}

/** Joined user cards (WhatsApp-style runs): one joins only a user card drawn right above it (not
 * the first card after "Show earlier messages"), and the one above is marked `tight`. */
function joinRuns(out: CardData[], open: Opened): void {
  for (let i = 0; i < out.length; i++) {
    const c = out[i] as CardData;
    if (c.kind !== "user") continue;
    const joined = c.joined && out[i - 1]?.kind === "user";
    const tight = out[i + 1]?.kind === "user" && (out[i + 1] as CardData).joined;
    if (joined === c.joined && tight === c.tight) continue;
    const m = open.memo.get(c.seq);
    if (m?.data !== c) {
      out[i] = { ...c, joined, tight };
      continue;
    }
    if (!m.joins || m.joins.joined !== joined || m.joins.tight !== tight) m.joins = { joined, tight, data: { ...c, joined, tight } };
    out[i] = m.joins.data;
  }
}

/** A run's chevron row stands for the run, not its first card: its own (negative) seq. */
export function groupSeq(first: number): number {
  return -(first + 10);
}

/** Opens or folds what a click on card `seq` toggles: a run's row, a tool call, a notice, thinking. */
export function toggle(open: Opened, seq: number): void {
  if (seq === EARLIER) {
    earlier(open);
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
  /** Its mentions (store's Mention): a message of mentions alone reads as them. */
  mentions?: readonly unknown[];
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
  const label = (m: QueuedView) => (m.text !== "" ? m.text : citesLabel(m.mentions ?? []) || `${m.files} attachment(s)`);
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
