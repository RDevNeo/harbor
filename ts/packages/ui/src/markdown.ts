// The phone's markdown blocks (@harbor/net), flattened into Slint elements; each run of text goes
// back to inline markdown for Slint's StyledText, which renders inline markup only.
import { blocks as netBlocks, type Block as NetBlock, type Span } from "@harbor/net";
import { ByteLru, stringBytes } from "@harbor/store";

/** `item`: inside a list item, after its first line (egui_commonmark starts no line for it). */
/** A link in a block's plain text, by UTF-8 byte offsets (what Slint's TextInput reports). */
export interface Link {
  from: number;
  to: number;
  url: string;
}

/** `plain`: the text as drawn, for selecting it; `links` within it. */
export type Block = (
  | { kind: "p"; text: string; plain: string; links: Link[] }
  | { kind: "h"; text: string; plain: string; links: Link[]; level: number }
  | { kind: "li"; text: string; plain: string; links: Link[]; marker: string; depth: number }
  | { kind: "code"; text: string; lang: string }
  | { kind: "hr" }
  | { kind: "table"; rows: string[][] }
) & { quote: number; item?: true };

/** `s` as literal text in markdown: every character markdown could read as markup escaped. */
export function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);
}

function code(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** One span as inline markdown; markers hug the text, so spaces at its ends stay outside them. Bold stays
 *  regular, as egui_commonmark draws it (the strong colour, which is the text's). */
function span(s: Span): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text);
  const [lead, body, tail] = [m?.[1] ?? "", m?.[2] ?? s.text, m?.[3] ?? ""];
  if (body === "") return escape(s.text);
  let t = s.code ? code(body) : escape(body).replace(/\n/g, "\\\n");
  if (s.strike) t = `~~${t}~~`;
  if (s.italic) t = `*${t}*`;
  if (s.link !== undefined) t = `[${t}](<${s.link.replace(/[<>]/g, "")}>)`;
  return `${lead}${t}${tail}`;
}

export function inline(spans: readonly Span[]): string {
  return spans.map(span).join("");
}

export function plainOf(spans: readonly Span[]): { plain: string; links: Link[] } {
  let plain = "";
  const links: Link[] = [];
  for (const s of spans) {
    const from = Buffer.byteLength(plain);
    plain += s.text;
    if (s.link !== undefined) links.push({ from, to: Buffer.byteLength(plain), url: s.link });
  }
  return { plain, links };
}

function flatten(bs: readonly NetBlock[], quote: number, depth: number, out: Block[], item: boolean): void {
  const at = item ? { quote, item: true as const } : { quote };
  for (const b of bs) {
    switch (b.type) {
      case "paragraph":
        out.push({ kind: "p", text: inline(b.spans), ...plainOf(b.spans), ...at });
        break;
      case "heading":
        out.push({ kind: "h", text: inline(b.spans), ...plainOf(b.spans), level: b.level, ...at });
        break;
      case "code":
        out.push({ kind: "code", text: b.text, lang: b.lang, ...at });
        break;
      case "rule":
        out.push({ kind: "hr", ...at });
        break;
      case "quote":
        flatten(b.blocks, quote + 1, depth, out, item);
        break;
      case "table":
        out.push({ kind: "table", rows: b.rows.map((row) => row.map(inline)), ...at });
        break;
      case "list":
        b.items.forEach((it, i) => {
          // Nested bullets are hollow (egui_commonmark's `bullet_point_hollow`).
          const marker = b.ordered ? `${b.start + i}.` : depth > 0 ? "◦" : "•";
          const [first, ...rest] = it;
          const spans = first?.type === "paragraph" ? first.spans : [];
          out.push({ kind: "li", text: inline(spans), ...plainOf(spans), marker, depth, quote });
          flatten(first?.type === "paragraph" ? rest : it, quote, depth + 1, out, true);
        });
        break;
    }
  }
}

/** A reply's blocks, quotes and lists flattened with their depth. */
export function blocks(md: string): Block[] {
  const out: Block[] = [];
  flatten(netBlocks(md), 0, 0, out, false);
  return out;
}

/** A body row of a reply: 16px text and egui's 5px item spacing. */
export const ROW = 21;
/** egui_commonmark's quote bar stops this far from its frame's top and bottom. */
const BAR_INSET = 5;

/** Where a block sits: empty space above and below it, and where a quote's bar starts and ends within that. */
export interface Placed {
  gap: number;
  after: number;
  barTop: number;
  barBottom: number;
}

const inList = (b: Block | undefined): boolean => b !== undefined && (b.kind === "li" || b.item === true);

/** egui_commonmark's newlines (parsers/pulldown.rs): a row left empty between blocks, a heading always
 *  after one, none between list items; a quote's frame has an empty row at its top and bottom. */
export function place(bs: readonly Block[]): Placed[] {
  const out = bs.map(() => ({ gap: 0, after: 0, barTop: 0, barBottom: 0 }));
  let first = true;
  let atStart = true;
  let blank = 0;
  const newline = (): void => {
    if (atStart) blank++;
    else atStart = true;
  };
  bs.forEach((b, i) => {
    const at = out[i] as Placed;
    const prev = bs[i - 1];
    const next = bs[i + 1];
    const opens = b.quote > (prev?.quote ?? 0);
    const closes = (next?.quote ?? 0) < b.quote;
    // Inside a quote the end of the reply is still ahead: its blocks end their lines.
    const last = next === undefined && b.quote === 0;
    let outside = 0;
    if (opens) {
      if (!first) newline();
      first = false;
      outside = blank;
    }
    const sameList = inList(prev) && prev?.quote === b.quote;
    if (b.kind === "li") {
      if (sameList || !first) newline();
    } else if (b.item === true) {
      if (b.kind === "code") newline();
    } else if (b.kind === "h" || !first) {
      newline();
    }
    at.gap = blank * ROW;
    if (opens) at.barTop = outside * ROW + BAR_INSET;
    blank = 0;
    atStart = false;
    first = false;
    if (inList(b)) {
      const listGoesOn = inList(next) && next?.quote === b.quote;
      if (!listGoesOn && !last) newline();
    } else if (!last) {
      newline();
    }
    if (closes) {
      at.after = ROW;
      at.barBottom = BAR_INSET;
      atStart = true;
      blank = 0;
    }
  });
  return out;
}

/** A block's text by the key its selectable text reports with: a click ("at:KEY:OFFSET") or a selection
 * ("sel:KEY:FROM:TO"). A transcript card's blocks have an owner (its chat's `Opened` and the card's seq) and a
 * key from their place in the card ("OWNER.INDEX"): building the card again puts the same keys back, and the
 * card leaving the transcript (`releaseBlocks`) takes them out. Other pages' blocks (PRs, issues) get a number.
 * Whatever a missed release leaves behind, the byte budget (an LRU) bounds: before it, every rebuild of a
 * streaming reply added its whole text again, for the life of the process. */
interface Entry {
  links: Link[];
  plain: string;
  seq: number;
  owner: string | null;
}

/** All blocks' text together: a shown chat's cards hold far less, so only a missed release gets evicted. */
export const BLOCKS_BUDGET = 16 * 2 ** 20;
/** One block larger than this isn't clickable or selectable (it still draws). */
export const BLOCK_MAX = 2 ** 20;

const entryBytes = (e: Entry, key: string): number => stringBytes(e.plain) + stringBytes(key) + e.links.reduce((n, l) => n + stringBytes(l.url) + 48, 64);
/** Each owner's keys, so a card's blocks go together. */
const owners = new Map<string, Set<string>>();
const blockTable = new ByteLru<string, Entry>({
  budget: BLOCKS_BUDGET,
  maxEntry: BLOCK_MAX,
  size: entryBytes,
  evicted: (k, e) => unown(k, e.owner),
});
let nextKey = 0;
let scopes = 0;

/** A fresh owner prefix for a chat's or a page's blocks. Counted here, not in cards.ts: this file is shared
 * across hot reloads (hotdev.ts `pin`), so a reloaded cards.ts never hands out a prefix still in use. */
export function blockScope(prefix = ""): string {
  return `${prefix}${++scopes}`;
}

function unown(key: string, owner: string | null): void {
  if (owner === null) return;
  const keys = owners.get(owner);
  keys?.delete(key);
  if (keys?.size === 0) owners.delete(owner);
}

/** A key for a block with links, or one in transcript item `seq` (its text can be mentioned); "" for neither.
 *  `owner`: the card it's in (`releaseBlocks`), `index` its place there. */
export function registerBlock(plain: string, links: Link[], seq: number, owner: string | null = null, index = 0): string {
  if (links.length === 0 && seq < 0) return "";
  const key = owner === null ? String(++nextKey) : `${owner}.${index}`;
  const had = blockTable.peek(key);
  if (had) unown(key, had.owner);
  if (!blockTable.set(key, { links, plain, seq, owner })) return "";
  if (owner !== null) {
    let keys = owners.get(owner);
    if (!keys) owners.set(owner, (keys = new Set()));
    keys.add(key);
  }
  return key;
}

/** The blocks of a card built again or no longer shown: their keys report nothing any more. */
export function releaseBlocks(owner: string): void {
  const keys = owners.get(owner);
  if (!keys) return;
  owners.delete(owner);
  for (const k of keys) blockTable.delete(k);
}

/** How many blocks are kept and the bytes they hold (for tests and measurements). */
export function blockStats(): { blocks: number; bytes: number; owners: number } {
  return { blocks: blockTable.size, bytes: blockTable.bytes, owners: owners.size };
}

const SEL = /^sel:([\w.]+):(\d+):(\d+):(-?[\d.]+):(-?[\d.]+)$/;
const AT = /^at:([\w.]+):(\d+)$/;

/** A selection reported as "sel:KEY:FROM:TO:X:Y" (byte offsets in either order; where its button goes): its item and the text it covers; null when it isn't one. */
export function selectionAt(report: string): { seq: number; text: string; x: number; y: number } | null {
  const m = SEL.exec(report);
  const b = blockTable.get(m?.[1] ?? "");
  if (!m || !b || b.seq < 0) return null;
  const [from, to] = [Number(m[2]), Number(m[3])].sort((x, y) => x - y);
  return { seq: b.seq, text: Buffer.from(b.plain).subarray(from, to).toString(), x: Number(m[4]), y: Number(m[5]) };
}

/** The URL under a click reported as "at:KEY:OFFSET", or null (not one, or not on a link). */
export function linkAt(report: string): string | null {
  const m = AT.exec(report);
  if (!m) return null;
  const at = Number(m[2]);
  return blockTable.get(m[1] ?? "")?.links.find((l) => at >= l.from && at < l.to)?.url ?? null;
}
