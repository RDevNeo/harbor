// Files a reply attaches: `[name](path)` (a link, not `![…]`) to a local file that isn't an image or a video, an
// APK, a zip, a PDF… The chat's PC keeps a copy in the chat's uploads when the reply comes (`adoptFiles`), so it
// stays downloadable once the file it came from changes or goes, and the reply names that copy
// (`uploads/<chat>/files/<id>/<name>`, its size as the link's title: net's attach.ts reads them back).
// Every PC and phone shows such a link as a file card with a Download button; they fetch the copy from the
// chat's PC (`GET /v1/file`, `/mesh/v1/file`).
import { createHash } from "node:crypto";
import { constants, type Stats, statSync } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "@harbor/store";
import type { Link, Parent, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { absolute, canon, isPrivate, kind, normalize, pctDecode, startsWithPath, uploadsDir } from "./media.ts";

/** A file larger than this is left as the link it is (no copy, no card). */
export const MAX_FILE = 200 * 2 ** 20;
const MAX_PER_TEXT = 8;
const WIN = sep === "\\";

/** Source files a reply links to (`[engine.ts](src/engine.ts)`) are references to code, not files to download. */
const CODE = new Set(
  "ts tsx js jsx mjs cjs mts cts java kt kts rs py go c h cc cpp hpp cs rb php swift scala slint sh bash zsh fish ps1 css scss sass less vue svelte lua pl ex exs erl hs ml clj dart sql gradle cmake mk".split(" "),
);

const ext = (p: string): string => /\.([^.\\/]+)$/.exec(p)?.[1]?.toLowerCase() ?? "";

function parse(md: string): Root {
  return fromMarkdown(md, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] });
}

function links(node: Root | RootContent, out: Link[] = []): Link[] {
  if (node.type === "link") out.push(node);
  if ("children" in node) for (const c of (node as Parent).children) links(c as RootContent, out);
  return out;
}

/** A link's target as a local path (absolute, `~/`, `file://` or inside `cwd`), or null when it names no local file. */
export function localTarget(target: string, cwd: string | null): string | null {
  const t = target.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  if (t === "" || t.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("file://") && !(WIN && /^[A-Za-z]:[\\/]/.test(t))) return null;
  let path: string;
  if (t.startsWith("file://")) {
    let rest = t.slice("file://".length);
    if (rest.startsWith("localhost")) rest = rest.slice("localhost".length);
    path = WIN && /^\/[A-Za-z]:\//.test(rest) ? fileURLToPath(`file://${rest}`) : pctDecode(rest);
  } else if (t.startsWith("~/")) path = join(home(), pctDecode(t.slice(2)));
  else if (absolute(t)) path = pctDecode(t);
  else {
    if (cwd === null) return null;
    const joined = normalize(join(cwd, pctDecode(t)));
    const [j, c] = [canon(joined), canon(cwd)];
    const inside = j !== null && c !== null ? startsWithPath(j, c) : startsWithPath(joined, normalize(cwd));
    if (!inside) return null;
    // A project's own source file: a reference to code.
    if (CODE.has(ext(joined))) return null;
    path = joined;
  }
  if (!absolute(path)) return null;
  return normalize(path);
}

/** Whether a reply may attach the file at `path`: a regular file, not an image or video (they show inline), not private. */
export function attachable(path: string): Stats | null {
  if (kind(path) !== null || isPrivate(path)) return null;
  const c = canon(path);
  if (c === null || isPrivate(c)) return null;
  try {
    const s = statSync(c);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/** A file name safe in any folder: no separators or control characters, no leading dots, at most 120 characters. */
export function safeName(n: string): string {
  let s = n.replace(/[\\/\x00-\x1f:*?"<>|]/g, "_").trim();
  while (s.startsWith(".")) s = s.slice(1);
  if (s.length > 120) s = s.slice(s.length - 120);
  return s === "" ? "file" : s;
}

/** The kept copy's id: the file's real path, size and modification time (no read of its bytes on the main thread);
 * the same file linked again, unchanged, is the same copy. */
function keptId(real: string, s: Stats): string {
  return createHash("sha256").update(`${real}\0${s.size}\0${Math.floor(s.mtimeMs)}`).digest("hex").slice(0, 20);
}

/** Copies under way, by the kept path: the routes wait for them (`fileWait`). */
const copying = new Map<string, Promise<boolean>>();

async function copyIn(from: string, to: string): Promise<boolean> {
  try {
    const have = await stat(to).catch(() => null);
    if (have?.isFile()) return true;
    await mkdir(join(to, ".."), { recursive: true });
    const part = `${to}.${process.pid}.part`;
    await copyFile(from, part);
    await rename(part, to);
    return true;
  } catch {
    return false;
  }
}

/** Where the files chat `chat`'s replies attach are kept. */
export function attachDir(chat: number): string {
  return join(uploadsDir(), String(chat), "files");
}

/** The link as written once it names the kept copy: its label, the copy, its size as the title. */
function linkTo(label: string, to: string, size: number): string {
  const target = /[\s()<>]/.test(to) ? `<${to}>` : to;
  return `[${label}](${target} "${size} bytes")`;
}

/**
 * A reply as its chat keeps it: each file it links to (`[name](path)`, see `localTarget` and `attachable`), up to
 * MAX_FILE, is copied into the chat's uploads (in the background: the copy may take a while) and the link names that
 * copy. Images and videos are `adopt`'s (media.ts); links to anything else stay as written.
 */
export function adoptFiles(md: string, cwd: string | null, chat: number): string {
  if (!md.includes("](")) return md;
  const up = uploadsDir();
  let out = "";
  let at = 0;
  let n = 0;
  for (const node of links(parse(md))) {
    const path = localTarget(node.url, cwd);
    if (path === null || startsWithPath(path, up)) continue;
    const s = attachable(path);
    if (s === null || s.size > MAX_FILE) continue;
    const start = node.position?.start.offset ?? -1;
    const end = node.position?.end.offset ?? -1;
    const src = md.slice(start, end);
    const cut = src.lastIndexOf("](");
    if (start < at || start < 0 || cut < 0 || !src.endsWith(")")) continue;
    const real = canon(path) ?? path;
    const to = join(attachDir(chat), keptId(real, s), safeName(basename(path)));
    if (!copying.has(to)) {
      const p = copyIn(real, to);
      copying.set(to, p);
      void p.finally(() => setTimeout(() => copying.delete(to), 60_000));
    }
    out += md.slice(at, start) + linkTo(src.slice(1, cut), to, s.size);
    at = end;
    if (++n === MAX_PER_TEXT) break;
  }
  return at === 0 ? md : out + md.slice(at);
}

/** Whether `path` is an attached file's kept copy on this PC (the only files `GET /v1/file` serves). */
export function servable(path: string): boolean {
  if (!absolute(path) || path.split(/[\\/]/).includes("..")) return false;
  const dir = join(uploadsDir());
  if (!startsWithPath(path, dir)) return false;
  const rest = path.slice(dir.length).split(/[\\/]/).filter((x) => x !== "");
  return rest.length === 4 && /^-?\d+$/.test(rest[0] ?? "") && rest[1] === "files" && /^[0-9a-f]{20}$/.test(rest[2] ?? "");
}

/** Waits for a copy of `path` still under way (at most `ms`); true when the file is there. */
export async function fileWait(path: string, ms = 120_000): Promise<boolean> {
  const p = copying.get(path);
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/** `name` in `dir`, or `name (1)`, `name (2)`… when it's taken: an open file that is new (never one that was there). */
export async function freshFile(dir: string, name: string): Promise<{ path: string; fd: import("node:fs/promises").FileHandle }> {
  await mkdir(dir, { recursive: true });
  const safe = safeName(name);
  const dot = safe.lastIndexOf(".");
  const [stem, tail] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
  for (let n = 0; n < 1000; n++) {
    const path = join(dir, n === 0 ? safe : `${stem} (${n})${tail}`);
    try {
      return { path, fd: await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("no free name");
}

/** One part of a file another PC has: its bytes and the whole file's size (null: it doesn't say). */
export type Part = { body: Uint8Array; total: number | null };

/**
 * Saves an attached file into `dir` (the Downloads folder) under its own name, never over another file: copied when
 * it's on this PC, else fetched part by part with `fetch` (from the chat's PC). Resolves to where it went.
 */
export async function saveTo(dir: string, path: string, name: string, fetch: ((from: number) => Promise<Part | null>) | null): Promise<string> {
  const local = servable(path) && (await fileWait(path, 30_000));
  if (!local && fetch === null) throw new Error("it's no longer on this PC");
  const { path: to, fd } = await freshFile(dir, name);
  try {
    if (local) {
      await fd.close();
      await copyFile(path, to);
      return to;
    }
    let at = 0;
    for (;;) {
      const p = await (fetch as (from: number) => Promise<Part | null>)(at);
      if (p === null) throw new Error("the PC that has it didn't send it");
      if (p.body.length === 0) break;
      await fd.write(p.body, 0, p.body.length, at);
      at += p.body.length;
      if (p.total !== null && at >= p.total) break;
      if (at > MAX_FILE) throw new Error("it's over 200 MB");
    }
    await fd.close();
    return to;
  } catch (e) {
    await fd.close().catch(() => {});
    await rm(to, { force: true });
    throw e;
  }
}
