import MarkdownIt from "markdown-it";
import { Ordered, type Json } from "./wire.ts";

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
  /** A commit of the chat's project: the full sha. */
  commit?: string;
}

export type Block =
  | { type: "heading"; level: number; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "quote"; blocks: Block[] }
  | { type: "rule" }
  | { type: "table"; rows: Span[][][] };

type Container = { k: "blocks" | "quote" | "item"; v: Block[] } | { k: "list"; ordered: boolean; start: number; items: Block[][] };

type Inline = "para" | "cell" | { heading: number };

const md = new MarkdownIt({ html: true, linkify: false }).enable(["table", "strikethrough"]);

function sameStyle(a: Span, b: Span): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && !!a.strike === !!b.strike && a.link === b.link && a.commit === b.commit;
}

class Conv {
  stack: Container[] = [{ k: "blocks", v: [] }];
  inline: [Inline, Span[]] | null = null;
  table: Span[][][] | null = null;
  bold = 0;
  italic = 0;
  strike = 0;
  links: string[] = [];

  pushBlock(b: Block): void {
    const top = this.stack.at(-1);
    if (!top) this.stack.push({ k: "blocks", v: [b] });
    else if (top.k === "list") top.items.push([b]);
    else top.v.push(b);
  }

  flush(): void {
    const cur = this.inline;
    if (!cur) return;
    this.inline = null;
    const [kind, spans] = cur;
    if (kind === "cell") {
      this.table?.at(-1)?.push(spans);
      return;
    }
    if (spans.every((s) => s.text.trim() === "")) return;
    if (kind === "para") this.pushBlock({ type: "paragraph", spans });
    else this.pushBlock({ type: "heading", level: kind.heading, spans });
  }

  span(text: string, code: boolean, link?: string): void {
    if (!this.inline) this.inline = ["para", []];
    if (text === "") return;
    const spans = this.inline[1];
    const s: Span = { text };
    if (this.bold > 0) s.bold = true;
    if (this.italic > 0) s.italic = true;
    if (code) s.code = true;
    if (this.strike > 0) s.strike = true;
    const l = link ?? this.links.at(-1);
    if (l !== undefined) s.link = l;
    const last = spans.at(-1);
    if (last && sameStyle(last, s)) last.text += s.text;
    else spans.push(s);
  }

  /** Prose text: bare http(s) URLs become links (chat.rs `linkify`), outside links and code. */
  prose(text: string): void {
    if (this.links.length > 0 || (!text.includes("http://") && !text.includes("https://"))) {
      this.span(text, false);
      return;
    }
    let out = "";
    let rest = text;
    while (rest !== "") {
      const m = rest.search(/https?:\/\//);
      if (m < 0) {
        out += rest;
        break;
      }
      out += rest.slice(0, m);
      rest = rest.slice(m);
      const prev = Array.from(out).at(-1);
      if (prev !== undefined && ("(<[\"'".includes(prev) || /[\p{L}\p{N}]/u.test(prev))) {
        out += rest[0];
        rest = rest.slice(1);
        continue;
      }
      const end = rest.search(/[\s<>"`]/);
      const raw = end < 0 ? rest : rest.slice(0, end);
      const url = raw.replace(/[.,;:!?)'*_]+$/, "");
      if (out !== "") this.span(out, false);
      out = "";
      this.span(url, false, url);
      rest = rest.slice(url.length);
    }
    if (out !== "") this.span(out, false);
  }
}

type Token = ReturnType<typeof md.parse>[number];

function inlines(c: Conv, children: Token[], task: boolean): void {
  let first = task;
  for (const t of children) {
    switch (t.type) {
      case "text": {
        let text = t.content;
        if (first) {
          const m = text.match(/^\[([ xX])\] /);
          if (m) {
            c.span(m[1] === " " ? "☐ " : "☑ ", false);
            text = text.slice(4);
          }
        }
        c.prose(text);
        break;
      }
      case "code_inline":
        c.span(t.content, true);
        break;
      case "softbreak":
        c.span(" ", false);
        break;
      case "hardbreak":
        c.span("\n", false);
        break;
      case "html_inline":
        c.span(t.content, false);
        break;
      case "em_open":
        c.italic += 1;
        break;
      case "em_close":
        c.italic = Math.max(0, c.italic - 1);
        break;
      case "strong_open":
        c.bold += 1;
        break;
      case "strong_close":
        c.bold = Math.max(0, c.bold - 1);
        break;
      case "s_open":
        c.strike += 1;
        break;
      case "s_close":
        c.strike = Math.max(0, c.strike - 1);
        break;
      case "link_open":
        c.links.push(String(t.attrGet("href") ?? ""));
        break;
      case "link_close":
        c.links.pop();
        break;
      case "image":
        c.links.push(String(t.attrGet("src") ?? ""));
        inlines(c, t.children ?? [], false);
        c.links.pop();
        break;
      default:
        if (t.content !== "") c.span(t.content, false);
    }
    first = false;
  }
}

/** Markdown as the block model the phone draws with native views (api.rs `blocks`). */
export function blocks(text: string): Block[] {
  const c = new Conv();
  let itemStart = false;
  for (const t of md.parse(text, {})) {
    switch (t.type) {
      case "paragraph_open":
        c.flush();
        c.inline = ["para", []];
        break;
      case "heading_open":
        c.flush();
        c.inline = [{ heading: Number(t.tag.slice(1)) }, []];
        break;
      case "paragraph_close":
      case "heading_close":
        c.flush();
        break;
      case "inline":
        inlines(c, t.children ?? [], itemStart);
        itemStart = false;
        break;
      case "blockquote_open":
        c.flush();
        c.stack.push({ k: "quote", v: [] });
        break;
      case "blockquote_close": {
        c.flush();
        const q = c.stack.pop();
        if (q?.k === "quote") c.pushBlock({ type: "quote", blocks: q.v });
        break;
      }
      case "fence":
      case "code_block": {
        c.flush();
        const lang = t.type === "fence" ? (t.info.split(/[ ,{]/)[0] ?? "") : "";
        c.pushBlock({ type: "code", lang, text: t.content.endsWith("\n") ? t.content.slice(0, -1) : t.content });
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        c.flush();
        const ordered = t.type === "ordered_list_open";
        const s = Number(t.attrGet("start") ?? "1");
        c.stack.push({ k: "list", ordered, start: ordered && Number.isFinite(s) ? s : 1, items: [] });
        break;
      }
      case "bullet_list_close":
      case "ordered_list_close": {
        c.flush();
        const l = c.stack.pop();
        if (l?.k === "list") c.pushBlock({ type: "list", ordered: l.ordered, start: l.start, items: l.items });
        break;
      }
      case "list_item_open":
        c.flush();
        c.stack.push({ k: "item", v: [] });
        itemStart = true;
        break;
      case "list_item_close": {
        c.flush();
        const it = c.stack.pop();
        if (it?.k === "item") {
          const top = c.stack.at(-1);
          if (top?.k === "list") top.items.push(it.v);
          else for (const b of it.v) c.pushBlock(b);
        }
        break;
      }
      case "table_open":
        c.flush();
        c.table = [];
        break;
      case "tr_open":
        c.table?.push([]);
        break;
      case "th_open":
      case "td_open":
        c.inline = ["cell", []];
        break;
      case "th_close":
      case "td_close":
        c.flush();
        break;
      case "table_close":
        c.flush();
        if (c.table) c.pushBlock({ type: "table", rows: c.table });
        c.table = null;
        break;
      case "hr":
        c.flush();
        c.pushBlock({ type: "rule" });
        break;
      case "html_block":
        c.flush();
        c.inline = ["para", []];
        c.span(t.content, false);
        c.flush();
        break;
      default:
        break;
    }
  }
  c.flush();
  while (c.stack.length > 1) {
    const x = c.stack.pop();
    if (!x) break;
    if (x.k === "quote") c.pushBlock({ type: "quote", blocks: x.v });
    else if (x.k === "list") c.pushBlock({ type: "list", ordered: x.ordered, start: x.start, items: x.items });
    else for (const b of x.v) c.pushBlock(b);
  }
  const root = c.stack.pop();
  return root && root.k === "blocks" ? root.v : [];
}

export function spanJson(s: Span): Ordered {
  const e: [string, Json][] = [["text", s.text]];
  if (s.bold) e.push(["bold", true]);
  if (s.italic) e.push(["italic", true]);
  if (s.code) e.push(["code", true]);
  if (s.strike) e.push(["strike", true]);
  if (s.link !== undefined) e.push(["link", s.link]);
  if (s.commit !== undefined) e.push(["commit", s.commit]);
  return new Ordered(e);
}

/** As serde writes `Block`: the "type" tag first, then the fields in order. */
export function blockJson(b: Block): Ordered {
  switch (b.type) {
    case "heading":
      return new Ordered([["type", "heading"], ["level", b.level], ["spans", b.spans.map(spanJson)]]);
    case "paragraph":
      return new Ordered([["type", "paragraph"], ["spans", b.spans.map(spanJson)]]);
    case "code":
      return new Ordered([["type", "code"], ["lang", b.lang], ["text", b.text]]);
    case "list":
      return new Ordered([["type", "list"], ["ordered", b.ordered], ["start", b.start], ["items", b.items.map((i) => i.map(blockJson))]]);
    case "quote":
      return new Ordered([["type", "quote"], ["blocks", b.blocks.map(blockJson)]]);
    case "rule":
      return new Ordered([["type", "rule"]]);
    case "table":
      return new Ordered([["type", "table"], ["rows", b.rows.map((r) => r.map((cell) => cell.map(spanJson)))]]);
  }
}

/** A commit a reply names, as the phone draws its pill (commits.rs `Commit`). */
export interface CommitRef {
  sha: string;
  short: string;
  subject: string;
  author: string;
  at: number;
}

function split(spans: Span[], commits: Map<string, CommitRef>, tokens: (text: string) => [number, number][]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (s.link !== undefined || s.commit !== undefined) {
      out.push(s);
      continue;
    }
    if (s.code) {
      const c = commits.get(s.text.trim());
      out.push(c ? { ...s, commit: c.sha } : s);
      continue;
    }
    let at = 0;
    for (const [a, b] of tokens(s.text)) {
      const c = commits.get(s.text.slice(a, b));
      if (!c) continue;
      if (a > at) out.push({ ...s, text: s.text.slice(at, a) });
      out.push({ ...s, text: s.text.slice(a, b), commit: c.sha });
      at = b;
    }
    if (at === 0) out.push(s);
    else if (at < s.text.length) out.push({ ...s, text: s.text.slice(at) });
  }
  return out;
}

/** Spans that name a known commit become pills (commits.rs `mark`); code blocks are left alone. */
export function markCommits(blocks: Block[], commits: Map<string, CommitRef>, tokens: (text: string) => [number, number][]): void {
  if (commits.size === 0) return;
  for (const b of blocks) {
    if (b.type === "heading" || b.type === "paragraph") b.spans = split(b.spans, commits, tokens);
    else if (b.type === "list") for (const i of b.items) markCommits(i, commits, tokens);
    else if (b.type === "quote") markCommits(b.blocks, commits, tokens);
    else if (b.type === "table") b.rows = b.rows.map((r) => r.map((cell) => split(cell, commits, tokens)));
  }
}
