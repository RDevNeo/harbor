import { expect, test } from "bun:test";
import * as slint from "slint-ui";
import { blocks, escape, inline, place, ROW } from "../src/markdown.ts";

test("paragraphs, headings, breaks and rules", () => {
  expect(blocks("# Title\n\nOne\ntwo  \nthree\n\n---\n\nSub\n---")).toEqual([
    { kind: "h", text: "Title", level: 1, quote: 0 },
    { kind: "p", text: "One two\\\nthree", quote: 0 },
    { kind: "hr", quote: 0 },
    { kind: "h", text: "Sub", level: 2, quote: 0 },
  ]);
});

test("code keeps its text and language", () => {
  expect(blocks("Run:\n```bash\nls -la\n\necho hi\n```\nDone")).toEqual([
    { kind: "p", text: "Run:", quote: 0 },
    { kind: "code", text: "ls -la\n\necho hi", lang: "bash", quote: 0 },
    { kind: "p", text: "Done", quote: 0 },
  ]);
});

test("lists: bullets, numbers from their start, nesting", () => {
  expect(blocks("- one\n  more\n- two\n  - inner\n\n3. third\n4. fourth")).toEqual([
    { kind: "li", text: "one more", marker: "•", depth: 0, quote: 0 },
    { kind: "li", text: "two", marker: "•", depth: 0, quote: 0 },
    { kind: "li", text: "inner", marker: "◦", depth: 1, quote: 0 },
    { kind: "li", text: "third", marker: "3.", depth: 0, quote: 0 },
    { kind: "li", text: "fourth", marker: "4.", depth: 0, quote: 0 },
  ]);
});

test("quotes nest and hold other blocks", () => {
  expect(blocks("> said\n> - a\n>> deeper")).toEqual([
    { kind: "p", text: "said", quote: 1 },
    { kind: "li", text: "a", marker: "•", depth: 0, quote: 1 },
    { kind: "p", text: "deeper", quote: 2 },
  ]);
});

test("a table is one block, its header the first row", () => {
  expect(blocks("| a | b |\n|---|:-:|\n| 1 | **2** |")).toEqual([{ kind: "table", rows: [["a", "b"], ["1", "2"]], quote: 0 }]);
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
  expect(blocks(escape(s))).toEqual([{ kind: "p", text: escape(s), quote: 0 }]);
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
