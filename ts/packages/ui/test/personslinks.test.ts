import { describe, expect, test } from "bun:test";
import { linkedMarkdown, messageLinks, trimUrl, urlLinks } from "../src/tabs/persons/links.ts";
import { CHAT_PAGE, shownFor } from "../src/tabs/persons/view.ts";

const HQ = "https://dwdt3bzbd477.fagner-hq.site/__hq/enter?t=abc123&to=%2Fpreview%2F1";
const at = (text: string, url: string): number => Buffer.byteLength(text.slice(0, text.indexOf(url)));

describe("urlLinks", () => {
  test("the whole address, query included", () => {
    const text = `Abre aqui: ${HQ}`;
    expect(urlLinks(text)).toEqual([{ from: at(text, HQ), to: at(text, HQ) + HQ.length, url: HQ }]);
  });

  test("punctuation after it is the sentence's", () => {
    expect(urlLinks("see https://a.b/c.").map((l) => l.url)).toEqual(["https://a.b/c"]);
    expect(urlLinks("(see https://a.b/c), ok?").map((l) => l.url)).toEqual(["https://a.b/c"]);
    expect(urlLinks("é https://a.b/c!?").map((l) => l.url)).toEqual(["https://a.b/c"]);
    expect(urlLinks("wiki https://en.wikipedia.org/wiki/Foo_(bar).").map((l) => l.url)).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });

  test("several, http and https, byte offsets past non-ASCII text", () => {
    const text = "olá 👋 http://x.io/a\nhttps://y.io/b?c=1";
    const ls = urlLinks(text);
    expect(ls.map((l) => l.url)).toEqual(["http://x.io/a", "https://y.io/b?c=1"]);
    const bytes = Buffer.from(text);
    for (const l of ls) expect(bytes.subarray(l.from, l.to).toString()).toBe(l.url);
  });

  test("no address, or nothing after the scheme", () => {
    expect(urlLinks("no links here, www.example.com")).toEqual([]);
    expect(urlLinks("https:// nope")).toEqual([]);
  });

  test("trimUrl keeps a balanced bracket", () => {
    expect(trimUrl("https://a.b/(x)")).toBe("https://a.b/(x)");
    expect(trimUrl("https://a.b/x)")).toBe("https://a.b/x");
  });
});

describe("messageLinks", () => {
  test("words of the address, for the link layer", () => {
    const m = messageLinks(`go ${HQ}`);
    expect(m.links).toHaveLength(1);
    expect(m.links[0]).toMatchObject({ link: 0, url: HQ, from: 3, to: 3 + HQ.length });
  });

  test("none without an address", () => {
    expect(messageLinks("hello")).toEqual({ links: [], markdown: "" });
  });

  test("markdown keeps the text literal and its line breaks", () => {
    const text = "*not bold* & 1. x\nnext https://a.b/c_d";
    const md = linkedMarkdown(text, urlLinks(text));
    expect(md).toBe("\\*not bold\\* \\& 1\\. x\\\nnext [https://a\\.b/c\\_d](<https://a.b/c_d>)");
  });
});

describe("shownFor", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}` }));

  test("a row already drawn changes nothing", () => {
    expect(shownFor(rows, "m190", CHAT_PAGE)).toBe(CHAT_PAGE);
  });

  test("an older row: drawn with a few above it", () => {
    expect(shownFor(rows, "m100", CHAT_PAGE)).toBe(108);
    expect(shownFor(rows, "m2", CHAT_PAGE)).toBe(200);
  });

  test("an unknown row changes nothing", () => {
    expect(shownFor(rows, "x", 60)).toBe(60);
  });
});
