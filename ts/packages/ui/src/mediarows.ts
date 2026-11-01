import { type Card, cardMedia } from "@harbor/net";
import type { Pixels } from "./logos.ts";
import type { MediaRow } from "./window.ts";

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

  constructor(
    private pkg: MediaPkg,
    private loaded: () => void,
  ) {}

  rows(c: Card, cwd: string, column: number): MediaRow[] {
    const out: MediaRow[] = [];
    for (const m of cardMedia(c, (t) => this.pkg.images.mediaIn(t, cwd))) {
      if (m.video) continue;
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
      out.push({ image: img, caption: m.caption, large, w, h, path: m.path });
    }
    return out;
  }
}
