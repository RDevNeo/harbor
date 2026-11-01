// The phone's markdown blocks (@harbor/net), flattened into Slint elements; each run of text goes
// back to inline markdown for Slint's StyledText, which renders inline markup only.
import { blocks as netBlocks, type Block as NetBlock, type Span } from "@harbor/net";

/** `item`: inside a list item, after its first line (egui_commonmark starts no line for it). */
export type Block = (
  | { kind: "p"; text: string }
  | { kind: "h"; text: string; level: number }
  | { kind: "li"; text: string; marker: string; depth: number }
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

function flatten(bs: readonly NetBlock[], quote: number, depth: number, out: Block[], item: boolean): void {
  const at = item ? { quote, item: true as const } : { quote };
  for (const b of bs) {
    switch (b.type) {
      case "paragraph":
        out.push({ kind: "p", text: inline(b.spans), ...at });
        break;
      case "heading":
        out.push({ kind: "h", text: inline(b.spans), level: b.level, ...at });
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
          const text = first?.type === "paragraph" ? inline(first.spans) : "";
          out.push({ kind: "li", text, marker, depth, quote });
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
