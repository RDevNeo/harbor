import { type Card, cardMedia } from "@harbor/net";
import type { Pixels } from "./logos.ts";
import { noPixels, type MediaRow } from "./window.ts";

type MediaPkg = typeof import("@harbor/media");

const THUMB: [number, number] = [132, 96];
/** Decoded images no card of the last build shows, kept for when their chat is shown again: the few chats left last
 * (shell.ts WarmChats) come back with their images drawn, not decoded again behind gray boxes. */
export const REST_BYTES = 64 * 2 ** 20;
/** File sizes read ahead (`sizeAhead`), by path: a few numbers each. */
const AHEAD_MAX = 4096;
/** A large image is drawn at most `inlineSize` (480×300 px, narrower in a narrow column): it's decoded to that width
 * in the screen's own pixels (`scale`; 2 when unknown), never above `mid`, so it stays sharp and holds no more memory
 * than drawing it needs. */
export function inlineCap(column: number, scale: number, mid: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 2;
  return Math.min(mid, Math.ceil(Math.min(column, 480) * s));
}

/** A large image's size in the transcript: its own, shrunk to fit `box`. */
export function fitIn(w: number, h: number, box: [number, number]): [number, number] {
  const k = Math.min(1, box[0] / Math.max(w, 1), box[1] / Math.max(h, 1));
  return [Math.round(w * k), Math.round(h * k)];
}

/** A decoded image and the size of its file (the decode may be smaller: it's capped at what drawing it needs). */
interface Got {
  image: Pixels;
  dims: [number, number];
}

/** Decoded images, by path and size class, shared by every transcript that draws them (the usual view's and each
 * split pane's `MediaRows`): a chat that comes back, in the same place or another pane, finds its images decoded.
 * The images some view's last build shows are kept, and those no view shows any more up to `restBytes`, the least
 * recently shown going first (`sweep`): a large one is a few MB, and a long chat has many.
 *
 * A large image's size class follows the screen's scale (zoom, another display), so a new scale asks for a new
 * decode. Until it's there the card keeps the image it has (`shown`): an image on the screen never goes blank or
 * back to its link while it's decoded again. One the file's own size already fits isn't decoded again at all. */
export class MediaStore {
  readonly got = new Map<string, Got | null>();
  /** Decodes under way, settled when they're in (or failed). */
  readonly pending = new Map<string, Promise<void>>();
  readonly failed = new Set<string>();
  /** The last key decoded for a path's large image or video poster (`l:` or `v:` and the path). */
  readonly shown = new Map<string, string>();
  /** Decoded images no view asked for, least recently shown first, and their bytes. */
  private rest = new Map<string, number>();
  private restTotal = 0;
  /** Images' sizes before they're decoded (null: not known), by path. */
  private ahead = new Map<string, [number, number] | null>();
  /** Images asked for from their chat's PC: when each may be asked again (never once it came). */
  private asked = new Map<string, number>();
  /** Images that failed to show: how many times, for the wait before the next try (`later`). */
  readonly tries = new Map<string, number>();
  readonly views = new Set<MediaRows>();

  constructor(
    readonly pkg: MediaPkg,
    /** The decoded pixels as an image the window holds, so the models share it and JS lets its copy go. */
    private native: (p: Pixels) => Pixels = (p) => p,
    private restBytes = REST_BYTES,
  ) {}

  sizeAhead(path: string): [number, number] | null {
    let v = this.ahead.get(path);
    if (v === undefined) {
      if (this.ahead.size >= AHEAD_MAX) this.ahead.clear();
      v = this.pkg.images.sizeAhead(path);
      this.ahead.set(path, v);
    }
    return v;
  }

  /** Some view's last build, or the one being made, asked for `key`. */
  wanted(key: string): boolean {
    for (const v of this.views) if (v.wants(key)) return true;
    return false;
  }

  /** `key` came in (or failed): the views that show it are built again. */
  private landed(key: string): void {
    for (const v of this.views) if (v.wants(key)) v.loaded();
  }

  /** Decodes `key` (`path` to `cap`) unless it's decoded, under way or failed; settles when it's in. */
  decode(key: string, path: string, cap: number, fetch: ((path: string) => Promise<Uint8Array | null>) | null, slot: string | null): Promise<void> {
    const img = this.got.get(key);
    if (img) return Promise.resolve();
    const going = this.pending.get(key);
    if (going) return going;
    if (img === null || this.failed.has(key)) return Promise.resolve();
    this.got.set(key, null);
    const p = this.pkg.images
      .decode(path, null, cap)
      .then(({ image, dims }) => {
        if (this.got.get(key) !== null) return;
        this.tries.delete(key);
        this.ahead.set(path, dims);
        const got = { image: this.native(image), dims };
        this.got.set(key, got);
        // Its chat was left while it decoded (or the scale moved on, or it was decoded ahead): it rests, ready for when
        // it's asked for, and doesn't take the place of the image its slot shows now.
        if (!this.wanted(key)) return this.toRest(key, got);
        if (slot !== null) this.shown.set(slot, key);
        this.landed(key);
      })
      .catch(() => {
        if (this.fromHome(path, key, fetch)) return;
        // A video without a poster (no ffmpeg) keeps its dark card: nothing to try again.
        if (!this.pkg.media.isVideo(path)) this.later(key);
        // Its place (kept while it was decoded) goes.
        this.failed.add(key);
        this.landed(key);
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /** An image that failed to decode here: fetched from its chat's PC when it can be (true: it's coming). */
  private fromHome(path: string, key: string, fetch: ((path: string) => Promise<Uint8Array | null>) | null): boolean {
    if (fetch === null || (this.asked.get(path) ?? 0) > Date.now() || this.pkg.media.isVideo(path)) return false;
    this.asked.set(path, Number.POSITIVE_INFINITY);
    void fetch(path)
      .then((bytes) => (bytes !== null ? this.pkg.media.saveRemote(path, bytes) : null))
      .catch(() => null)
      .then((saved) => {
        // Kept here: decoded again from the copy (media.ts `located` finds it).
        if (saved !== null) {
          this.got.delete(key);
          this.landed(key);
          return;
        }
        // That PC is off, or doesn't have it (yet): a link for now, asked for again a little later.
        this.asked.set(path, Date.now() + this.wait(key));
        this.failed.add(key);
        this.later(key);
        this.landed(key);
      });
    return true;
  }

  /** The wait before an image that failed is tried again: 15 s, doubling up to 5 minutes. */
  private wait(key: string): number {
    return Math.min(5 * 60_000, MediaRows.RETRY_MS * 2 ** (this.tries.get(key) ?? 0));
  }

  /**
   * An image that failed (no such file here yet, its PC off) is tried again later while a card
   * still shows it: a file that turns up here, or its PC coming back, shows it without reopening the chat.
   */
  private later(key: string): void {
    const ms = this.wait(key);
    this.tries.set(key, (this.tries.get(key) ?? 0) + 1);
    const t = setTimeout(() => {
      if (this.got.get(key) !== null) return;
      this.got.delete(key);
      this.failed.delete(key);
      this.landed(key);
    }, ms);
    (t as { unref?: () => void }).unref?.();
  }

  /** `key` rests: the least recently shown go past `restBytes`. */
  toRest(key: string, v: Got): void {
    if (this.rest.has(key)) return;
    const n = v.image.width * v.image.height * 4;
    this.rest.set(key, n);
    this.restTotal += n;
    this.trimRest();
  }

  private trimRest(): void {
    for (const [k, n] of this.rest) {
      if (this.restTotal <= this.restBytes) break;
      this.rest.delete(k);
      this.restTotal -= n;
      this.got.delete(k);
    }
  }

  /** A resting image is shown again. */
  rested(key: string): void {
    const n = this.rest.get(key);
    if (n === undefined) return;
    this.rest.delete(key);
    this.restTotal -= n;
  }

  /** After a view's build: images no view asked for since its last sweep rest (up to `restBytes`, the least recently
   * shown going first); the others are let go (decoded again if shown again). One still decoding goes on: it rests
   * when it's there (switching through chats quickly keeps what each one decoded). */
  sweep(): void {
    for (const [k, v] of this.got) {
      if (v === null || this.rest.has(k) || this.wanted(k)) continue;
      this.toRest(k, v);
    }
    this.trimRest();
    for (const k of this.failed) if (!this.wanted(k)) this.failed.delete(k);
    for (const [slot, k] of this.shown) if (!this.got.has(k)) this.shown.delete(slot);
    for (const k of this.tries.keys()) if (!this.wanted(k)) this.tries.delete(k);
  }
}

/** One transcript's images and videos (the usual view's, or a split pane's), drawn from the shared `MediaStore`. Until
 * one is decoded its card keeps its place at its size (read from the file's head), so nothing moves when it comes in. */
export class MediaRows {
  private used = new Set<string>();
  /** What the build before the last sweep asked for: a decode that comes in for one of them is drawn. */
  private last = new Set<string>();
  readonly store: MediaStore;
  /** Placeholders the last `rows` calls drew (images not decoded yet), counted for the switch trace. */
  waiting = 0;

  constructor(
    pkg: MediaPkg,
    readonly loaded: () => void,
    native: (p: Pixels) => Pixels = (p) => p,
    restBytes = REST_BYTES,
    store?: MediaStore,
  ) {
    this.store = store ?? new MediaStore(pkg, native, restBytes);
    this.store.views.add(this);
  }

  /** The view is gone (a split pane closed or off screen): its images rest. */
  close(): void {
    this.used = new Set();
    this.last = new Set();
    this.store.views.delete(this);
    this.store.sweep();
  }

  wants(key: string): boolean {
    return this.used.has(key) || this.last.has(key);
  }

  private get pkg(): MediaPkg {
    return this.store.pkg;
  }

  /** The keys `c`'s images are decoded under, as `rows` asks for them. */
  private keys(c: Card, cwd: string, column: number, scale: number): { key: string; slot: string | null; path: string; cap: number; large: boolean; m: { path: string; caption: string; video: boolean } }[] {
    const cap = inlineCap(column, scale, this.pkg.images.MID_PX);
    return cardMedia(c, (t) => this.pkg.images.mediaIn(t, cwd)).map((m) => {
      if (m.video) return { key: `v${cap}:${m.path}`, slot: `v:${m.path}`, path: m.path, cap, large: true, m };
      if (m.shown) return { key: `l${cap}:${m.path}`, slot: `l:${m.path}`, path: m.path, cap, large: true, m };
      return { key: `t:${m.path}`, slot: null, path: m.path, cap: this.pkg.images.THUMB_PX, large: false, m };
    });
  }

  /**
   * The card's images and videos. `fetch`: for a chat that runs on another PC, an image that isn't on
   * this PC is asked for from that PC (once) and kept here (media.ts `saveRemote`), then drawn from it.
   */
  rows(c: Card, cwd: string, column: number, scale = 2, fetch?: (path: string) => Promise<Uint8Array | null>): MediaRow[] {
    const out: MediaRow[] = [];
    for (const k of this.keys(c, cwd, column, scale)) {
      if (k.m.video) {
        out.push(this.video(k.key, k.slot, k.path, column, k.cap, fetch ?? null));
        continue;
      }
      const got = this.take(k.slot, k.key, k.path, k.cap, fetch ?? null);
      // Not decoded yet: its place, at its size, when its file says it (a missing or broken one has none).
      const dims = got?.dims ?? (this.store.failed.has(k.key) ? null : this.store.sizeAhead(k.path));
      if (!dims) continue;
      if (!got) this.waiting++;
      const [w, h] = k.large ? fitIn(dims[0], dims[1], this.pkg.images.inlineSize(column)) : THUMB;
      out.push({ image: got?.image ?? noPixels, caption: k.m.caption, large: k.large, w, h, path: k.path, video: false, name: "", slot: -1, thumbs: 0 });
    }
    // The thumbnails' places in their grid (chat.slint `ThumbGrid`): the large ones and videos show on their own.
    const thumbs = out.filter((m) => !m.large);
    thumbs.forEach((m, i) => {
      m.slot = i;
      m.thumbs = thumbs.length;
    });
    return out;
  }

  /** Decodes the images of `cards` that aren't yet (images.ts runs them off the main thread), without drawing them:
   * settles when they're all in, or failed. A chat about to be shown (or likely next) has them ready for its first
   * frame; any no view shows meanwhile rest. Null: all of them are in already. */
  ahead(cards: Card[], cwd: string, column: number, scale = 2, fetch?: (path: string) => Promise<Uint8Array | null>): Promise<void> | null {
    const all: Promise<void>[] = [];
    for (const c of cards) {
      for (const k of this.keys(c, cwd, column, scale)) {
        if (this.store.got.get(k.key)) continue;
        // A large image whose file is no larger than an earlier decode needs none (`take` uses that one).
        const prev = k.slot === null ? undefined : this.store.shown.get(k.slot);
        const old = prev === undefined ? undefined : this.store.got.get(prev);
        if (old && old.image.width === old.dims[0] && old.image.height === old.dims[1] && Math.max(old.dims[0], old.dims[1]) <= k.cap) continue;
        if (!k.m.video && this.store.sizeAhead(k.path) === null) continue;
        all.push(this.store.decode(k.key, k.path, k.cap, fetch ?? null, null));
      }
    }
    return all.length === 0 ? null : Promise.all(all).then(() => undefined);
  }

  private take(slot: string | null, key: string, path: string, cap: number, fetch: ((path: string) => Promise<Uint8Array | null>) | null): Got | null {
    const st = this.store;
    this.used.add(key);
    const img = st.got.get(key);
    if (img) {
      st.rested(key);
      if (slot !== null && st.shown.get(slot) !== key) st.shown.set(slot, key);
      return img;
    }
    const prev = slot === null ? undefined : st.shown.get(slot);
    const old = prev !== undefined && prev !== key ? st.got.get(prev) : undefined;
    // The file is no larger than either size: the new decode would be the same pixels.
    if (old && slot !== null && old.image.width === old.dims[0] && old.image.height === old.dims[1] && Math.max(old.dims[0], old.dims[1]) <= cap) {
      st.got.set(key, old);
      st.shown.set(slot, key);
      return old;
    }
    if (img === undefined) void st.decode(key, path, cap, fetch, slot);
    if (!old || prev === undefined || slot === null) return null;
    if (st.failed.has(key)) {
      // The new size can't be decoded: the old one stays.
      st.got.set(key, old);
      st.shown.set(slot, key);
      return old;
    }
    this.used.add(prev);
    st.rested(prev);
    return old;
  }

  /** images.rs `video`: its poster (a dark card until then, or without ffmpeg) under a play button. */
  private video(key: string, slot: string | null, path: string, column: number, cap: number, fetch: ((path: string) => Promise<Uint8Array | null>) | null): MediaRow {
    const max = this.pkg.images.inlineSize(column);
    const got = this.take(slot, key, path, cap, fetch);
    const name = this.pkg.images.imageName(path);
    const wide = Math.min(max[0], 360);
    const [w, h] = got ? fitIn(got.dims[0], got.dims[1], max) : [wide, Math.round(wide * 0.5625)];
    return { image: got?.image ?? noPixels, caption: "", large: true, w: Math.max(w, 160), h: Math.max(h, 90), path, video: true, name, slot: -1, thumbs: 0 };
  }

  /** After a build: what it asked for is what this view shows; images no view shows any more rest (`MediaStore.sweep`). */
  sweep(): void {
    this.last = this.used;
    this.used = new Set();
    this.store.sweep();
  }

  /** The first wait before a failed image is tried again (tests make it short). */
  static RETRY_MS = 15_000;
}
