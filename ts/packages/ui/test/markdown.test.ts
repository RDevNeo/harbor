import { expect, test } from "bun:test";
import * as slint from "slint-ui";
import { blocks, escape, inline } from "../src/markdown.ts";

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
    { kind: "li", text: "inner", marker: "•", depth: 1, quote: 0 },
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

test("tables become rows, the first one the header", () => {
  expect(blocks("| a | b |\n|---|:-:|\n| 1 | **2** |")).toEqual([
    { kind: "tr", cells: ["a", "b"], header: true, quote: 0 },
    { kind: "tr", cells: ["1", "**2**"], header: false, quote: 0 },
  ]);
});

test("spans go back to inline markdown StyledText accepts and reads as the same text", () => {
  const [p] = blocks("**b** _i_ `c` ~~s~~ [l](http://x) <b>h</b> ![im](a.png) a*b `x``y`");
  expect(p?.kind).toBe("p");
  const text = p?.kind === "p" ? p.text : "";
  expect(text).toBe("**b** *i* `c` ~~s~~ [l](<http://x>) \\<b\\>h\\</b\\> [im](<a.png>) a\\*b ```x``y```");
  expect(() => slint.StyledText.fromMarkdown(text)).not.toThrow();
  expect(inline([{ text: " bold ", bold: true }])).toBe(" **bold** ");
});

test("escaped text is read back as itself", () => {
  const s = "# not a heading * [x](y) `z` 1. <b>";
  expect(() => slint.StyledText.fromMarkdown(escape(s))).not.toThrow();
  expect(blocks(escape(s))).toEqual([{ kind: "p", text: escape(s), quote: 0 }]);
});
