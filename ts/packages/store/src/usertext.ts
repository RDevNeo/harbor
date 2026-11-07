// Offsets and cursors here are string indices (UTF-16), where the Rust has bytes and chars.
import { isImage } from "./imagefile.ts";
import { PUNCT, opens, tokens } from "./tagsyntax.ts";
import { chars, charCount, findChar, isAsciiAlpha, isAsciiDigit, isSpace, lastChar, matchIndices, takeChars, trim, trimEnd, trimEndChars, trimStartChars } from "./chartext.ts";

/** The fields of a store `Mention` this module reads. */
export interface MentionLike {
  kind: string;
  chat: string;
  title: string;
  note: string;
}

export type Kind =
  | { kind: "plain" }
  | { kind: "tag" }
  | { kind: "command" }
  | { kind: "chat"; chat: string }
  | { kind: "image"; image: number };

export type Part = Kind & { text: string };

/** A marked run of a text: [start, end) and what it is. */
export interface Run {
  start: number;
  end: number;
  kind: Kind;
}

/** A part as the phone gets it (`parts` of a user card). */
export type WirePart =
  | { text: string }
  | { text: string; kind: "tag" | "command" }
  | { text: string; kind: "chat"; chat: string }
  | { text: string; kind: "image"; image: number };

const PLAIN: Kind = { kind: "plain" };

export function sameKind(a: Kind, b: Kind): boolean {
  if (a.kind === "chat" && b.kind === "chat") return a.chat === b.chat;
  if (a.kind === "image" && b.kind === "image") return a.image === b.image;
  return a.kind === b.kind;
}

function isChat(m: MentionLike): boolean {
  return m.kind === "chat";
}


/** Most of a chat's title the composer writes for its mention, in characters. */
export const LABEL_CHARS = 60;

/** What the composer writes for a mentioned chat: its title, a long one cut. */
export function label(title: string): string {
  const t = trim(title);
  if (charCount(t) <= LABEL_CHARS) return t;
  return `${trimEnd(takeChars(t, LABEL_CHARS - 1))}…`;
}

/** The `/command` tokens of `text`: [index, length], the punctuation after them left out. */
export function commands(text: string): [number, number][] {
  const out: [number, number][] = [];
  let prev: string | null = null;
  let skipTo = 0;
  for (const [i, c] of chars(text)) {
    if (i < skipTo) {
      prev = c;
      continue;
    }
    if (c === "/" && opens(prev)) {
      const ws = findChar(text, isSpace, i);
      const end = ws < 0 ? text.length : ws;
      const body = trimEndChars(text.slice(i + 1, end), PUNCT);
      const ok = isAsciiAlpha(body[0]) && [...body].every((x) => isAsciiAlpha(x) || isAsciiDigit(x) || x === "-" || x === "_" || x === ":");
      if (ok) out.push([i, 1 + body.length]);
      // The rest of the word is no command either (`/tmp/x`).
      skipTo = end;
    }
    prev = c;
  }
  return out;
}

/** The marked runs of `text`, in order and apart: each of `titles` ([title, global id], longer first), then images, tags and commands outside them. */
export function runs(text: string, titles: readonly (readonly [string, string])[]): Run[] {
  const out: Run[] = [];
  const free = (a: number, z: number) => !out.some((r) => a < r.end && r.start < z);
  const byLen = titles.filter(([t]) => trim(t) !== "").sort((a, b) => b[0].length - a[0].length);
  for (const [title, gid] of byLen) {
    for (const i of matchIndices(text, title)) {
      if (free(i, i + title.length)) out.push({ start: i, end: i + title.length, kind: { kind: "chat", chat: gid } });
    }
  }
  const rest: Run[] = [
    ...images(text).map(([a, z, n]): Run => ({ start: a, end: z, kind: { kind: "image", image: n } })),
    ...tokens(text).map(([i, n]): Run => ({ start: i, end: i + n, kind: { kind: "tag" } })),
    ...commands(text).map(([i, n]): Run => ({ start: i, end: i + n, kind: { kind: "command" } })),
  ];
  for (const r of rest) if (free(r.start, r.end)) out.push(r);
  return out.sort((a, b) => a.start - b.start);
}

/** The chats `mentions` names: [title, global id]. */
export function chatTitles(mentions: readonly MentionLike[]): [string, string][] {
  return mentions.filter((m) => isChat(m) && trim(m.title) !== "").map((m) => [m.title, m.chat]);
}

function push(out: Part[], s: string, kind: Kind): void {
  if (s === "") return;
  const last = out[out.length - 1];
  if (last && last.kind === "plain" && kind.kind === "plain") last.text += s;
  else out.push({ ...kind, text: s });
}

/** The message as it reads: its text in runs, an older message's mentioned chats (not written in it) on lines of their own first. */
export function parts(text: string, mentions: readonly MentionLike[]): Part[] {
  const rs = runs(text, chatTitles(mentions));
  const out: Part[] = [];
  for (const m of mentions.filter(isChat)) {
    if (rs.some((r) => r.kind.kind === "chat" && r.kind.chat === m.chat)) continue;
    const title = trim(m.title) === "" ? "a chat" : trim(m.title);
    out.push({ kind: "chat", chat: m.chat, text: title });
    const note = trim(m.note);
    const tail = note === "" ? "" : ` — ${note}`;
    if (text !== "" || tail !== "") push(out, `${tail}\n`, PLAIN);
  }
  let at = 0;
  for (const r of rs) {
    push(out, text.slice(at, r.start), PLAIN);
    push(out, text.slice(r.start, r.end), r.kind);
    at = r.end;
  }
  push(out, text.slice(at), PLAIN);
  // A trailing newline after the last prefix line with no text after it.
  const last = out[out.length - 1];
  if (last && last.kind === "plain" && text === "") last.text = last.text.replace(/\n+$/, "");
  return out.filter((p) => p.text !== "");
}

export function plain(ps: readonly Part[]): boolean {
  return ps.every((p) => p.kind === "plain");
}

export function display(ps: readonly Part[]): string {
  return ps.map((p) => p.text).join("");
}

/** The composer's mentions as the message keeps them: a chat whose title was taken out of the text is no longer mentioned. */
export function kept<M extends MentionLike>(text: string, mentions: readonly M[]): M[] {
  return mentions.filter((m) => !isChat(m) || trim(m.title) === "" || text.includes(m.title));
}

export function wire(ps: readonly Part[]): WirePart[] {
  return ps.map((p): WirePart => {
    switch (p.kind) {
      case "plain":
        return { text: p.text };
      case "tag":
      case "command":
        return { text: p.text, kind: p.kind };
      case "chat":
        return { text: p.text, kind: "chat", chat: p.chat };
      case "image":
        return { text: p.text, kind: "image", image: p.image };
    }
  });
}

export function partStyle(k: Kind): { color: "fg" | "blue-900"; tint: boolean; underline: boolean; link: boolean } {
  switch (k.kind) {
    case "plain":
      return { color: "fg", tint: false, underline: false, link: false };
    case "tag":
    case "command":
      return { color: "blue-900", tint: false, underline: false, link: false };
    case "image":
      return { color: "blue-900", tint: true, underline: false, link: false };
    case "chat":
      return { color: "blue-900", tint: false, underline: true, link: true };
  }
}


const IMAGE_OPEN = "[Image #";

function imageToken(n: number): string {
  return `${IMAGE_OPEN}${n}]`;
}

/** The `[Image #N]` tokens of `text`: [start, end, N]. */
export function images(text: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const a of matchIndices(text, IMAGE_OPEN)) {
    const rest = text.slice(a + IMAGE_OPEN.length);
    const m = /^[0-9]*/.exec(rest);
    const digits = m ? m[0].length : 0;
    if (rest[digits] !== "]" || digits === 0) continue;
    const n = Number(rest.slice(0, digits));
    if (Number.isSafeInteger(n) && n > 0) out.push([a, a + IMAGE_OPEN.length + digits + 1, n]);
  }
  return out;
}

/** The numbers written in `text`, each once, lowest first. */
export function imageNumbers(text: string): number[] {
  return [...new Set(images(text).map((i) => i[2]))].sort((a, b) => a - b);
}

/** How many of `files` are images (what the numbers count). */
export function imageCount(files: readonly string[]): number {
  return files.filter(isImage).length;
}

/** What the agent gets after the user's text when it names images: which image each number is. */
export function imagesPrompt(text: string, files: readonly string[]): string {
  const lines = files.filter(isImage).map((f, i) => `Image #${i + 1}: ${f}`);
  if (lines.length === 0 || images(text).length === 0) return "";
  return `\n\n[Images in this message, in the order attached:\n- ${lines.join("\n- ")}]`;
}

/** `text` with `[Image #n]` at `at`, spaces around it where words would touch it, and the cursor after it. */
export function insertImage(text: string, at: number, n: number): [string, number] {
  const cut = Math.min(at, text.length);
  const head = text.slice(0, cut);
  const tail = text.slice(cut);
  const prev = lastChar(head);
  const before = prev === undefined || isSpace(prev) ? "" : " ";
  const after = isSpace(tail[0]) ? "" : " ";
  const token = `${before}${imageToken(n)}${after}`;
  return [`${head}${token}${tail}`, at + token.length];
}

/** Image `n` left the message: `text` without its tokens, later images a number lower, and where the cursor went. */
export function forgetImage(text: string, n: number, cursor: number): [string, number] {
  let out = text;
  let c = Math.min(cursor, text.length);
  for (const [a, z0, k] of images(text).reverse()) {
    if (k < n) continue;
    let z = z0;
    let w = "";
    if (k > n) w = imageToken(k - 1);
    else if (text[z] === " " && (a === 0 || isSpace(lastChar(text.slice(0, a))))) z += 1;
    out = out.slice(0, a) + w + out.slice(z);
    if (c >= z) c = c - (z - a) + w.length;
    else if (c > a) c = a;
  }
  return [out, c];
}

/** `files` without its `n`th image (counting images only). */
function withoutImage(files: readonly string[], n: number): string[] {
  let k = 0;
  return files.filter((f) => !(isImage(f) && ++k === n));
}

/** The composer's file `i` was removed: the files left, and the text without its token (later images a number lower) and the cursor. */
export function dropFile(text: string, files: readonly string[], i: number, cursor: number): { text: string; files: string[]; cursor: number } {
  const f = files[i];
  const left = files.filter((_, k) => k !== i);
  if (f === undefined || !isImage(f)) return { text, files: left, cursor };
  const [t, c] = forgetImage(text, files.slice(0, i).filter(isImage).length + 1, cursor);
  return { text: t, files: left, cursor: c };
}

/** The composer's text went from `before` to `text`: an image whose every token was erased leaves `files` and the later numbers move down; null when nothing left. */
export function imagesFollow(before: string, text: string, files: readonly string[], cursor: number): { text: string; files: string[]; cursor: number } | null {
  const now = new Set(imageNumbers(text));
  const count = imageCount(files);
  const gone = imageNumbers(before).filter((n) => n <= count && !now.has(n)).reverse();
  if (gone.length === 0) return null;
  let out = { text, files: [...files], cursor };
  for (const n of gone) {
    const [t, c] = forgetImage(out.text, n, out.cursor);
    out = { text: t, files: withoutImage(out.files, n), cursor: c };
  }
  return out;
}

/** `text` with each image number through `f`, in the order written; null: the token only reads as one (`[Image 3]`). */
export function mapImages(text: string, f: (n: number) => number | null): string {
  const mapped = images(text).map(([a, z, n]) => [a, z, n, f(n)] as const);
  let out = text;
  for (const [a, z, n, to] of mapped.reverse()) {
    out = out.slice(0, a) + (to === null ? `[Image ${n}]` : imageToken(to)) + out.slice(z);
  }
  return out;
}

/** `text` from another message, its tokens no longer tokens. */
export function defuse(text: string): string {
  return mapImages(text, () => null);
}

export function shiftImages(text: string, by: number): string {
  return mapImages(text, (n) => n + by);
}

/** `text` without its image tokens, as a chat's title. */
export function withoutImages(text: string): string {
  let out = text;
  for (const [a, z] of images(text).reverse()) {
    out = out.slice(0, a) + out.slice(z + (text[z] === " " ? 1 : 0));
  }
  return out;
}

/** The draft with `[Image #n]` written at `cursor` (null: the end), and the cursor after it. A hand-written token that named no image stops reading as one. */
export function writeImage(draft: string, cursor: number | null, n: number): [string, number] {
  const at = cursor === null ? draft.length : Math.min(cursor, draft.length);
  const spare = (t: string) => mapImages(t, (k) => (k < n ? k : null));
  return insertImage(spare(draft), spare(draft.slice(0, at)).length, n);
}

/** The images the tokens of `text` name among `files`: [number, file], each once. */
export function namedImages(text: string, files: readonly string[]): [number, string][] {
  const attached = files.filter(isImage);
  const out: [number, string][] = [];
  for (const n of imageNumbers(text)) {
    const f = attached[n - 1];
    if (f !== undefined) out.push([n, f]);
  }
  return out;
}

/** `text` as it pastes into a composer with `files` (pushed to when an image comes back); `named` is what the copy named. */
export function pasted(text: string, named: readonly (readonly [number, string])[], files: string[]): string {
  return mapImages(text, (n) => {
    const path = named.find(([k]) => k === n)?.[1];
    if (path === undefined) return null;
    if (!files.includes(path)) files.push(path);
    const i = files.filter(isImage).indexOf(path);
    return i < 0 ? null : i + 1;
  });
}


/** A message copied with its images (clipboard.ts `RichCopy`) as it pastes into a composer with `files` (pushed to):
 * its text with each `[Image #k]` naming that image now, then a token for each image its text doesn't name. */
export function pastedCopy(text: string, named: readonly (readonly [number, string])[], images: readonly string[], files: string[]): string {
  let out = pasted(text, named, files);
  for (const p of images) {
    if (files.includes(p)) continue;
    files.push(p);
    if (isImage(p)) [out] = writeImage(out, null, imageCount(files));
  }
  return out;
}

/** The tokens of `text` erased whole, as [start, end], in order and apart: every occurrence of `tokens` standing as a word of its own (longer first). */
export function whole(text: string, tokens: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  const byLen = tokens.filter((t) => trim(t) !== "").sort((a, b) => b.length - a.length);
  for (const t of byLen) {
    for (const a of matchIndices(text, t)) {
      const z = a + t.length;
      // A space or the end after it, maybe past punctuation (`@a.` but not `@a.rs`).
      const tail = trimStartChars(text.slice(z), PUNCT);
      const apart = opens(lastChar(text.slice(0, a)) ?? null) && (tail === "" || isSpace(tail[0]));
      if (apart && !out.some(([s, e]) => a < e && s < z)) out.push([a, z]);
    }
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** Backspace (`back`) or Delete at `cursor` when it touches a token erased whole: the text without it and the cursor; null for an ordinary key. */
export function erase(text: string, cursor: number, back: boolean, spans: readonly (readonly [number, number])[]): [string, number] | null {
  const c = Math.min(cursor, text.length);
  const hit = spans.find(([a, z]) => (back ? (a < c && c <= z) || (text[z] === " " && c === z + 1) : a <= c && c < z));
  if (!hit) return null;
  const a = hit[0];
  let z = hit[1];
  if (text[z] === " " && (c === z + 1 || a === 0 || text.slice(0, a).endsWith(" "))) z += 1;
  return [text.slice(0, a) + text.slice(z), a];
}

/** What Backspace or Delete takes whole in the composer: picked tokens, mentioned chats' titles and image tokens. */
export function eraseSpans(draft: string, picked: readonly string[], titles: readonly (readonly [string, string])[]): [number, number][] {
  const spans = whole(draft, [...picked, ...titles.map(([t]) => t)]);
  for (const [a, z] of images(draft)) spans.push([a, z]);
  return spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** Remembers a token picked from a menu so it erases whole: `list` with it, each once. */
export function withPicked(list: readonly string[], token: string): string[] {
  const t = trim(token);
  if (t === "" || list.includes(t)) return [...list];
  return [...list, t];
}

/** Most image steps an undo history keeps. */
export const IMAGE_STEPS = 32;

/** `list` with `step` pushed, the oldest dropped past `IMAGE_STEPS`. */
export function pushStep<T>(list: T[], step: T): void {
  list.push(step);
  if (list.length > IMAGE_STEPS) list.shift();
}
