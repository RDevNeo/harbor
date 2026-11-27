// Emoji in Persons' chats, pure parts (unit tested): Discord's custom emoji (`<:name:id>`, animated `<a:name:id>`) as
// pictures inside the text, a message of nothing but 1-3 emoji drawn big (Discord's "jumbo"), and the composer's emoji
// picker (categories, search, insertion at the cursor by the field's UTF-8 byte offsets).
import { EMOJI_CATEGORIES } from "./emojidata.ts";

export interface CustomEmoji {
  name: string;
  id: string;
  animated: boolean;
}

export type EmojiToken = { kind: "text"; text: string } | ({ kind: "custom" } & CustomEmoji);

/** Discord's custom emoji markup: names are 2-32 of [A-Za-z0-9_] (old ones may hold ~), ids are snowflakes. */
const CUSTOM = /<(a?):([\w~]{1,32}):(\d{15,21})>/g;

/** The text split into plain runs and custom emoji. */
export function parseCustom(text: string): EmojiToken[] {
  const out: EmojiToken[] = [];
  let last = 0;
  for (const m of text.matchAll(CUSTOM)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push({ kind: "custom", name: m[2]!, id: m[3]!, animated: m[1] === "a" });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export const hasCustom = (text: string): boolean => text.includes("<") && new RegExp(CUSTOM.source).test(text);

/** The emoji's picture on Discord's CDN (an animated one as its GIF: the PC draws its first frame). */
export function customEmojiUrl(e: Pick<CustomEmoji, "id" | "animated">, size = 48): string {
  return `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=${size}`;
}

/** One-line text (reply quotes, previews): each custom emoji as `:name:`. */
export function plainEmoji(text: string): string {
  return text.includes("<") ? text.replace(CUSTOM, (_, _a: string, name: string) => `:${name}:`) : text;
}

const PICTO = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One grapheme that is an emoji (a ZWJ sequence, a flag, a keycap, a skin-toned hand… counts as one). */
export function isEmoji(g: string): boolean {
  // ©, ®, ™, a bare digit and the like are pictographic or keycap bases but drawn as text unless they ask for emoji
  // presentation (U+FE0F); the dingbats (❤, ☀, ✌…) count bare too, as Discord draws them
  return PICTO.test(g) && /\p{Emoji_Presentation}|️|⃣|^[☀-➿]/u.test(g);
}

export type JumboItem = { kind: "unicode"; text: string } | ({ kind: "custom" } & CustomEmoji);

/** A message of nothing but 1-`max` emoji (spaces between allowed): the emoji, drawn big; otherwise null. */
export function jumboEmoji(text: string, max = 3): JumboItem[] | null {
  if (!text.trim() || text.length > 400) return null;
  const out: JumboItem[] = [];
  for (const t of parseCustom(text)) {
    if (t.kind === "custom") {
      out.push(t);
    } else {
      for (const { segment } of segmenter.segment(t.text)) {
        if (/^\s+$/u.test(segment)) continue;
        if (!isEmoji(segment)) return null;
        out.push({ kind: "unicode", text: segment });
      }
    }
    if (out.length > max) return null;
  }
  return out.length ? out : null;
}

/** What stands in a custom emoji's place in the drawn text: no-break spaces about as wide as the picture, so the
 *  line wraps around it like a word (and never between its spaces). */
export const EMOJI_GAP = "     ";

export interface InlineEmoji extends CustomEmoji {
  /** Where its gap is in the drawn text, in UTF-8 bytes (Slint's text offsets). */
  from: number;
  to: number;
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** The text as drawn, each custom emoji replaced by EMOJI_GAP, and where each one's picture goes. */
export function inlineLayout(text: string, gap = EMOJI_GAP): { text: string; emojis: InlineEmoji[] } {
  if (!hasCustom(text)) return { text, emojis: [] };
  let out = "";
  let at = 0;
  const emojis: InlineEmoji[] = [];
  const g = bytes(gap);
  for (const t of parseCustom(text)) {
    if (t.kind === "text") {
      out += t.text;
      at += bytes(t.text);
    } else {
      emojis.push({ name: t.name, id: t.id, animated: t.animated, from: at, to: at + g });
      out += gap;
      at += g;
    }
  }
  return { text: out, emojis };
}

// ---------- the composer's picker ----------

export interface EmojiEntry {
  e: string;
  name: string;
}
export interface EmojiCategory {
  label: string;
  icon: string;
  items: EmojiEntry[];
}

/** Names people type for some emoji (Discord's and Slack's shortcodes) besides Unicode's. */
const ALIASES: Record<string, string> = {
  "👍": "thumbsup +1 like yes",
  "👎": "thumbsdown -1 no",
  "😂": "joy lol haha",
  "🤣": "rofl lmao",
  "😭": "sob cry",
  "❤️": "love",
  "🙏": "pray please thanks",
  "😅": "sweat_smile",
  "😊": "blush",
  "🙂": "smile",
  "😉": "wink",
  "😍": "heart_eyes love",
  "🥰": "love",
  "🤔": "thinking hmm",
  "🎉": "tada party congrats",
  "✅": "check done ok",
  "👋": "wave hi hello bye",
  "💀": "dead lol",
  "🔥": "lit",
  "👏": "clap",
  "😎": "cool sunglasses",
  "🤝": "deal handshake",
  "💸": "money",
  "💰": "money",
  "🚀": "launch ship",
  "😢": "sad",
};

let cats: EmojiCategory[] | null = null;
/** The picker's categories (Unicode's groups, Emoji 15.0 and older), parsed once. */
export function emojiCategories(): EmojiCategory[] {
  cats ??= EMOJI_CATEGORIES.map((c) => ({
    label: c.label,
    icon: c.icon,
    items: c.list.split("\n").map((line) => {
      const [e = "", name = ""] = line.split("\t");
      return { e, name };
    }),
  }));
  return cats;
}

/** Emoji whose name (or alias) has every word of `q` starting one of its words, best first: the name or an alias itself,
 *  then whole words before prefixes, then shorter names, then Unicode's order. */
export function searchEmoji(q: string, limit = 96): EmojiEntry[] {
  const words = q.toLowerCase().replace(/^:|:$/g, "").split(/[\s_]+/).filter(Boolean);
  if (!words.length) return [];
  const hits: { x: EmojiEntry; score: number; order: number }[] = [];
  let order = 0;
  for (const c of emojiCategories()) {
    for (const x of c.items) {
      order++;
      const alias = ALIASES[x.e] ?? "";
      const hay = `${x.name} ${alias}`.toLowerCase().split(/[\s_:,.“”'’-]+/).filter(Boolean);
      const whole = words.join(" ");
      let score = x.name.toLowerCase() === whole || alias.split(" ").includes(words.join("_")) || (words.length === 1 && alias.split(" ").includes(whole)) ? 100 : 0;
      let ok = true;
      for (const w of words) {
        if (hay.includes(w)) score += 2;
        else if (hay.some((h) => h.startsWith(w))) score += 1;
        else {
          ok = false;
          break;
        }
      }
      if (ok) hits.push({ x, score: score * 1000 - x.name.length, order });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.slice(0, limit).map((h) => h.x);
}

/** `text` with `ins` put at the field's selection (UTF-8 byte offsets `anchor`..`cursor`, either way round), replacing
 *  what was selected; the new text and the byte offset just after what went in (where the cursor goes). */
export function insertAt(text: string, anchor: number, cursor: number, ins: string): { text: string; cursor: number } {
  const buf = Buffer.from(text, "utf8");
  const clamp = (n: number): number => Math.max(0, Math.min(buf.length, Math.floor(Number.isFinite(n) ? n : buf.length)));
  let a = clamp(Math.min(anchor, cursor));
  let b = clamp(Math.max(anchor, cursor));
  // never inside a character (a continuation byte is 10xxxxxx)
  while (a > 0 && a < buf.length && (buf[a]! & 0xc0) === 0x80) a--;
  if (anchor === cursor) b = a;
  while (b < buf.length && (buf[b]! & 0xc0) === 0x80) b++;
  const head = buf.subarray(0, a).toString("utf8");
  const out = head + ins + buf.subarray(b).toString("utf8");
  return { text: out, cursor: bytes(head + ins) };
}

/** Rows of `cols` for the picker's grid. */
export function emojiRows<T>(items: readonly T[], cols: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows;
}
