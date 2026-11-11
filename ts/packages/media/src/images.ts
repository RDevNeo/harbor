import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ByteLru, stringBytes } from "@harbor/store";
import { basename } from "node:path";
import type { Metadata } from "sharp";
import { decodeIco, isIco } from "./ico.ts";
import { fileSize } from "./imagesize.ts";
import { sharpLib } from "./sharplib.ts";
import { check, find, generation, isSvg, isVideo, located, type Media, poster, svgPng } from "./media.ts";

const EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
export const THUMB_PX = 384;
const MID = "mid:";
export const MID_PX = 1280;
export const FULL_PX = 4096;
const MAX_BYTES = 100 * 2 ** 20;
export const MAX_SIDE = 16384;
const MAX_ALLOC = 512 * 2 ** 20;
const WORKERS = 2;
/** Decoded previews (`thumb`) kept, by the bytes of their pixels (width × height × 4): about 55 thumbnails at
 * THUMB_PX or 5 decodes at MID_PX. No per-entry cap: a decode is at most MID_PX on its long side (6.25 MiB). */
export const THUMBS_BUDGET = 32 * 2 ** 20;
/** File bytes fetched from another PC (or handed in), kept so the viewer's other sizes and Copy needn't fetch
 * them again. The image in the viewer and those waiting to be decoded stay whatever the budget. */
export const BYTES_BUDGET = 64 * 2 ** 20;
/** Media found in texts (`mediaIn`), by the size of the text each is keyed by: a streaming reply makes a new
 * text on every change. A text over FOUND_MAX is searched every time instead. */
export const FOUND_BUDGET = 4 * 2 ** 20;
export const FOUND_MAX = 2 ** 20;

export function isImage(path: string): boolean {
  const e = path.split(".").at(-1)?.toLowerCase() ?? "";
  return path.includes(".") && EXTS.includes(e);
}

export interface Decoded {
  width: number;
  height: number;
  data: Uint8Array;
}

export type Slot =
  | { state: "loading" }
  | { state: "ready"; image: Decoded; dims: [number, number]; stamp: number | null }
  | { state: "failed"; error: string };

export type Fetch = (path: string) => Promise<Uint8Array | null>;

export interface Source {
  image: Fetch;
  video: Fetch;
}

export interface VideoHooks {
  open(key: string, fetch: Fetch | undefined, play: boolean): void;
  close(): void;
}

export interface Limits {
  maxSide: number;
  maxAlloc: number;
}

const tooLarge = (w: number, h: number): Error => new Error(`too large (${w}×${h})`);

export async function decodeBytes(bytes: Uint8Array, cap: number, limits: Limits = { maxSide: MAX_SIDE, maxAlloc: MAX_ALLOC }): Promise<{ image: Decoded; dims: [number, number] }> {
  const sharp = await sharpLib();
  let input: Uint8Array = bytes;
  if (isIco(bytes)) {
    const ico = decodeIco(bytes);
    input = ico.kind === "png" ? ico.data : await sharp(ico.data, { raw: { width: ico.width, height: ico.height, channels: 4 } }).png().toBuffer();
  }
  const opts = { limitInputPixels: limits.maxSide * limits.maxSide, failOn: "error" as const };
  let meta: Metadata;
  try {
    meta = await sharp(input, opts).metadata();
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  const [w, h] = [meta.width ?? 0, meta.height ?? 0];
  if (w === 0 || h === 0) throw new Error("not an image");
  if (Math.max(w, h) > limits.maxSide || w * h * 4 > limits.maxAlloc) throw tooLarge(w, h);
  const turned = (meta.orientation ?? 1) >= 5;
  const dims: [number, number] = turned ? [h, w] : [w, h];
  let pipe = sharp(input, opts).autoOrient();
  if (Math.max(dims[0], dims[1]) > cap) pipe = pipe.resize({ width: cap, height: cap, fit: "inside", kernel: "linear" });
  const out = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { image: { width: out.info.width, height: out.info.height, data: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength) }, dims };
}

/** An image's size as it's drawn, from its file's head (imagesize.ts), before it's decoded; null: not known (a video, an
 * SVG, a file that isn't here). */
export function sizeAhead(key: string): [number, number] | null {
  if (isVideo(key) || isSvg(key)) return null;
  return fileSize(located(key));
}

export async function decode(key: string, bytes: Uint8Array | null, cap: number): Promise<{ image: Decoded; dims: [number, number] }> {
  let data = bytes;
  if (data === null && isVideo(key)) {
    const c = check(key);
    if (!c.ok) throw new Error(c.error);
    const p = await poster(key);
    if (p === null) throw new Error("no preview (ffmpeg isn't installed)");
    data = readFileSync(p);
  } else if (data === null && isSvg(key)) {
    const c = check(key);
    if (!c.ok) throw new Error(c.error);
    data = await svgPng(key, Math.min(cap, 2048));
    if (data === null) throw new Error("can't draw this SVG");
  } else if (data === null) {
    const file = located(key);
    const len = (() => {
      try {
        return statSync(file).size;
      } catch (e) {
        throw new Error(e instanceof Error && "code" in e && e.code === "ENOENT" ? "file not found" : e instanceof Error ? e.message : String(e));
      }
    })();
    if (len > MAX_BYTES) throw new Error(`too large (${Math.floor(len / 2 ** 20)} MB)`);
    // Not on the window's thread: a large file's read would hold up the frame that's being built.
    data = await readFile(file);
  }
  return decodeBytes(data, cap);
}

const stamp = (key: string): number | null => {
  try {
    return statSync(located(key)).mtimeMs;
  } catch {
    return null;
  }
};

interface Job {
  key: string;
  full: boolean;
}

export type LightboxKey = "prev" | "next" | "close";

export function step(at: number, n: number, dir: -1 | 1): number | null {
  const i = at + dir;
  return i >= 0 && i < n ? i : null;
}

export interface LightboxView {
  key: string;
  full: Slot | null;
  small: Slot | null;
  gallery: string[];
  index: number;
  video: boolean;
}

const slotBytes = (s: Slot): number => 64 + (s.state === "ready" ? s.image.data.byteLength : s.state === "failed" ? stringBytes(s.error) : 0);
const realKey = (key: string): string => (key.startsWith(MID) ? key.slice(MID.length) : key);

export class Images {
  /** Least recently asked go first; one being decoded, or the viewer's, never does. */
  private thumbs: ByteLru<string, Slot>;
  private full: { key: string; slot: Slot } | null = null;
  private opened: string | null = null;
  private gallery: string[] = [];
  private card = 0;
  private clicked: number | null = null;
  private held: Record<LightboxKey, boolean> = { prev: false, next: false, close: false };
  private escHeld = false;
  private bytes: ByteLru<string, Uint8Array>;
  private queue: Job[] = [];
  private workers = 0;
  private source: Source | null = null;
  private remote = new Map<string, Fetch>();
  private videos = new Map<string, Fetch>();
  private video: VideoHooks | null = null;
  private listeners = new Set<() => void>();
  private idle: (() => void)[] = [];

  /** `budgets`: smaller ones for tests. */
  constructor(budgets: { thumbs?: number; bytes?: number } = {}) {
    this.thumbs = new ByteLru({
      budget: budgets.thumbs ?? THUMBS_BUDGET,
      size: slotBytes,
      pinned: (k, s) => s.state === "loading" || (this.opened !== null && realKey(k) === this.opened),
    });
    this.bytes = new ByteLru({
      budget: budgets.bytes ?? BYTES_BUDGET,
      maxEntry: MAX_BYTES,
      size: (b) => b.byteLength + 64,
      pinned: (k) => k === this.opened || this.queue.some((j) => j.key === k || realKey(j.key) === k),
    });
  }

  /** What the caches hold now: decoded previews and fetched files, how many and their bytes. */
  kept(): { thumbs: number; thumbBytes: number; files: number; fileBytes: number } {
    return { thumbs: this.thumbs.size, thumbBytes: this.thumbs.bytes, files: this.bytes.size, fileBytes: this.bytes.bytes };
  }

  hasThumb(key: string): boolean {
    return this.thumbs.has(key);
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
  }

  setVideo(hooks: VideoHooks | null): void {
    this.video = hooks;
  }

  setSource(source: Source | null): void {
    this.source = source;
  }

  forgetAll(): void {
    this.thumbs.clear();
    this.full = null;
  }

  /** Bytes handed in for `key` are kept like fetched ones: past the budget, when not in the viewer, they can go. */
  putBytes(key: string, bytes: Uint8Array): void {
    this.bytes.set(key, bytes);
    this.thumbs.delete(key);
    if (this.full?.key === key) this.full = null;
  }

  forget(key: string): void {
    this.bytes.delete(key);
    this.thumbs.delete(key);
    if (this.full?.key === key) this.full = null;
  }

  bytesOf(key: string): Uint8Array | undefined {
    return this.bytes.get(key);
  }

  private request(job: Job): void {
    const real = realKey(job.key);
    if (this.source && !this.bytes.has(real) && !this.remote.has(real)) this.remote.set(real, this.source.image);
    if (job.full) this.queue.unshift(job);
    else this.queue.push(job);
    while (this.workers < WORKERS && this.queue.length > 0) {
      this.workers++;
      void this.work();
    }
  }

  private async work(): Promise<void> {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      const slot = await this.run(job);
      if (job.full) {
        if (this.full?.key === job.key) this.full = { key: job.key, slot };
      } else if (this.thumbs.has(job.key)) {
        // Measured again now that it holds pixels; past the budget, the least recently asked go.
        this.thumbs.set(job.key, slot);
      }
      this.changed();
    }
    this.workers--;
    if (this.workers === 0) for (const f of this.idle.splice(0)) f();
  }

  private async run(job: Job): Promise<Slot> {
    const mid = job.key.startsWith(MID);
    const real = realKey(job.key);
    const cap = mid ? MID_PX : job.full ? FULL_PX : THUMB_PX;
    try {
      let bytes = this.bytes.get(job.key) ?? this.bytes.get(real) ?? null;
      if (bytes === null) bytes = await this.fetched(real);
      const st = bytes === null ? stamp(real) : null;
      const { image, dims } = await decode(real, bytes, cap);
      return { state: "ready", image, dims, stamp: st };
    } catch (e) {
      return { state: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async fetched(key: string): Promise<Uint8Array | null> {
    const fetch = this.remote.get(key);
    if (!fetch) return null;
    const bytes = await fetch(key);
    if (bytes === null) {
      if (statSafe(located(key))) {
        this.remote.delete(key);
        return null;
      }
      throw new Error("the PC this chat runs on is off or doesn't have it");
    }
    this.bytes.set(key, bytes);
    return bytes;
  }

  thumb(key: string): Slot {
    const had = this.thumbs.get(key);
    if (had) return had;
    const slot: Slot = { state: "loading" };
    this.thumbs.set(key, slot);
    this.request({ key, full: false });
    return slot;
  }

  async settled(): Promise<void> {
    while (this.workers > 0 || this.queue.length > 0) await new Promise<void>((r) => this.idle.push(r));
  }

  async ready(key: string): Promise<Slot> {
    let slot = this.thumb(key);
    while (slot.state === "loading") {
      await this.settled();
      slot = this.thumb(key);
    }
    return slot;
  }

  open(key: string): void {
    this.openGallery([key], 0);
  }

  openGallery(keys: string[], index: number): void {
    const key = keys[index];
    if (key === undefined) return;
    this.gallery = keys;
    this.show(key, true);
  }

  openClicked(key: string, group: string[]): void {
    const i = group.indexOf(key);
    if (i >= 0) this.openGallery([...group], i);
    else this.open(key);
    this.clicked = this.card;
  }

  private show(key: string, play: boolean): void {
    this.opened = key;
    if (isVideo(key)) this.video?.open(key, this.videos.get(key), play);
    else this.video?.close();
    const local = !this.bytes.has(key);
    const now = local ? stamp(key) : null;
    const small = this.thumbs.get(key);
    if (small?.state === "ready" && small.stamp !== null && now !== null && now !== small.stamp) {
      this.thumbs.set(key, { state: "loading" });
      this.request({ key, full: false });
    }
    // The one shown before may have stayed past the budget only because it was shown.
    this.thumbs.trim();
    this.bytes.trim();
    const f = this.full;
    const fresh = f !== null && f.key === key && (f.slot.state === "loading" || (f.slot.state === "ready" && (!local || f.slot.stamp === now)));
    if (!fresh) {
      this.full = { key, slot: { state: "loading" } };
      this.request({ key, full: true });
    }
    this.changed();
  }

  isOpen(): boolean {
    return this.opened !== null;
  }

  openKey(): string | null {
    return this.opened;
  }

  galleryKeys(): readonly string[] {
    return this.gallery;
  }

  close(): void {
    this.opened = null;
    this.gallery = [];
    this.held = { prev: false, next: false, close: false };
    this.full = null;
    this.thumbs.trim();
    this.bytes.trim();
    this.video?.close();
    this.changed();
  }

  pressKey(k: LightboxKey): void {
    if (this.opened === null) return;
    this.held[k] = true;
    if (k === "close") this.escHeld = true;
  }

  /** An Esc while the viewer is shut: true while it repeats the press that closed it, which reaches nothing behind. */
  heldEsc(repeat: boolean): boolean {
    if (this.opened !== null || !this.escHeld) return false;
    if (repeat) return true;
    this.escHeld = false;
    return false;
  }

  applyKeys(): void {
    const { prev, next, close } = this.held;
    this.held = { prev: false, next: false, close: false };
    if (close) {
      this.close();
      return;
    }
    const at = this.index();
    let to: number | null = null;
    if (prev) to = step(at, this.gallery.length, -1);
    if (next) to = step(at, this.gallery.length, 1) ?? to;
    if (to !== null) this.goTo(to);
  }

  goTo(i: number): void {
    const key = this.gallery[i];
    if (key !== undefined) this.show(key, false);
  }

  private index(): number {
    return Math.max(this.opened === null ? 0 : this.gallery.indexOf(this.opened), 0);
  }

  view(): LightboxView | null {
    const key = this.opened;
    if (key === null) return null;
    return {
      key,
      full: this.full?.key === key ? this.full.slot : null,
      small: this.thumbs.peek(key) ?? null,
      gallery: [...this.gallery],
      index: this.index(),
      video: isVideo(key),
    };
  }

  inCard(seq: number): void {
    this.card = seq;
  }

  takeOpened(): number | null {
    const c = this.clicked;
    this.clicked = null;
    return c;
  }

  widen(keys: string[]): void {
    if (this.opened === null || !keys.includes(this.opened)) return;
    if (this.source) {
      for (const k of keys) {
        if (!this.bytes.has(k) && !this.remote.has(k)) this.remote.set(k, this.source.image);
        if (isVideo(k)) this.videos.set(k, this.source.video);
      }
    }
    this.gallery = keys;
  }

  setVideoSource(key: string, fetch: Fetch): void {
    this.videos.set(key, fetch);
  }

  videoSource(): Fetch | undefined {
    return this.source?.video;
  }

  hasSource(): boolean {
    return this.source !== null;
  }

  midKey(key: string): string {
    return `${MID}${key}`;
  }
}

function statSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function imageName(key: string): string {
  return basename(key) || key;
}

export function cover(tex: [number, number], rect: [number, number]): [number, number, number, number] {
  const ta = tex[0] / Math.max(tex[1], 1);
  const ra = rect[0] / Math.max(rect[1], 1);
  if (ta > ra) {
    const w = ra / ta;
    return [(1 - w) / 2, 0, (1 + w) / 2, 1];
  }
  const h = ta / ra;
  return [0, (1 - h) / 2, 1, (1 + h) / 2];
}

export function inlineSize(width: number): [number, number] {
  return [Math.min(width, 480), 300];
}

const found = new ByteLru<string, Media[]>({
  budget: FOUND_BUDGET,
  maxEntry: FOUND_MAX,
  size: (v, k) => stringBytes(k) + v.reduce((n, m) => n + stringBytes(m.path) + stringBytes(m.caption ?? "") + 64, 64),
});
const checks = new Map<string, { at: number; result: ReturnType<typeof check> }>();

export function mediaIn(text: string, cwd: string): Media[] {
  const k = `${generation.value}\0${cwd}\0${text}`;
  let v = found.get(k);
  if (!v) {
    v = find(text, cwd === "" ? null : cwd);
    found.set(k, v);
  }
  return v;
}

export function checked(key: string, now: number = performance.now() / 1000): ReturnType<typeof check> {
  const c = checks.get(key);
  if (c && now - c.at < 5) return c.result;
  const result = check(key);
  checks.set(key, { at: now, result });
  return result;
}

export function recheck(key: string): void {
  checks.delete(key);
}
