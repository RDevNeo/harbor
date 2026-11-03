import type { Pixels } from "./logos.ts";
import { isImage } from "./logic/images.ts";
import { type FileItem, noPixels } from "./window.ts";

/** The composer's attachments as `FileItem`s: an image is a tile showing its picture, anything else (or an image
 * that can't be decoded) a chip. Each picture is decoded once, small (`CAP` px on its long side: a 64 px picture on
 * a scaled or zoomed screen), and handed to the window as its own image, so redraws share it. */
export class AttachThumbs {
  static readonly CAP = 256;
  /** null: being decoded; false: it can't be. */
  private got = new Map<string, Pixels | null | false>();

  constructor(
    /** null: decoding isn't available yet. */
    private decode: (path: string, cap: number) => Promise<Pixels> | null,
    /** A picture arrived (or failed): the composer's files want building again. */
    private loaded: () => void,
    private native: (p: Pixels) => Pixels = (p) => p,
  ) {}

  items(files: readonly string[]): FileItem[] {
    let n = 0;
    let tiles = 0;
    let chips = 0;
    return files.map((p) => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      if (!isImage(p)) return { name, image: false, tile: false, thumb: noPixels, number: 0, slot: chips++ };
      n++;
      const t = this.thumb(p);
      const tile = t !== false;
      return { name, image: true, tile, thumb: t || noPixels, number: n, slot: tile ? tiles++ : chips++ };
    });
  }

  /** Pictures of files no draft holds any more are let go. */
  keep(attached: Iterable<readonly string[]>): void {
    const live = new Set<string>();
    for (const list of attached) for (const p of list) live.add(p);
    for (const p of this.got.keys()) if (!live.has(p)) this.got.delete(p);
  }

  private thumb(path: string): Pixels | null | false {
    const got = this.got.get(path);
    if (got !== undefined) return got;
    const job = this.decode(path, AttachThumbs.CAP);
    // Nothing decodes yet (the media package is still loading): a blank tile, asked again on the next build.
    if (job === null) return null;
    this.got.set(path, null);
    job.then(
      (image) => {
        if (this.got.get(path) !== null) return;
        this.got.set(path, this.native(image));
        this.loaded();
      },
      () => {
        if (this.got.get(path) !== null) return;
        this.got.set(path, false);
        this.loaded();
      },
    );
    return null;
  }
}

/** Rows are the same when the model needn't change: a picture that arrived makes a new row. */
export function sameFile(a: FileItem, b: FileItem): boolean {
  return a.name === b.name && a.image === b.image && a.tile === b.tile && a.number === b.number && a.slot === b.slot && a.thumb === b.thumb;
}
