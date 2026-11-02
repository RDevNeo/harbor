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

/** Decoded images by path and size class; a card shows an image once it's decoded. Only the images of the
 * cards last built are kept (`sweep`): a large one is a few MB, and a long chat has many. */
export class MediaRows {
  private got = new Map<string, Pixels | null>();
  private failed = new Set<string>();
  private used = new Set<string>();

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
      const key = large ? `l${cap}:${m.path}` : `t:${m.path}`;
      this.used.add(key);
      const img = this.got.get(key);
      if (img === undefined) {
        this.got.set(key, null);
        this.pkg.images
          .decode(m.path, null, large ? cap : this.pkg.images.THUMB_PX)
          .then(({ image }) => {
            if (this.got.get(key) !== null) return;
            this.got.set(key, this.native(image));
            this.loaded();
          })
          .catch(() => {});
        continue;
      }
      if (img === null) continue;
      const [w, h] = large ? fitIn(img.width, img.height, this.pkg.images.inlineSize(column)) : THUMB;
      out.push({ image: img, caption: m.caption, large, w, h, path: m.path, video: false, name: "" });
    }
    return out;
  }

  /** images.rs `video`: its poster (a dark card until then, or without ffmpeg) under a play button. */
  private video(path: string, column: number, cap: number): MediaRow {
    const key = `v${cap}:${path}`;
    this.used.add(key);
    const max = this.pkg.images.inlineSize(column);
    const img = this.got.get(key);
    if (img === undefined) {
      this.got.set(key, null);
      this.pkg.images
        .decode(path, null, cap)
        .then(({ image }) => {
          if (this.got.get(key) !== null) return;
          this.got.set(key, this.native(image));
          this.loaded();
        })
        .catch(() => {
          this.failed.add(key);
          this.loaded();
        });
    }
    const name = this.pkg.images.imageName(path);
    const wide = Math.min(max[0], 360);
    const [w, h] = img ? fitIn(img.width, img.height, max) : [wide, Math.round(wide * 0.5625)];
    return { image: img ?? noPixels, caption: "", large: true, w: Math.max(w, 160), h: Math.max(h, 90), path, video: true, name };
  }

  /** After a build: images no card asked for since the last sweep are let go (decoded again if shown again). */
  sweep(): void {
    for (const k of this.got.keys()) if (!this.used.has(k)) this.got.delete(k);
    this.used.clear();
  }
}
