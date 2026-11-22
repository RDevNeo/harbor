// Files a reply attaches: a markdown link (not an image) to a local file that isn't an image or a video, which
// the chat's PC copied into its uploads when the reply came (media's files.ts `adoptFiles`). The reply names that
// copy, `uploads/<chat>/files/<20 hex digits>/<name>`, with its size as the link's title; this reads them back,
// from the text alone, so every PC and phone that shows the reply finds the same cards without looking at disk.
import MarkdownIt from "markdown-it";
import { GLYPHS } from "./glyphs.ts";

/** One attached file: the kept copy's path on the chat's PC, its own name, its size in bytes (null: not said). */
export interface Attachment {
  path: string;
  name: string;
  size: number | null;
  /** How many lines of the text go up to the end of the top-level block that holds its link (`attachBefore`). */
  end?: number;
}

/** The folder of a chat's uploads that holds the files its replies attached. */
export const ATTACH_DIR = "files";
/** At most this many cards for one reply. */
export const MAX_ATTACH = 8;

const md = new MarkdownIt({ html: false, linkify: false });

const KEPT = /(?:^|[\\/])uploads[\\/]-?\d+[\\/]files[\\/][0-9a-f]{20}[\\/]([^\\/]+)$/;

/** Whether `path` names a reply's attached file (its kept copy), on any PC. */
export function isAttachPath(path: string): boolean {
  return KEPT.test(path) && !path.split(/[\\/]/).includes("..");
}

/** A size as the title of an attachment's link: `12345 bytes`. */
export const sizeTitle = (n: number): string => `${n} bytes`;

function sizeOf(title: string | null): number | null {
  const m = /^(\d+) bytes$/.exec(title?.trim() ?? "");
  return m?.[1] ? Number(m[1]) : null;
}

function decoded(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

type Tok = ReturnType<typeof md.parse>[number];

function linksIn(children: readonly Tok[]): { href: string; title: string | null }[] {
  return children.filter((t) => t.type === "link_open").map((t) => ({ href: decoded(String(t.attrGet("href") ?? "")), title: t.attrGet("title") === null ? null : String(t.attrGet("title")) }));
}

/** The files a reply attaches, in order, each once (at most MAX_ATTACH). */
export function attachments(text: string): Attachment[] {
  if (!text.includes(`${ATTACH_DIR}/`) && !text.includes(`${ATTACH_DIR}\\`)) return [];
  const out: Attachment[] = [];
  let end = 0;
  for (const t of md.parse(text, {})) {
    if (t.level === 0 && t.map && t.nesting >= 0) end = t.map[1];
    if (t.type !== "inline") continue;
    for (const l of linksIn(t.children ?? [])) {
      const m = KEPT.exec(l.href);
      if (!m?.[1] || !isAttachPath(l.href) || out.some((a) => a.path === l.href)) continue;
      out.push({ path: l.href, name: m[1], size: sizeOf(l.title), end });
      if (out.length === MAX_ATTACH) return out;
    }
  }
  return out;
}

/** The text up to the end of the block that holds an attachment's link: its card goes after the blocks this draws
 * (once `stripAttachments`), so a paragraph of links alone has its cards where it was, a sentence's link under it. */
export function attachBefore(text: string, a: Attachment): string {
  if (a.end === undefined) return text;
  return text.split(/(?<=\n)/).slice(0, a.end).join("");
}

/** A paragraph of nothing but attachment links (and spaces): the cards stand for it. */
function onlyAttachments(children: readonly Tok[]): boolean {
  let any = false;
  let inLink = false;
  for (const c of children) {
    if (c.type === "link_open") {
      if (!isAttachPath(decoded(String(c.attrGet("href") ?? "")))) return false;
      any = true;
      inLink = true;
    } else if (c.type === "link_close") inLink = false;
    else if (!inLink && !(c.type === "softbreak" || c.type === "hardbreak" || (c.type === "text" && c.content.trim() === ""))) return false;
  }
  return any;
}

/** The reply's text without the paragraphs its file cards stand for; links to attachments within a sentence stay. */
export function stripAttachments(text: string): string {
  if (!text.includes(`${ATTACH_DIR}/`) && !text.includes(`${ATTACH_DIR}\\`)) return text;
  const toks = md.parse(text, {});
  const cut: [number, number][] = [];
  for (let i = 0; i + 2 < toks.length; i++) {
    const [open, inline] = [toks[i] as Tok, toks[i + 1] as Tok];
    if (open.type !== "paragraph_open" || open.level !== 0 || !open.map || inline.type !== "inline") continue;
    if (onlyAttachments(inline.children ?? [])) cut.push(open.map as [number, number]);
  }
  if (cut.length === 0) return text;
  const lines = text.split(/(?<=\n)/);
  const kept = lines.filter((_, n) => !cut.some(([a, b]) => n >= a && n < b));
  return kept.join("").replace(/\n{3,}/g, "\n\n").trimEnd();
}

const KINDS: [RegExp, string][] = [
  [/\.apk$/i, "APK"],
  [/\.(zip|tar|gz|tgz|xz|bz2|7z|rar|zst)$/i, "Archive"],
  [/\.pdf$/i, "PDF"],
  [/\.(docx?|odt|rtf)$/i, "Document"],
  [/\.(xlsx?|ods|csv|tsv)$/i, "Spreadsheet"],
  [/\.(pptx?|odp|key)$/i, "Slides"],
  [/\.(mp3|wav|ogg|flac|m4a|opus|aac)$/i, "Audio"],
  [/\.(txt|md|log|json|ya?ml|toml|xml|html?)$/i, "Text"],
  [/\.(deb|rpm|dmg|exe|msi|appimage|pkg)$/i, "Installer"],
];

/** What kind of file a name is, in a word for its card ("" when nothing better than its extension). */
export function fileKind(name: string): string {
  for (const [re, k] of KINDS) if (re.test(name)) return k;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1];
  return ext ? ext.toUpperCase() : "File";
}

/** A size in a few characters: `812 B`, `14 KB`, `3.4 MB`, `1.2 GB`. */
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} ${units[u]}`;
}

/** The card's second line: size and kind (`12.4 MB · APK`). */
export function attachMeta(a: Attachment): string {
  return a.size === null ? fileKind(a.name) : `${fileSize(a.size)} · ${fileKind(a.name)}`;
}

/** The card's icon (a Lucide glyph, the same on the desktop and the phone) for a kind of file (`fileKind`). */
export function fileGlyph(name: string): string {
  switch (fileKind(name)) {
    case "APK":
      return GLYPHS.SMARTPHONE;
    case "Archive":
      return GLYPHS.ARCHIVE;
    case "Audio":
      return GLYPHS.VOLUME;
    case "PDF":
    case "Document":
    case "Text":
      return GLYPHS.FILE_TEXT;
    case "Installer":
      return GLYPHS.DOWNLOAD;
    default:
      return GLYPHS.FILE;
  }
}
