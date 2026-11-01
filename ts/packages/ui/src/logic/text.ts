// String helpers with Rust's `str` behaviour: counts in chars (code points), Unicode whitespace.

/** Whether `c` (one char) is whitespace. */
export function isSpace(c: string | undefined): boolean {
  return c !== undefined && /^\s$/u.test(c);
}

/** Whether `c` (one char) is a letter or a digit, in any script. */
export function isAlnum(c: string | undefined): boolean {
  return c !== undefined && /^[\p{L}\p{N}]$/u.test(c);
}

export function isAsciiAlpha(c: string | undefined): boolean {
  return c !== undefined && /^[A-Za-z]$/.test(c);
}

export function isAsciiDigit(c: string | undefined): boolean {
  return c !== undefined && /^[0-9]$/.test(c);
}

/** Each char (code point) of `s` with its UTF-16 index, as `char_indices` gives them. */
export function chars(s: string): [number, string][] {
  const out: [number, string][] = [];
  let i = 0;
  for (const c of s) {
    out.push([i, c]);
    i += c.length;
  }
  return out;
}

/** The chars (code points) of `s`. */
export function charList(s: string): string[] {
  return Array.from(s);
}

/** The last char of `s`, if any. */
export function lastChar(s: string): string | undefined {
  const cp = s.codePointAt(s.length - 1);
  if (cp === undefined) return undefined;
  const low = cp >= 0xdc00 && cp <= 0xdfff && s.length >= 2;
  return low ? String.fromCodePoint(s.codePointAt(s.length - 2) ?? cp) : String.fromCodePoint(cp);
}

/** The UTF-16 index of the first char at or after `from` that `pred` accepts; -1 if none. */
export function findChar(s: string, pred: (c: string) => boolean, from = 0): number {
  let i = from;
  while (i < s.length) {
    const c = String.fromCodePoint(s.codePointAt(i) ?? 0);
    if (pred(c)) return i;
    i += c.length;
  }
  return -1;
}

export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** The first `n` chars of `s`. */
export function takeChars(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = "";
  let i = 0;
  for (const c of s) {
    if (i++ >= n) break;
    out += c;
  }
  return out;
}

/** Rust's `str::trim`: Unicode whitespace off both ends. */
export function trim(s: string): string {
  return s.replace(/^\s+|\s+$/gu, "");
}

/** Rust's `str::trim_end`. */
export function trimEnd(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Rust's `str::lines`: split on `\n`, a `\r` before it dropped, no empty last line. */
export function lines(s: string): string[] {
  if (s === "") return [];
  const v = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (s.endsWith("\n")) v.pop();
  return v;
}

/** Rust's `str::split_whitespace`. */
export function words(s: string): string[] {
  return s.split(/\s+/u).filter((w) => w !== "");
}

/** `s` without any of `set`'s chars (one-unit chars, as a string or a list) at its end. */
export function trimEndChars(s: string, set: string | readonly string[]): string {
  let end = s.length;
  while (end > 0 && set.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

/** `s` without any of `set`'s chars (one-unit chars, as a string or a list) at its start. */
export function trimStartChars(s: string, set: string | readonly string[]): string {
  let start = 0;
  while (start < s.length && set.includes(s.charAt(start))) start++;
  return s.slice(start);
}

/** Where `q` occurs in `hay`, left to right, without overlaps (Rust's `match_indices`). */
export function matchIndices(hay: string, q: string): number[] {
  const out: number[] = [];
  if (q === "") return out;
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) out.push(i);
  return out;
}

/** String order (Rust's byte order outside the astral planes). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `v` if it is one of `of`, typed as that member. */
export const pick = <T extends string>(v: string, of: readonly T[]): T | undefined => of.find((x) => x === v);
