import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@harbor/store";
import { type Decoded, decodeBytes } from "./images.ts";
import { sharpLib } from "./sharplib.ts";

/** People's photos (the account directory's `image`: Clerk's image URL), round, for Settings › Workspace. Fetched
 *  once over HTTPS and kept by URL (a new photo is a new URL) under dataDir/photos; until one is here, or without
 *  one, the row keeps its icon. */

/** Pixels on a side (drawn at 22 px, crisp at 2x and more). */
export const SIZE = 64;
const MAX_BYTES = 4 << 20;
const KEEP_FILES = 200;
const RETRY_MS = 10 * 60_000;
/** Made-up photos for screenshots and tests: `.example` never resolves, so these are drawn here, never fetched. */
const FAKE = "https://photos.example/";

const dir = (): string => join(dataDir(), "photos");
const fileOf = (url: string): string => join(dir(), createHash("sha1").update(url).digest("hex"));

/** A source of photos: `get(url)` answers at once (null until it's here), loads it in the background and calls
 *  `loaded` when it came, so the page draws again. */
export function source(loaded: () => void, fetcher: (url: string) => Promise<Uint8Array | null> = fetchPhoto): (url: string) => Decoded | null {
  const have = new Map<string, Decoded>();
  const asked = new Map<string, number>();
  return (url: string): Decoded | null => {
    if (url === "") return null;
    const got = have.get(url);
    if (got) return got;
    const at = asked.get(url);
    if (at !== undefined && Date.now() - at < RETRY_MS) return null;
    asked.set(url, Date.now());
    void load(url, fetcher).then((img) => {
      if (!img) return;
      have.set(url, img);
      asked.delete(url);
      loaded();
    });
    return null;
  };
}

/** The photo from the cache folder, else fetched (and kept); null when it can't be had. */
export async function load(url: string, fetcher: (url: string) => Promise<Uint8Array | null> = fetchPhoto): Promise<Decoded | null> {
  if (url.startsWith(FAKE)) return fake(url.slice(FAKE.length));
  const f = fileOf(url);
  try {
    const img = await round(readFileSync(f));
    if (img) return img;
  } catch {
    // not cached yet
  }
  const bytes = await fetcher(url).catch(() => null);
  if (!bytes) return null;
  const img = await round(bytes);
  if (!img) return null;
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(`${f}.tmp`, bytes);
    renameSync(`${f}.tmp`, f);
    prune();
  } catch {
    // shown anyway; fetched again next time
  }
  return img;
}

/** Only HTTPS (also after redirects), at most 4 MB. */
export async function fetchPhoto(url: string): Promise<Uint8Array | null> {
  if (!url.startsWith("https://")) return null;
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok || !r.url.startsWith("https://")) return null;
  if (Number(r.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
  const b = new Uint8Array(await r.arrayBuffer());
  return b.length > MAX_BYTES ? null : b;
}

/** Any image: center-cropped square, SIZE px, outside the circle transparent. */
export async function round(bytes: Uint8Array): Promise<Decoded | null> {
  try {
    const sharp = await sharpLib();
    const { image } = await decodeBytes(bytes, SIZE * 4);
    const out = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
      .resize(SIZE, SIZE, { fit: "cover", kernel: "lanczos3" })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const data = new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength);
    circle(data, SIZE);
    return { width: SIZE, height: SIZE, data };
  } catch {
    return null;
  }
}

/** Clears what lies outside the circle, with a one-pixel soft edge. */
export function circle(rgba: Uint8Array | Uint8ClampedArray, n: number): void {
  const c = n / 2;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const a = Math.max(0, Math.min(1, c - d + 0.5));
      if (a < 1) rgba[(y * n + x) * 4 + 3] = Math.round(rgba[(y * n + x) * 4 + 3]! * a);
    }
}

const FAKE_COLOURS: [number[], number[]][] = [
  [[0x3b, 0x6e, 0xa8], [0x7f, 0xb3, 0xd5]],
  [[0x8a, 0x5a, 0x9e], [0xe3, 0xa0, 0x6b]],
  [[0x2f, 0x7d, 0x5b], [0x9c, 0xd3, 0x8a]],
  [[0xb0, 0x4a, 0x3c], [0xf0, 0xb2, 0x7a]],
  [[0x4a, 0x4f, 0x9e], [0xc0, 0x7f, 0xd8]],
];

/** Which colours a made-up photo has: Sam's blue, anyone else's by the letters of their name (Rig.java's alike). */
export function fakeColour(who: string): number {
  if (who === "sam") return 0;
  let n = 0;
  for (const ch of who) n += ch.charCodeAt(0);
  return 1 + (n % (FAKE_COLOURS.length - 1));
}

/** A made-up photo: a soft two-colour background and a figure (Rig.java draws the phone's alike). */
export function fake(who: string): Decoded {
  const n = SIZE;
  const [a, b] = FAKE_COLOURS[fakeColour(who)]!;
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const t = (x + y) / (2 * n);
      const i = (y * n + x) * 4;
      const head = Math.hypot(x - n / 2, y - n * 0.4) < n * 0.17;
      const body = ((x - n / 2) / (n * 0.32)) ** 2 + ((y - n * 0.86) / (n * 0.24)) ** 2 < 1;
      const px = head || body ? [0xf4, 0xed, 0xe4] : [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * t));
      data.set([px[0]!, px[1]!, px[2]!, 255], i);
    }
  circle(data, n);
  return { width: n, height: n, data };
}

/** At most KEEP_FILES photos kept: the oldest go. */
function prune(): void {
  const all = readdirSync(dir()).filter((f) => !f.endsWith(".tmp"));
  if (all.length <= KEEP_FILES) return;
  const aged = all.map((f) => ({ f, t: statSync(join(dir(), f)).mtimeMs })).sort((x, y) => x.t - y.t);
  for (const { f } of aged.slice(0, all.length - KEEP_FILES)) rmSync(join(dir(), f), { force: true });
}
