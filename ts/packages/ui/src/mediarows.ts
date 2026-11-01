import { type Card, cardMedia } from "@harbor/net";
import type { Pixels } from "./logos.ts";
import { noPixels, type MediaRow } from "./window.ts";

type MediaPkg = typeof import("@harbor/media");

const THUMB: [number, number] = [132, 96];

/** A large image's size in the transcript: its own, shrunk to fit `box`. */
export function fitIn(w: number, h: number, box: [number, number]): [number, number] {
  const k = Math.min(1, box[0] / Math.max(w, 1), box[1] / Math.max(h, 1));
  return [Math.round(w * k), Math.round(h * k)];
}

/** Decoded images by path and size class; a card shows an image once it's decoded. */
export class MediaRows {
  private got = new Map<string, Pixels | null>();
  private failed = new Set<string>();

  constructor(
    private pkg: MediaPkg,
    private loaded: () => void,
  ) {}

  rows(c: Card, cwd: string, column: number): MediaRow[] {
    const out: MediaRow[] = [];
    for (const m of cardMedia(c, (t) => this.pkg.images.mediaIn(t, cwd))) {
      if (m.video) {
        out.push(this.video(m.path, column));
        continue;
      }
      const large = m.shown;
      const key = `${large ? "l" : "t"}:${m.path}`;
      const img = this.got.get(key);
      if (img === undefined) {
        this.got.set(key, null);
        this.pkg.images
          .decode(m.path, null, large ? this.pkg.images.MID_PX : this.pkg.images.THUMB_PX)
          .then(({ image }) => {
            this.got.set(key, image);
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
  private video(path: string, column: number): MediaRow {
    const key = `v:${path}`;
    const max = this.pkg.images.inlineSize(column);
    const img = this.got.get(key);
    if (img === undefined) {
      this.got.set(key, null);
      this.pkg.images
        .decode(path, null, this.pkg.images.MID_PX)
        .then(({ image }) => {
          this.got.set(key, image);
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
}
