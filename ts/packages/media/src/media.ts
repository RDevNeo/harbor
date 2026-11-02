import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { dataDir, home } from "@harbor/store";
import { sharpLib } from "./sharplib.ts";
import type { Image, Paragraph, Parent, PhrasingContent, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg"] as const;
export const VIDEO_EXTS = ["mp4", "webm", "mov"] as const;
export const MAX_IMAGE = 40 * 2 ** 20;
export const MAX_VIDEO = 200 * 2 ** 20;
const MAX_PER_TEXT = 8;
const PRIVATE = [".ssh", ".gnupg", ".password-store", ".aws", ".kube", ".docker", ".netrc"];

export interface Media {
  path: string;
  caption: string;
  video: boolean;
  shown: boolean;
  url: string | null;
}

export function mediaName(m: Media): string {
  const src = m.url ?? m.path;
  const bare = src.split(/[?#]/)[0] ?? src;
  return bare.split("/").reverse().find((s) => s !== "") ?? bare;
}

function ext(path: string): string {
  const p = path.split(/[?#]/)[0] ?? path;
  return extname(basename(p)).slice(1).toLowerCase();
}

export function kind(path: string): boolean | null {
  const e = ext(path);
  if ((IMAGE_EXTS as readonly string[]).includes(e)) return false;
  if ((VIDEO_EXTS as readonly string[]).includes(e)) return true;
  return null;
}

export const isVideo = (path: string): boolean => kind(path) === true;
export const isSvg = (path: string): boolean => ext(path) === "svg";

const MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

export function mime(path: string): string {
  return MIMES[ext(path)] ?? "application/octet-stream";
}

function parse(md: string): Root {
  return fromMarkdown(md, { extensions: [gfmTable(), gfmStrikethrough()], mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()] });
}

function images(node: Root | RootContent, out: Image[] = []): Image[] {
  if (node.type === "image") out.push(node);
  if ("children" in node) for (const c of (node as Parent).children) images(c as RootContent, out);
  return out;
}

const span = (n: { position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined }): [number, number] => [n.position?.start.offset ?? 0, n.position?.end.offset ?? 0];

export function refs(md: string): [string, string][] {
  if (!md.includes("![")) return [];
  return images(parse(md)).map((i) => [(i.alt ?? "").trim(), i.url]);
}

export function stripRefs(md: string): string {
  if (!md.includes("![")) return md;
  const cut = images(parse(md))
    .filter((i) => kind(i.url) !== null)
    .map(span);
  if (cut.length === 0) return md;
  let out = "";
  let at = 0;
  for (const [start, end] of cut) {
    if (start >= at) {
      out += md.slice(at, start);
      at = end;
    }
  }
  return out + md.slice(at);
}

export type Part = { type: "text"; text: string } | { type: "media"; text: string };

const text = (t: string): Part => ({ type: "text", text: t });
const media = (t: string): Part => ({ type: "media", text: t });

function isPlain(c: PhrasingContent): boolean {
  return (c.type === "text" && c.value.trim() === "") || c.type === "break";
}

export function parts(md: string): Part[] {
  if (!md.includes("![")) return [text(md)];
  const out: Part[] = [];
  let at = 0;
  for (const node of parse(md).children) {
    if (node.type !== "paragraph") continue;
    const p: Paragraph = node;
    let shown = false;
    let other = false;
    for (const c of p.children) {
      if (c.type === "image") {
        if (kind(c.url) !== null) shown = true;
        else other = true;
      } else if (!isPlain(c)) other = true;
    }
    if (!shown || other) continue;
    const [start, stop] = span(p);
    let end = stop;
    if (md.startsWith("\r\n", end)) end += 2;
    else if (md[end] === "\n") end += 1;
    if (md.slice(at, start).trim() !== "") out.push(text(md.slice(at, start)));
    out.push(media(md.slice(start, end)));
    at = end;
  }
  if (md.slice(at).trim() !== "" || out.length === 0) out.push(text(md.slice(at)));
  return out;
}

function pctDecode(s: string): string {
  const b = Buffer.from(s, "utf8");
  const out: number[] = [];
  let i = 0;
  while (i < b.length) {
    if (b[i] === 0x25 && i + 2 < b.length) {
      const h = b.subarray(i + 1, i + 3).toString("latin1");
      if (/^[0-9a-fA-F]{2}$/.test(h)) {
        out.push(Number.parseInt(h, 16));
        i += 3;
        continue;
      }
    }
    out.push(b[i] ?? 0);
    i++;
  }
  return Buffer.from(out).toString("utf8");
}

export function normalize(p: string): string {
  const abs = p.startsWith("/");
  const stack: string[] = [];
  for (const c of p.split("/")) {
    if (c === "" || c === ".") continue;
    if (c === "..") stack.pop();
    else stack.push(c);
  }
  return abs ? `/${stack.join("/")}` : stack.join("/");
}

const startsWithPath = (p: string, base: string): boolean => p === base || p.startsWith(base.endsWith("/") ? base : `${base}/`);

function canon(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function resolve(target: string, cwd: string | null): [string, string | null] | null {
  const t = target.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  if (kind(t) === null) return null;
  if (t.startsWith("https://")) return [cachePath(t), t];
  if (t.includes("://") && !t.startsWith("file://")) return null;
  let path: string;
  if (t.startsWith("file://")) {
    let rest = t.slice("file://".length);
    if (rest.startsWith("localhost")) rest = rest.slice("localhost".length);
    path = pctDecode(rest);
  } else if (t.startsWith("~/")) {
    path = join(home(), t.slice(2));
  } else if (t.startsWith("/")) {
    path = t;
  } else {
    if (cwd === null) return null;
    const joined = normalize(join(cwd, pctDecode(t)));
    const [j, c] = [canon(joined), canon(cwd)];
    const inside = j !== null && c !== null ? startsWithPath(j, c) : startsWithPath(joined, normalize(cwd));
    if (!inside) return null;
    path = joined;
  }
  if (!path.startsWith("/")) return null;
  path = normalize(path);
  return allowed(path) ? [path, null] : null;
}

export function localVideo(target: string): string | null {
  const r = resolve(target, null);
  return r && r[1] === null && isVideo(r[0]) ? r[0] : null;
}

const isPrivate = (p: string): boolean => p.split("/").some((c) => PRIVATE.includes(c)) || ["/proc", "/sys", "/dev"].some((d) => startsWithPath(p, d));

export function allowed(p: string): boolean {
  if (kind(p) === null || isPrivate(p)) return false;
  const c = canon(p);
  return !(c !== null && (isPrivate(c) || kind(c) === null));
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function find(md: string, cwd: string | null): Media[] {
  const out: Media[] = [];
  for (const [caption, target] of refs(md)) {
    const r = resolve(target, cwd);
    if (r) {
      const [path, url] = r;
      if (url !== null) fetchUrl(url);
      if (!out.some((m) => m.path === path)) out.push({ video: isVideo(path), path, caption, shown: true, url });
    }
    if (out.length === MAX_PER_TEXT) return out;
  }
  const lower = md.toLowerCase();
  if (![...IMAGE_EXTS, ...VIDEO_EXTS].some((e) => lower.includes(`.${e}`))) return out;
  let named = 0;
  for (const raw of md.split(/[\s"'`()<>[\],=\\|*]/)) {
    let tok = raw.replace(/[.:;!?]+$/, "");
    if (tok.startsWith("file://")) tok = tok.slice("file://".length);
    if (kind(tok) === null) continue;
    let path: string;
    if (tok.startsWith("~/")) path = join(home(), tok.slice(2));
    else if (tok.startsWith("/")) path = tok;
    else continue;
    if (!out.some((m) => m.path === path) && isFile(path) && allowed(path)) {
      out.push({ video: isVideo(path), path, caption: "", shown: false, url: null });
      named++;
      if (named === 4 || out.length === MAX_PER_TEXT) break;
    }
  }
  return out;
}

const startsWith = (h: Uint8Array, s: string): boolean => h.length >= s.length && [...s].every((c, i) => h[i] === c.charCodeAt(0));
const latin = (h: Uint8Array, from: number, to: number): string => Buffer.from(h.subarray(from, to)).toString("latin1");

export function sniff(h: Uint8Array): boolean | null {
  if (startsWith(h, "\x89PNG") || startsWith(h, "\xFF\xD8\xFF") || startsWith(h, "GIF87a") || startsWith(h, "GIF89a") || (h.length >= 12 && latin(h, 0, 4) === "RIFF" && latin(h, 8, 12) === "WEBP")) return false;
  if (startsWith(h, "\x1A\x45\xDF\xA3") || (h.length >= 8 && ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].includes(latin(h, 4, 8)))) return true;
  const t = Buffer.from(h).toString("utf8").replace(/^\ufeff/, "").trimStart().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return t.startsWith("<") && t.includes("<svg") && !h.includes(0) ? false : null;
}

export type Check = { ok: true; video: boolean } | { ok: false; error: string };

const bad = (error: string): Check => ({ ok: false, error });

export function check(path: string): Check {
  if (kind(path) === null) return bad("not an image or video");
  if (!path.startsWith("/") || !allowed(path)) return bad("not a file Harbor shows");
  return checkFile(path, located(path));
}

function head(file: string): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, 1024, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function checkFile(path: string, file: string): Check {
  const video = isVideo(path);
  let size: number;
  try {
    const m = statSync(file);
    if (!m.isFile()) return bad("not a file");
    size = m.size;
  } catch {
    return bad("no such file");
  }
  const cap = video ? MAX_VIDEO : MAX_IMAGE;
  if (size > cap) return bad(`too large (${Math.floor(size / 2 ** 20)} MB, at most ${Math.floor(cap / 2 ** 20)} MB)`);
  let h: Uint8Array;
  try {
    h = head(file);
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
  return sniff(h) === video ? { ok: true, video } : bad(`its contents aren't a${video ? " video" : "n image"}`);
}

export function cacheDir(): string {
  return join(dataDir(), "media");
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 20);
}

export function cachePath(url: string): string {
  return join(cacheDir(), `${shortHash(url)}.${ext(url)}`);
}

export function keptPath(path: string): string {
  return join(cacheDir(), "kept", `${shortHash(path)}.${ext(path)}`);
}

export function located(path: string): string {
  if (existsSync(path) || !path.startsWith("/") || kind(path) === null) return path;
  const k = keptPath(path);
  return isFile(k) ? k : path;
}

export function keepOne(path: string): string | null {
  if (!isFile(path) || !allowed(path)) return "not a file Harbor shows";
  const c = checkFile(path, path);
  if (!c.ok) return c.error;
  const to = keptPath(path);
  const from = statSync(path);
  try {
    const kept = statSync(to);
    if (kept.size === from.size && from.mtimeMs <= kept.mtimeMs) return null;
  } catch {
    // not kept yet
  }
  try {
    mkdirSync(join(cacheDir(), "kept"), { recursive: true });
    const part = `${to}.part`;
    copyFileSync(path, part);
    renameSync(part, to);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return null;
}

export function keep(md: string, cwd: string | null): void {
  const files = find(md, cwd)
    .filter((m) => m.shown && m.url === null)
    .map((m) => m.path)
    .filter((p) => !startsWithPath(p, cacheDir()));
  if (files.length > 0) setTimeout(() => files.forEach(keepOne), 0);
}

export function saveRemote(path: string, bytes: Uint8Array): string | null {
  const to = join(cacheDir(), "remote", `${shortHash(path)}.${ext(path)}`);
  try {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
    return to;
  } catch {
    return null;
  }
}

type Dl = { state: "running" } | { state: "failed"; error: string };

const downloads = new Map<string, Dl>();
const waiters: (() => void)[] = [];

export const generation = { value: 0 };

export function fetchUrl(url: string): void {
  const to = cachePath(url);
  if (isFile(to) || downloads.has(url)) return;
  downloads.set(url, { state: "running" });
  void download(url, to)
    .then(() => downloads.delete(url))
    .catch((e: unknown) => downloads.set(url, { state: "failed", error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      generation.value++;
      for (const w of waiters.splice(0)) w();
    });
}

export function retry(url: string): void {
  if (downloads.get(url)?.state === "failed") downloads.delete(url);
}

export function downloadState(url: string): null | "running" | { error: string } {
  const d = downloads.get(url);
  if (!d) return null;
  return d.state === "running" ? "running" : { error: d.error };
}

export async function waitFor(path: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!isFile(path) && startsWithPath(path, cacheDir()) && Date.now() < until) {
    const running = [...downloads].some(([u, d]) => d.state === "running" && cachePath(u) === path);
    if (!running) return;
    await new Promise<void>((r) => {
      waiters.push(r);
      setTimeout(r, 200);
    });
  }
}

export async function run(cmd: string[], limitMs: number): Promise<{ ok: boolean; err: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), limitMs);
  const err = new Response(proc.stderr as ReadableStream).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (proc.signalCode === "SIGKILL") throw new Error("took too long");
  const last = (await err).trim().split("\n").at(-1) ?? "";
  return { ok: code === 0, err: last };
}

async function download(url: string, to: string): Promise<void> {
  mkdirSync(cacheDir(), { recursive: true });
  const part = `${to}.part`;
  const cap = isVideo(url) ? MAX_VIDEO : MAX_IMAGE;
  const r = await run(["curl", "-sSfL", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "3", "--max-time", "120", "--max-filesize", String(cap), "-o", part, "--", url], 130_000);
  if (!r.ok) {
    rmSync(part, { force: true });
    throw new Error(r.err === "" ? "download failed" : r.err);
  }
  let h: Uint8Array = new Uint8Array();
  try {
    h = head(part);
  } catch {
    // empty or unreadable
  }
  if (sniff(h) !== isVideo(url)) {
    rmSync(part, { force: true });
    throw new Error("not an image or video");
  }
  renameSync(part, to);
}

export async function poster(video: string): Promise<string | null> {
  const c = check(video);
  if (!c.ok || !c.video) return null;
  const file = located(video);
  let m: ReturnType<typeof statSync>;
  try {
    m = statSync(file);
  } catch {
    return null;
  }
  const stamp = Math.floor(m.mtimeMs / 1000);
  const out = join(cacheDir(), "posters", `${shortHash(`${file}|${m.size}|${stamp}`)}.jpg`);
  if (isFile(out)) return out;
  mkdirSync(dirname(out), { recursive: true });
  const part = out.replace(/\.jpg$/, ".part.jpg");
  for (const at of ["0.5", "0"]) {
    const args = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", at, "-i", file, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", part];
    const ok = await run(args, 20_000).then((r) => r.ok).catch(() => false);
    if (ok && isFile(part) && statSync(part).size > 0) {
      renameSync(part, out);
      return out;
    }
  }
  rmSync(part, { force: true });
  return null;
}

export async function svgPng(svg: string, px: number): Promise<Uint8Array | null> {
  const c = check(svg);
  if (!c.ok || c.video) return null;
  try {
    const sharp = await sharpLib();
    const drawn = await sharp(readFileSync(located(svg)), { density: 144, limitInputPixels: 4096 * 4096 }).png().toBuffer();
    const meta = await sharp(drawn).metadata();
    if (Math.max(meta.width ?? 0, meta.height ?? 0) <= px) return drawn;
    return await sharp(drawn).resize(px, px, { fit: "inside" }).png().toBuffer();
  } catch {
    return null;
  }
}

/** A served image: status, content type and bytes (an error's bytes are its text). */
export interface ImageAnswer {
  status: number;
  ctype: string;
  body: Uint8Array;
}

const answerError = (status: number, error: string): ImageAnswer => ({ status, ctype: "text/plain", body: new TextEncoder().encode(error) });

function imageType(b: Uint8Array): string {
  if (startsWith(b, "\x89PNG")) return "image/png";
  if (startsWith(b, "\xFF\xD8\xFF")) return "image/jpeg";
  if (startsWith(b, "GIF87a") || startsWith(b, "GIF89a")) return "image/gif";
  if (b.length >= 12 && latin(b, 0, 4) === "RIFF" && latin(b, 8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/** api.rs `serve_image`: a card's image (a video's poster, an SVG drawn), scaled to JPEG within `max` when asked; also once a temp file is gone (its kept copy). */
export async function imageAnswer(path: string, max: number | null): Promise<ImageAnswer> {
  // An https image still downloading into the cache: wait for it a little.
  await waitFor(path, 20_000);
  const c = check(path);
  if (!c.ok) return answerError(404, `no such image: ${c.error}`);
  const m = max === null ? null : Math.min(2048, Math.max(16, max));
  let bytes: Uint8Array | null = null;
  if (c.video) {
    const p = await poster(path);
    bytes = p === null ? null : readFileSync(p);
  } else if (isSvg(path)) bytes = await svgPng(path, m ?? 1024);
  else {
    try {
      bytes = readFileSync(located(path));
    } catch {
      bytes = null;
    }
  }
  if (bytes === null) return answerError(404, c.video ? "no preview of this video" : "unreadable image");
  if (m === null) return { status: 200, ctype: imageType(bytes), body: bytes };
  try {
    const sharp = await sharpLib();
    const img = sharp(bytes, { limitInputPixels: 16384 * 16384 });
    const meta = await img.metadata();
    const big = (meta.width ?? 0) > m || (meta.height ?? 0) > m;
    const out = await (big ? img.resize(m, m, { fit: "inside" }) : img).flatten({ background: "#ffffff" }).jpeg().toBuffer();
    return { status: 200, ctype: "image/jpeg", body: out };
  } catch {
    return answerError(415, "not an image Harbor can read");
  }
}
