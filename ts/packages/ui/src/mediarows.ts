import { type Card, cardMedia } from "@harbor/net";
import type { Pixels } from "./logos.ts";
import { noPixels, type MediaRow } from "./window.ts";

type MediaPkg = typeof import("@harbor/media");

const THUMB: [number, number] = [132, 96];
/** Decoded images no card of the last build shows, kept for when their chat is shown again. */
export const REST_BYTES = 32 * 2 ** 20;
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

/** Decoded images by path and size class. Until one is decoded its card keeps its place at its size (read from the
 * file's head), so nothing moves when it comes in. The images of the cards last built are kept, and those of cards
 * built before (another chat that was just open) up to REST_BYTES, the least recently shown going first (`sweep`):
 * a large one is a few MB, and a long chat has many.
 *
 * A large image's size class follows the screen's scale (zoom, another display), so a new scale asks for a new
 * decode. Until it's there the card keeps the image it has (`shown`): an image on the screen never goes blank or
 * back to its link while it's decoded again. One the file's own size already fits isn't decoded again at all. */
export class MediaRows {
  private got = new Map<string, Got | null>();
  private failed = new Set<string>();
  private used = new Set<string>();
  /** The last key decoded for a path's large image or video poster (`l:` or `v:` and the path). */
  private shown = new Map<string, string>();

  constructor(
    private pkg: MediaPkg,
    private loaded: () => void,
    /** The decoded pixels as an image the window holds, so the models share it and JS lets its copy go. */
    private native: (p: Pixels) => Pixels = (p) => p,
    private restBytes = REST_BYTES,
  ) {}

  /** Decoded images no card of the last build asked for, least recently shown first, and their bytes. */
  private rest = new Map<string, number>();
  private restTotal = 0;
  /** Images' sizes before they're decoded (null: not known), by path. */
  private ahead = new Map<string, [number, number] | null>();

  private sizeAhead(path: string): [number, number] | null {
    let v = this.ahead.get(path);
    if (v === undefined) {
      if (this.ahead.size >= AHEAD_MAX) this.ahead.clear();
      v = this.pkg.images.sizeAhead(path);
      this.ahead.set(path, v);
    }
    return v;
  }

  /** Images asked for from their chat's PC: when each may be asked again (never once it came). */
  private asked = new Map<string, number>();
  /** Images that failed to show: how many times, for the wait before the next try (`later`). */
  private tries = new Map<string, number>();

  /**
   * The card's images and videos. `fetch`: for a chat that runs on another PC, an image that isn't on
   * this PC is asked for from that PC (once) and kept here (media.ts `saveRemote`), then drawn from it.
   */
  rows(c: Card, cwd: string, column: number, scale = 2, fetch?: (path: string) => Promise<Uint8Array | null>): MediaRow[] {
    this.fetch = fetch ?? null;
    const out: MediaRow[] = [];
    const cap = inlineCap(column, scale, this.pkg.images.MID_PX);
    for (const m of cardMedia(c, (t) => this.pkg.images.mediaIn(t, cwd))) {
      if (m.video) {
        out.push(this.video(m.path, column, cap));
        continue;
      }
      const large = m.shown;
      const key = large ? `l${cap}:${m.path}` : `t:${m.path}`;
      const got = large ? this.take(`l:${m.path}`, key, m.path, cap) : this.take(null, key, m.path, this.pkg.images.THUMB_PX);
      // Not decoded yet: its place, at its size, when its file says it (a missing or broken one has none).
      const dims = got?.dims ?? (this.failed.has(key) ? null : this.sizeAhead(m.path));
      if (!dims) continue;
      const [w, h] = large ? fitIn(dims[0], dims[1], this.pkg.images.inlineSize(column)) : THUMB;
      out.push({ image: got?.image ?? noPixels, caption: m.caption, large, w, h, path: m.path, video: false, name: "", slot: -1, thumbs: 0 });
    }
    // The thumbnails' places in their grid (chat.slint `ThumbGrid`): the large ones and videos show on their own.
    const thumbs = out.filter((m) => !m.large);
    thumbs.forEach((m, i) => {
      m.slot = i;
      m.thumbs = thumbs.length;
    });
    return out;
  }

  /** `key`'s image, decoded to `cap` if it isn't yet. Meanwhile the one decoded last under `slot` (another scale's),
   * kept until the new one is there. */
  private fetch: ((path: string) => Promise<Uint8Array | null>) | null = null;

  /** An image that failed to decode here: fetched from its chat's PC when it can be (true: it's coming). */
  private fromHome(path: string, key: string): boolean {
    const fetch = this.fetch;
    if (fetch === null || (this.asked.get(path) ?? 0) > Date.now() || this.pkg.media.isVideo(path)) return false;
    this.asked.set(path, Number.POSITIVE_INFINITY);
    void fetch(path)
      .then((bytes) => (bytes !== null ? this.pkg.media.saveRemote(path, bytes) : null))
      .catch(() => null)
      .then((saved) => {
        // Kept here: decoded again from the copy (media.ts `located` finds it).
        if (saved !== null) {
          this.got.delete(key);
          this.loaded();
          return;
        }
        // That PC is off, or doesn't have it (yet): a link for now, asked for again a little later.
        this.asked.set(path, Date.now() + this.wait(key));
        this.failed.add(key);
        this.later(key);
        this.loaded();
      });
    return true;
  }

  /** The wait before an image that failed is tried again: 15 s, doubling up to 5 minutes. */
  private wait(key: string): number {
    return Math.min(5 * 60_000, MediaRows.RETRY_MS * 2 ** (this.tries.get(key) ?? 0));
  }

  /** The first wait before a failed image is tried again (tests make it short). */
  static RETRY_MS = 15_000;

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
      this.loaded();
    }, ms);
    (t as { unref?: () => void }).unref?.();
  }

  private take(slot: string | null, key: string, path: string, cap: number): Got | null {
    this.used.add(key);
    const img = this.got.get(key);
    if (img) {
      this.rested(key);
      return img;
    }
    const prev = slot === null ? undefined : this.shown.get(slot);
    const old = prev !== undefined && prev !== key ? this.got.get(prev) : undefined;
    // The file is no larger than either size: the new decode would be the same pixels.
    if (old && slot !== null && old.image.width === old.dims[0] && old.image.height === old.dims[1] && Math.max(old.dims[0], old.dims[1]) <= cap) {
      this.got.set(key, old);
      this.shown.set(slot, key);
      return old;
    }
    if (img === undefined) {
      this.got.set(key, null);
      this.pkg.images
        .decode(path, null, cap)
        .then(({ image, dims }) => {
          if (this.got.get(key) !== null) return;
          this.tries.delete(key);
          this.ahead.set(path, dims);
          this.got.set(key, { image: this.native(image), dims });
          if (slot !== null) this.shown.set(slot, key);
          this.loaded();
        })
        .catch(() => {
          if (this.fromHome(path, key)) return;
          // A video without a poster (no ffmpeg) keeps its dark card: nothing to try again.
          if (!this.pkg.media.isVideo(path)) this.later(key);
          // Its place (kept while it was decoded) goes.
          this.failed.add(key);
          this.loaded();
        });
    }
    if (!old || prev === undefined || slot === null) return null;
    if (this.failed.has(key)) {
      // The new size can't be decoded: the old one stays.
      this.got.set(key, old);
      this.shown.set(slot, key);
      return old;
    }
    this.used.add(prev);
    this.rested(prev);
    return old;
  }

  /** A resting image is shown again. */
  private rested(key: string): void {
    const n = this.rest.get(key);
    if (n === undefined) return;
    this.rest.delete(key);
    this.restTotal -= n;
  }

  /** images.rs `video`: its poster (a dark card until then, or without ffmpeg) under a play button. */
  private video(path: string, column: number, cap: number): MediaRow {
    const key = `v${cap}:${path}`;
    const max = this.pkg.images.inlineSize(column);
    const got = this.take(`v:${path}`, key, path, cap);
    const name = this.pkg.images.imageName(path);
    const wide = Math.min(max[0], 360);
    const [w, h] = got ? fitIn(got.dims[0], got.dims[1], max) : [wide, Math.round(wide * 0.5625)];
    return { image: got?.image ?? noPixels, caption: "", large: true, w: Math.max(w, 160), h: Math.max(h, 90), path, video: true, name, slot: -1, thumbs: 0 };
  }

  /** After a build: images no card asked for since the last sweep rest (up to `restBytes`, the least recently shown
   * going first); the others are let go (decoded again if shown again). One still decoding goes too. */
  sweep(): void {
    for (const [k, v] of this.got) {
      if (this.used.has(k) || this.rest.has(k)) continue;
      if (v === null) {
        this.got.delete(k);
        continue;
      }
      const n = v.image.width * v.image.height * 4;
      this.rest.set(k, n);
      this.restTotal += n;
    }
    for (const [k, n] of this.rest) {
      if (this.restTotal <= this.restBytes) break;
      this.rest.delete(k);
      this.restTotal -= n;
      this.got.delete(k);
    }
    for (const k of this.failed) if (!this.used.has(k)) this.failed.delete(k);
    for (const [slot, k] of this.shown) if (!this.got.has(k)) this.shown.delete(slot);
    for (const k of this.tries.keys()) if (!this.used.has(k)) this.tries.delete(k);
    this.used.clear();
  }
}
