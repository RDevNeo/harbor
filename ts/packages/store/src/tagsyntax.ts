import { charList, isSpace, trimEndChars } from "./chartext.ts";

/** The `@word` or `#word` being typed: its first char, where it is (in chars), and the chars after the trigger up to the cursor. */
export interface TagWord {
  trigger: "@" | "#";
  start: number;
  end: number;
  query: string;
}

const OPENERS = "([{\"'`";
/** What may end a tag written in a sentence. */
export const PUNCT = ",.;:!?)]}\"'`";

/** Whether a tag may start after `prev` (the char before its trigger): at the start, after a space, or an opening bracket or quote. */
export function opens(prev: string | null): boolean {
  return prev === null || isSpace(prev) || OPENERS.includes(prev);
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// Whether the `#` at index `i` of `text` numbers an image ("Image #1", `[Image #1]`): that's no issue or pull request.
function numbersImage(text: string, i: number): boolean {
  const before = trimEndChars(text.slice(0, i), " ");
  const start = before.length - "image".length;
  if (start < 0 || asciiLower(before.slice(start)) !== "image") return false;
  const prev = charList(before.slice(0, start)).pop();
  return prev === undefined || !/^[\p{L}\p{N}]$/u.test(prev);
}

/** The `@word` or `#word` at char `cursor` of `text`, if the cursor is in one. */
export function word(text: string, cursor: number): TagWord | null {
  const cs = charList(text);
  const cur = Math.min(cursor, cs.length);
  let start = 0;
  for (let i = cur - 1; i >= 0; i--) {
    if (isSpace(cs[i])) {
      start = i + 1;
      break;
    }
  }
  // `(@x` and `"#4`: the bracket or quote isn't part of it.
  while (start < cur && OPENERS.includes(cs[start] ?? "")) start++;
  const trigger = cs[start];
  if ((trigger !== "@" && trigger !== "#") || start === cur) return null;
  if (trigger === "#") {
    const before = cs.slice(0, start).join("");
    if (numbersImage(before, before.length)) return null;
  }
  const query = cs.slice(start + 1, cur).join("");
  // `##` (a heading) and `@@` are not tags.
  if (query.startsWith(trigger)) return null;
  let end = cs.length;
  for (let i = cur; i < cs.length; i++) {
    if (isSpace(cs[i])) {
      end = i;
      break;
    }
  }
  return { trigger, start, end, query };
}

/** The tags written in a message: `@path`s and `#numbers`, each once, in order. */
export function tagged(text: string): { files: string[]; numbers: number[] } {
  const files: string[] = [];
  const numbers: number[] = [];
  for (const [i, len] of tokens(text)) {
    const body = text.slice(i + 1, i + len);
    if (text.startsWith("@", i)) {
      if (!files.includes(body)) files.push(body);
    } else {
      const n = Number(body);
      if (Number.isSafeInteger(n) && !numbers.includes(n)) numbers.push(n);
    }
  }
  return { files, numbers };
}

/** The tag tokens of `text`: [offset, length] of each `@x` and `#123` (in UTF-16 units, as `String.slice` takes them), without the punctuation after them, as the composer highlights them. */
export function tokens(text: string): [number, number][] {
  const out: [number, number][] = [];
  let prev: string | null = null;
  let i = 0;
  while (i < text.length) {
    const c = String.fromCodePoint(text.codePointAt(i) ?? 0);
    if ((c === "@" || c === "#") && opens(prev) && !(c === "#" && numbersImage(text, i))) {
      const ws = text.slice(i).search(/\s/u);
      const len = ws < 0 ? text.length - i : ws;
      const body = trimEndChars(text.slice(i + 1, i + len), PUNCT);
      const ok = body !== "" && (c === "@" ? !body.startsWith("@") : /^[0-9]+$/.test(body));
      if (ok) {
        out.push([i, 1 + body.length]);
        const last = charList(text.slice(i + 1, i + len)).pop();
        if (last !== undefined) prev = last;
        i += len;
        continue;
      }
    }
    prev = c;
    i += c.length;
  }
  return out;
}
