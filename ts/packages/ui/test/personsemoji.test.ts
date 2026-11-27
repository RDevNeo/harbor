import { describe, expect, test } from "bun:test";
import { customEmojiUrl, EMOJI_GAP, emojiCategories, emojiRows, inlineLayout, insertAt, isEmoji, jumboEmoji, parseCustom, plainEmoji, searchEmoji } from "../src/tabs/persons/emoji.ts";

const CAT = "<:CatSou:1296274311606435873>";

describe("Discord custom emoji", () => {
  test("parses static and animated emoji between text", () => {
    expect(parseCustom(`hi ${CAT} and <a:party_blob:123456789012345678>!`)).toEqual([
      { kind: "text", text: "hi " },
      { kind: "custom", name: "CatSou", id: "1296274311606435873", animated: false },
      { kind: "text", text: " and " },
      { kind: "custom", name: "party_blob", id: "123456789012345678", animated: true },
      { kind: "text", text: "!" },
    ]);
  });

  test("leaves mentions, channels, timestamps and look-alikes alone", () => {
    for (const t of ["<@1296274311606435873>", "<#1296274311606435873>", "<t:1700000000:R>", "<:short:12>", "a < b > c", "<https://x.com>"]) {
      expect(parseCustom(t)).toEqual([{ kind: "text", text: t }]);
      expect(plainEmoji(t)).toBe(t);
      expect(inlineLayout(t)).toEqual({ text: t, emojis: [] });
    }
  });

  test("CDN url: webp, an animated one as gif", () => {
    expect(customEmojiUrl({ id: "1296274311606435873", animated: false })).toBe("https://cdn.discordapp.com/emojis/1296274311606435873.webp?size=48");
    expect(customEmojiUrl({ id: "1", animated: true }, 96)).toBe("https://cdn.discordapp.com/emojis/1.gif?size=96");
  });

  test("one-line text shows :name:", () => {
    expect(plainEmoji(`ok ${CAT}<a:x_y:123456789012345678>`)).toBe("ok :CatSou::x_y:");
  });

  test("inline layout: gaps in the text, at UTF-8 byte offsets", () => {
    const g = Buffer.byteLength(EMOJI_GAP);
    const lay = inlineLayout(`é ${CAT} 😀${CAT}`);
    expect(lay.text).toBe(`é ${EMOJI_GAP} 😀${EMOJI_GAP}`);
    // "é " is 3 bytes; " 😀" is 5
    expect(lay.emojis.map((e) => [e.name, e.from, e.to])).toEqual([
      ["CatSou", 3, 3 + g],
      ["CatSou", 3 + g + 5, 3 + 2 * g + 5],
    ]);
    const buf = Buffer.from(lay.text);
    for (const e of lay.emojis) expect(buf.subarray(e.from, e.to).toString()).toBe(EMOJI_GAP);
  });
});

describe("jumbo emoji", () => {
  test("1-3 emoji alone are jumbo, custom or unicode", () => {
    expect(jumboEmoji(CAT)).toEqual([{ kind: "custom", name: "CatSou", id: "1296274311606435873", animated: false }]);
    expect(jumboEmoji("😂")).toEqual([{ kind: "unicode", text: "😂" }]);
    expect(jumboEmoji(` 👍🏽 ${CAT}\n❤️ `)?.map((x) => (x.kind === "unicode" ? x.text : x.name))).toEqual(["👍🏽", "CatSou", "❤️"]);
    // one grapheme each: a ZWJ family, a flag, a keycap
    expect(jumboEmoji("👨‍👩‍👧 🇧🇷 1️⃣")?.length).toBe(3);
  });

  test("text, a 4th emoji or text-style symbols are not", () => {
    expect(jumboEmoji("ok 👍")).toBeNull();
    expect(jumboEmoji("😀😀😀😀")).toBeNull();
    expect(jumboEmoji(`${CAT} hi`)).toBeNull();
    expect(jumboEmoji("1")).toBeNull();
    expect(jumboEmoji("©")).toBeNull();
    expect(jumboEmoji("")).toBeNull();
    expect(jumboEmoji("   ")).toBeNull();
  });

  test("isEmoji", () => {
    expect(isEmoji("😀")).toBe(true);
    expect(isEmoji("❤")).toBe(true);
    expect(isEmoji("#️⃣")).toBe(true);
    expect(isEmoji("a")).toBe(false);
    expect(isEmoji("™")).toBe(false);
  });
});

describe("picker", () => {
  test("categories hold every emoji once, with names", () => {
    const cats = emojiCategories();
    expect(cats.map((c) => c.label)).toEqual(["Smileys", "People", "Nature", "Food", "Travel", "Activities", "Objects", "Symbols", "Flags"]);
    const all = cats.flatMap((c) => c.items);
    expect(all.length).toBeGreaterThan(1500);
    expect(new Set(all.map((x) => x.e)).size).toBe(all.length);
    expect(all.every((x) => x.e && x.name)).toBe(true);
    expect(cats[0]!.items[0]).toEqual({ e: "😀", name: "grinning face" });
  });

  test("search by name words, aliases and shortcodes", () => {
    expect(searchEmoji("thumbs up")[0]?.e).toBe("👍");
    expect(searchEmoji(":thumbsup:")[0]?.e).toBe("👍");
    expect(searchEmoji("joy")[0]?.e).toBe("😂");
    expect(searchEmoji("fire")[0]?.e).toBe("🔥");
    expect(searchEmoji("hea").some((x) => x.e === "❤️")).toBe(true);
    expect(searchEmoji("zzzqqq")).toEqual([]);
    expect(searchEmoji("  ")).toEqual([]);
    expect(searchEmoji("face", 5).length).toBe(5);
  });

  test("insertAt puts the emoji at the cursor or over the selection, by bytes", () => {
    expect(insertAt("", 0, 0, "😀")).toEqual({ text: "😀", cursor: 4 });
    expect(insertAt("hello", 5, 5, "👍")).toEqual({ text: "hello👍", cursor: 9 });
    // "olá mundo": á is 2 bytes, so "olá" ends at byte 4
    expect(insertAt("olá mundo", 4, 4, "🎉")).toEqual({ text: "olá🎉 mundo", cursor: 8 });
    // a selection, either way round, is replaced
    expect(insertAt("olá mundo", 10, 5, "🌍")).toEqual({ text: "olá 🌍", cursor: 9 });
    // out of range or inside a character: clamped to a character's edge
    expect(insertAt("ab", 99, 99, "x")).toEqual({ text: "abx", cursor: 3 });
    expect(insertAt("😀", 2, 2, "x")).toEqual({ text: "x😀", cursor: 1 });
  });

  test("rows", () => {
    expect(emojiRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
