import { describe, expect, test } from "bun:test";
import { blockJson, blocks, type Block, type Span } from "../src/markdown.ts";
import { wire } from "../src/wire.ts";

const s = (text: string, more: Partial<Span> = {}): Span => ({ text, ...more });

function para(b: Block | undefined): Span[] {
  if (b?.type !== "paragraph") throw new Error(`not a paragraph: ${JSON.stringify(b)}`);
  return b.spans;
}

describe("markdown → blocks (api.rs)", () => {
  test("block_model", () => {
    const b = blocks("# Title\n\nSome **bold** and *it* and `code` and [a link](https://x.y).\n\n---\n\n```rust\nfn main() {}\n```\n");
    expect(b[0]).toEqual({ type: "heading", level: 1, spans: [s("Title")] });
    const spans = para(b[1]);
    expect(spans[0]).toEqual(s("Some "));
    expect(spans[1]).toEqual(s("bold", { bold: true }));
    expect(spans[3]).toEqual(s("it", { italic: true }));
    expect(spans[5]).toEqual(s("code", { code: true }));
    expect(spans[7]).toEqual(s("a link", { link: "https://x.y" }));
    expect(b[2]).toEqual({ type: "rule" });
    expect(b[3]).toEqual({ type: "code", lang: "rust", text: "fn main() {}" });
  });

  test("blocks_linkify_bare_web_urls", () => {
    const spans = para(blocks("See https://example.com/path, http://example.org. [named](https://example.net) and ftp://example.com.")[0]);
    const linked = spans.filter((x) => x.link !== undefined).map((x) => [x.text, x.link]);
    expect(linked).toEqual([
      ["https://example.com/path", "https://example.com/path"],
      ["http://example.org", "http://example.org"],
      ["named", "https://example.net"],
    ]);
    expect(spans.some((x) => x.text.includes("ftp://example.com") && x.link === undefined)).toBe(true);
    expect(para(blocks("Open https://example.com/path")[0])[1]?.link).toBe("https://example.com/path");
  });

  test("blocks_linkify_preserves_code_and_existing_links", () => {
    const md =
      "`https://inline.example`\n\n```text\nhttps://fenced.example\n```\n\n~~~\nhttps://tilde.example\n~~~\n\n    https://indented.example\n\n[https://label.example](https://target.example) <https://auto.example>";
    const b = blocks(md);
    expect(b[0]).toEqual({ type: "paragraph", spans: [s("https://inline.example", { code: true })] });
    for (const [i, host] of [
      [1, "fenced"],
      [2, "tilde"],
      [3, "indented"],
    ] as const) {
      const c = b[i];
      expect(c?.type === "code" ? c.text : null).toBe(`https://${host}.example`);
    }
    const spans = para(b[4]);
    expect(spans[0]?.link).toBe("https://target.example");
    expect(spans[2]?.link).toBe("https://auto.example");
    const b2 = blocks("```\n` https://code.example\n```\n\nhttps://prose.example");
    expect(b2[0]).toEqual({ type: "code", lang: "", text: "` https://code.example" });
    expect(para(b2[1])[0]).toEqual(s("https://prose.example", { link: "https://prose.example" }));
  });

  test("block_lists_quotes_tables", () => {
    const b = blocks("- one\n- two\n  1. a\n  2. b\n\n> quoted\n> more\n\n| A | B |\n|---|---|\n| 1 | **2** |\n");
    const l = b[0];
    if (l?.type !== "list" || l.ordered) throw new Error(JSON.stringify(b));
    expect(l.items).toHaveLength(2);
    expect(l.items[0]).toEqual([{ type: "paragraph", spans: [s("one")] }]);
    expect(l.items[1]?.[0]).toEqual({ type: "paragraph", spans: [s("two")] });
    const sub = l.items[1]?.[1];
    expect(sub?.type === "list" && sub.ordered && sub.start === 1 && sub.items.length === 2).toBe(true);
    expect(b[1]).toEqual({ type: "quote", blocks: [{ type: "paragraph", spans: [s("quoted more")] }] });
    const t = b[2];
    if (t?.type !== "table") throw new Error(JSON.stringify(b));
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toEqual([[s("A")], [s("B")]]);
    expect(t.rows[1]?.[1]).toEqual([s("2", { bold: true })]);
    const b2 = blocks("3. x\n4. y\n\n- [x] done\n");
    expect(b2[0]?.type === "list" && b2[0].ordered && b2[0].start === 3).toBe(true);
    const l2 = b2[1];
    expect(l2?.type === "list" ? l2.items[0] : null).toEqual([{ type: "paragraph", spans: [s("☑ done")] }]);
    expect(wire(blocks("**b**").map(blockJson))).toBe('[{"type":"paragraph","spans":[{"text":"b","bold":true}]}]');
    expect(wire(blockJson({ type: "rule" }))).toBe('{"type":"rule"}');
    expect(blocks("")).toEqual([]);
  });
});
