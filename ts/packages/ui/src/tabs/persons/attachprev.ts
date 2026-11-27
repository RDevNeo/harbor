// What the composer's attachment tiles show of each file, learnt once per file in the background (then drawn again):
// its size, a video's or audio file's length, and the still the tile shows: the picture itself (sharp reads it), a
// frame of a video or of a picture only ffmpeg reads (BMP, HEIC…), a PDF's first page and page count. A tool that
// isn't installed leaves its part out: the tile shows the type's icon and what is known.
import { statSync } from "node:fs";
import { preview } from "@harbor/media";
import { type AttachType, attachType } from "./attachkind.ts";

export interface AttachInfo {
  size: number | null;
  /** The file the tile's picture is decoded from; null: none (yet). */
  still: string | null;
  duration: number | null;
  pages: number | null;
}

export class AttachPreviews {
  private known = new Map<string, AttachInfo>();
  /** `px`: the stills' size (a video's or odd picture's width, a PDF page's long side): small for the composer's
   *  tiles, larger for a bubble's page preview. */
  constructor(
    private readonly changed: () => void,
    private readonly px: { still: number; pdf: number } = { still: 320, pdf: 240 },
  ) {}

  /** `t`: the file's type when its path doesn't say it (a received file without an extension). */
  get(path: string, t: AttachType = attachType(path)): AttachInfo {
    const hit = this.known.get(path);
    if (hit) return hit;
    let size: number | null = null;
    try {
      size = statSync(path).size;
    } catch {
      // gone
    }
    const info: AttachInfo = { size, still: t.kind === "image" && t.direct ? path : null, duration: null, pages: null };
    this.known.set(path, info);
    const jobs: Promise<unknown>[] = [];
    if (t.kind === "video" || t.kind === "audio") jobs.push(preview.duration(path).then((d) => (info.duration = d)));
    if (t.kind === "video" || (t.kind === "image" && !t.direct)) jobs.push(preview.still(path, this.px.still).then((p) => (info.still = p)));
    if (t.kind === "pdf") jobs.push(preview.pdfPage(path, this.px.pdf).then((p) => (info.still = p)), preview.pdfPages(path).then((n) => (info.pages = n)));
    if (jobs.length) void Promise.all(jobs.map((j) => j.catch(() => null))).then(() => this.changed());
    return info;
  }

  /** Drops what's known of files no composer holds any more. */
  keepOnly(paths: Iterable<string>): void {
    const keep = new Set(paths);
    for (const k of [...this.known.keys()]) if (!keep.has(k)) this.known.delete(k);
  }
}
