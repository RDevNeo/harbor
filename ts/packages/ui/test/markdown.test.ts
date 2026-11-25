import { expect, test } from "bun:test";
import * as slint from "slint-ui";
import { blocks, escape, inline, linkTip, linkWords, place, plainOf, registerBlock, ROW, selectionAt } from "../src/markdown.ts";
import { mdBlocks, userText } from "../src/cards.ts";

test("paragraphs, headings, breaks and rules", () => {
  expect(blocks("# Title\n\nOne\ntwo  \nthree\n\n---\n\nSub\n---")).toMatchObject([
    { kind: "h", text: "Title", level: 1, quote: 0 },
    { kind: "p", text: "One two\\\nthree", quote: 0 },
    { kind: "hr", quote: 0 },
    { kind: "h", text: "Sub", level: 2, quote: 0 },
  ]);
});

test("code keeps its text and language", () => {
  expect(blocks("Run:\n```bash\nls -la\n\necho hi\n```\nDone")).toMatchObject([
    { kind: "p", text: "Run:", quote: 0 },
    { kind: "code", text: "ls -la\n\necho hi", lang: "bash", quote: 0 },
    { kind: "p", text: "Done", quote: 0 },
  ]);
});

test("lists: bullets, numbers from their start, nesting", () => {
  expect(blocks("- one\n  more\n- two\n  - inner\n\n3. third\n4. fourth")).toMatchObject([
    { kind: "li", text: "one more", marker: "•", depth: 0, quote: 0 },
    { kind: "li", text: "two", marker: "•", depth: 0, quote: 0 },
    { kind: "li", text: "inner", marker: "◦", depth: 1, quote: 0 },
    { kind: "li", text: "third", marker: "3.", depth: 0, quote: 0 },
    { kind: "li", text: "fourth", marker: "4.", depth: 0, quote: 0 },
  ]);
});

test("quotes nest and hold other blocks", () => {
  expect(blocks("> said\n> - a\n>> deeper")).toMatchObject([
    { kind: "p", text: "said", quote: 1 },
    { kind: "li", text: "a", marker: "•", depth: 0, quote: 1 },
    { kind: "p", text: "deeper", quote: 2 },
  ]);
});

test("a table is one block, its header the first row", () => {
  expect(blocks("| a | b |\n|---|:-:|\n| 1 | **2** |")).toMatchObject([{ kind: "table", rows: [["a", "b"], ["1", "2"]], quote: 0 }]);
});

test("spans go back to inline markdown StyledText accepts and reads as the same text", () => {
  const [p] = blocks("**b** _i_ `c` ~~s~~ [l](http://x) <b>h</b> ![im](a.png) a*b `x``y`");
  expect(p?.kind).toBe("p");
  const text = p?.kind === "p" ? p.text : "";
  expect(text).toBe("b *i* `c` ~~s~~ [l](<http://x>) \\<b\\>h\\</b\\> [im](<a.png>) a\\*b ```x``y```");
  expect(() => slint.StyledText.fromMarkdown(text)).not.toThrow();
  expect(inline([{ text: " bold ", bold: true }])).toBe(" bold ");
});

test("escaped text is read back as itself", () => {
  const s = "# not a heading * [x](y) `z` 1. <b>";
  expect(() => slint.StyledText.fromMarkdown(escape(s))).not.toThrow();
  expect(blocks(escape(s))).toMatchObject([{ kind: "p", text: escape(s), quote: 0 }]);
});

const rows = (md: string) => place(blocks(md)).map((p) => [p.gap / ROW, p.after / ROW, p.barTop, p.barBottom]);

test("a row is left empty between blocks, none before the first or inside a list", () => {
  expect(rows("One\n\nTwo\n\n- a\n- b\n\nThree")).toEqual([
    [0, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [0, 0, 0, 0],
    [1, 0, 0, 0],
  ]);
});

test("a heading starts a line even first, and a quote is a frame with an empty row at each end", () => {
  expect(rows("# T\n\nText\n\n> q1\n>\n> q2\n\nEnd")).toEqual([
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [2, 0, ROW + 5, 0],
    [1, 1, 0, 5],
    [1, 0, 0, 0],
  ]);
});

test("a block's plain text and its links by byte offset, for selecting and clicking", () => {
  expect(plainOf([{ text: "Café " }, { text: "docs", link: "https://x.dev" }, { text: " ok", bold: true }])).toEqual({
    plain: "Café docs ok",
    links: [{ from: 6, to: 10, url: "https://x.dev" }],
  });
});

test("a selection in a reply's block reports its item and the text it covers", () => {
  const key = registerBlock("Read the Hub docs", 7);
  expect(selectionAt(`sel:${key}:16:0:298:157`)).toEqual({ seq: 7, text: "Read the Hub ", x: 298, y: 157 });
  expect(selectionAt(`sel:${registerBlock("no item", -1)}:0:2:0:0`)).toBeNull();
  expect(selectionAt("sel:")).toBeNull();
});

test("a link is hit a word at a time, the space to its next word on the line included; inline code is no link", () => {
  const p = plainOf([{ text: "See " }, { text: "the  Café docs", link: "https://x.dev/a" }, { text: " and " }, { text: "http://y.dev", link: "http://y.dev" }, { text: " `z`", code: true }]);
  const at = (s: string) => Buffer.byteLength(p.plain.slice(0, p.plain.indexOf(s)));
  expect(linkWords(p)).toEqual([
    { link: 0, from: at("the"), to: at("the") + 3, next: at("Café"), url: "https://x.dev/a", tip: "https://x.dev/a" },
    { link: 0, from: at("Café"), to: at("Café") + Buffer.byteLength("Café"), next: at("docs"), url: "https://x.dev/a", tip: "https://x.dev/a" },
    { link: 0, from: at("docs"), to: at("docs") + 4, next: at("docs") + 4, url: "https://x.dev/a", tip: "https://x.dev/a" },
    { link: 1, from: at("http"), to: at("http") + 12, next: at("http") + 12, url: "http://y.dev", tip: "" },
  ]);
  expect(linkWords(plainOf([{ text: "`code` only", code: true }]))).toEqual([]);
  expect(linkWords(plainOf([{ text: "  ", link: "https://blank.dev" }]))).toEqual([]);
});

test("a link's tip is its address when its text says something else, for web and mail links only", () => {
  expect(linkTip("docs", "https://x.dev")).toBe("https://x.dev");
  expect(linkTip(" https://x.dev ", "https://x.dev")).toBe("");
  expect(linkTip("me@x.dev", "mailto:me@x.dev")).toBe("");
  expect(linkTip("Fix login", "harbor://chat/g1?pc=desk")).toBe("");
  expect(linkTip("x", `https://x.dev/${"a".repeat(300)}`)).toHaveLength(201);
});

test("every block that draws text carries its links: paragraphs, headings, list items, quotes and table cells", () => {
  const md = "# [Title](https://h.dev)\n\nSee https://p.dev now\n\n- item [l](https://li.dev)\n\n> quoted https://q.dev\n\n| a | b |\n|---|---|\n| [c](https://c.dev) | `https://code.dev` |";
  const bs = mdBlocks(md);
  expect(bs.map((b) => [b.kind, b.links.map((w) => w.url)])).toEqual([
    ["h", ["https://h.dev"]],
    ["p", ["https://p.dev"]],
    ["li", ["https://li.dev"]],
    ["p", ["https://q.dev"]],
    ["table", []],
  ]);
  const cells = bs[4]?.table.map((r) => r.cells.map((x) => [x.plain, x.links.map((w) => w.url)]));
  expect(cells).toEqual([
    [["a", []], ["b", []]],
    [["c", ["https://c.dev"]], ["https://code.dev", []]],
  ]);
});

test("a user's message: a mentioned chat and a bare web address are links, a command only looks like one", () => {
  const u = userText([
    { kind: "command", text: "/review" },
    { kind: "plain", text: " see http://localhost:5173, and (https://no.dev\nnext " },
    { kind: "chat", chat: "g7", text: "Other chat" },
  ]);
  expect(u.plain).toBe("/review see http://localhost:5173, and (https://no.dev\nnext Other chat");
  expect(u.links.map((w) => [w.link, Buffer.from(u.plain).subarray(w.from, w.to).toString(), w.url, w.tip])).toEqual([
    [0, "http://localhost:5173", "http://localhost:5173", ""],
    [1, "Other", "harbor:chat/g7", ""],
    [1, "chat", "harbor:chat/g7", ""],
  ]);
});
