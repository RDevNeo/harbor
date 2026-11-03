import { type Card, cardMedia } from "@harbor/net";
import type { Pixels } from "./logos.ts";
import { noPixels, type MediaRow } from "./window.ts";

type MediaPkg = typeof import("@harbor/media");

const THUMB: [number, number] = [132, 96];
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

/** Decoded images by path and size class; a card shows an image once it's decoded. Only the images of the
 * cards last built are kept (`sweep`): a large one is a few MB, and a long chat has many.
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
  ) {}

  rows(c: Card, cwd: string, column: number, scale = 2): MediaRow[] {
    const out: MediaRow[] = [];
    const cap = inlineCap(column, scale, this.pkg.images.MID_PX);
    for (const m of cardMedia(c, (t) => this.pkg.images.mediaIn(t, cwd))) {
      if (m.video) {
        out.push(this.video(m.path, column, cap));
        continue;
      }
      const large = m.shown;
      const got = large ? this.take(`l:${m.path}`, `l${cap}:${m.path}`, m.path, cap) : this.take(null, `t:${m.path}`, m.path, this.pkg.images.THUMB_PX);
      if (!got) continue;
      const [w, h] = large ? fitIn(got.dims[0], got.dims[1], this.pkg.images.inlineSize(column)) : THUMB;
      out.push({ image: got.image, caption: m.caption, large, w, h, path: m.path, video: false, name: "", slot: -1, thumbs: 0 });
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
  private take(slot: string | null, key: string, path: string, cap: number): Got | null {
    this.used.add(key);
    const img = this.got.get(key);
    if (img) return img;
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
          this.got.set(key, { image: this.native(image), dims });
          if (slot !== null) this.shown.set(slot, key);
          this.loaded();
        })
        .catch(() => {
          if (slot === null) return;
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
    return old;
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

  /** After a build: images no card asked for since the last sweep are let go (decoded again if shown again). */
  sweep(): void {
    for (const k of this.got.keys()) if (!this.used.has(k)) this.got.delete(k);
    for (const k of this.failed) if (!this.used.has(k)) this.failed.delete(k);
    for (const [slot, k] of this.shown) if (!this.used.has(k)) this.shown.delete(slot);
    this.used.clear();
  }
}
