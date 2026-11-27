// Previews of local files that aren't plain pictures (the Persons composer's attachments): a video's or audio file's
// length (ffprobe), a still of a video or of a picture sharp can't read, such as BMP or HEIC (ffmpeg), and a PDF's
// first page and page count (poppler's pdftoppm / pdfinfo; without pdfinfo the page objects are counted). Stills go
// into the media cache, keyed by the file's path, size and mtime. Every answer is null when the tool isn't installed
// (Windows and macOS often lack them) or can't read the file: the composer shows the file's type icon instead.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./media.ts";

/** A tool's output (stdout) when it exits 0 within `ms`, else null (missing, failed or too slow). */
async function output(cmd: string[], ms: number): Promise<string | null> {
  if (!Bun.which(cmd[0]!)) return null;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return null;
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), ms);
  const text = await new Response(proc.stdout as ReadableStream).text().catch(() => "");
  const code = await proc.exited;
  clearTimeout(timer);
  return code === 0 ? text : null;
}

/** Where a still of `file` goes (null: the file isn't there). */
function stillPath(file: string, what: string): string | null {
  try {
    const m = statSync(file);
    if (!m.isFile()) return null;
    const key = createHash("sha256").update(`${what}|${file}|${m.size}|${Math.floor(m.mtimeMs)}`).digest("hex").slice(0, 20);
    return join(cacheDir(), "previews", `${key}.jpg`);
  } catch {
    return null;
  }
}

const nonEmpty = (f: string): boolean => {
  try {
    return statSync(f).size > 0;
  } catch {
    return false;
  }
};

/** A media file's length in seconds (ffprobe), or null. */
export async function duration(file: string): Promise<number | null> {
  const out = await output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "--", file], 10_000);
  const n = Number.parseFloat(out?.trim() ?? "");
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A JPEG still of a video (half a second in, else its first frame) or of a picture ffmpeg reads, at most `px` wide. */
export async function still(file: string, px = 640): Promise<string | null> {
  const out = stillPath(file, `still${px}`);
  if (!out) return null;
  if (existsSync(out)) return out;
  if (!Bun.which("ffmpeg")) return null;
  mkdirSync(join(cacheDir(), "previews"), { recursive: true });
  const part = out.replace(/\.jpg$/, ".part.jpg");
  for (const at of ["0.5", "0"]) {
    const ok = await output(["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", at, "-i", file, "-frames:v", "1", "-vf", `scale='min(${px},iw)':-2`, "-q:v", "4", part], 20_000);
    if (ok !== null && nonEmpty(part)) {
      renameSync(part, out);
      return out;
    }
  }
  rmSync(part, { force: true });
  return null;
}

/** A JPEG of a PDF's first page, at most `px` on its long side (pdftoppm), or null. */
export async function pdfPage(file: string, px = 480): Promise<string | null> {
  const out = stillPath(file, `pdf${px}`);
  if (!out) return null;
  if (existsSync(out)) return out;
  if (!Bun.which("pdftoppm")) return null;
  mkdirSync(join(cacheDir(), "previews"), { recursive: true });
  const base = out.replace(/\.jpg$/, ".part");
  const ok = await output(["pdftoppm", "-f", "1", "-l", "1", "-singlefile", "-jpeg", "-scale-to", String(px), "--", file, base], 20_000);
  const made = `${base}.jpg`;
  if (ok !== null && nonEmpty(made)) {
    renameSync(made, out);
    return out;
  }
  rmSync(made, { force: true });
  return null;
}

/** The page count a PDF's text gives when nothing parses it: its `/Type /Page` objects (not `/Pages`). Compressed
 *  object streams hide them: 0 then. */
export function countPages(pdf: string): number {
  return pdf.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
}

/** A PDF's page count (pdfinfo, else its page objects counted), or null. */
export async function pdfPages(file: string): Promise<number | null> {
  const info = await output(["pdfinfo", "--", file], 10_000);
  const m = info?.match(/^Pages:\s+(\d+)/m);
  if (m) return Number(m[1]);
  try {
    const n = countPages((await readFile(file)).toString("latin1"));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}
