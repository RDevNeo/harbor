// The phone's markdown blocks (@harbor/net), flattened into Slint elements; each run of text goes
// back to inline markdown for Slint's StyledText, which renders inline markup only.
import { blocks as netBlocks, type Block as NetBlock, type Span } from "@harbor/net";

export type Block =
  | { kind: "p"; text: string; quote: number }
  | { kind: "h"; text: string; level: number; quote: number }
  | { kind: "li"; text: string; marker: string; depth: number; quote: number }
  | { kind: "code"; text: string; lang: string; quote: number }
  | { kind: "hr"; quote: number }
  | { kind: "tr"; cells: string[]; header: boolean; quote: number };

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

/** One span as inline markdown; markers hug the text, so spaces at its ends stay outside them. */
function span(s: Span): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text);
  const [lead, body, tail] = [m?.[1] ?? "", m?.[2] ?? s.text, m?.[3] ?? ""];
  if (body === "") return escape(s.text);
  let t = s.code ? code(body) : escape(body).replace(/\n/g, "\\\n");
  if (s.strike) t = `~~${t}~~`;
  if (s.italic) t = `*${t}*`;
  if (s.bold) t = `**${t}**`;
  if (s.link !== undefined) t = `[${t}](<${s.link.replace(/[<>]/g, "")}>)`;
  return `${lead}${t}${tail}`;
}

export function inline(spans: readonly Span[]): string {
  return spans.map(span).join("");
}

function flatten(bs: readonly NetBlock[], quote: number, depth: number, out: Block[]): void {
  for (const b of bs) {
    switch (b.type) {
      case "paragraph":
        out.push({ kind: "p", text: inline(b.spans), quote });
        break;
      case "heading":
        out.push({ kind: "h", text: inline(b.spans), level: b.level, quote });
        break;
      case "code":
        out.push({ kind: "code", text: b.text, lang: b.lang, quote });
        break;
      case "rule":
        out.push({ kind: "hr", quote });
        break;
      case "quote":
        flatten(b.blocks, quote + 1, depth, out);
        break;
      case "table":
        b.rows.forEach((row, i) => out.push({ kind: "tr", cells: row.map(inline), header: i === 0, quote }));
        break;
      case "list":
        b.items.forEach((item, i) => {
          const marker = b.ordered ? `${b.start + i}.` : "•";
          const [first, ...rest] = item;
          if (first?.type === "paragraph") {
            out.push({ kind: "li", text: inline(first.spans), marker, depth, quote });
            flatten(rest, quote, depth + 1, out);
          } else {
            out.push({ kind: "li", text: "", marker, depth, quote });
            flatten(item, quote, depth + 1, out);
          }
        });
        break;
    }
  }
}

/** A reply's blocks, quotes and lists flattened with their depth. */
export function blocks(md: string): Block[] {
  const out: Block[] = [];
  flatten(netBlocks(md), 0, 0, out);
  return out;
}
