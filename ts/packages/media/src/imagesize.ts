// An image's size from its file's first bytes, without decoding it: the transcript keeps an image's place at its
// size while it's decoded, so the cards around it don't move when it comes in.
import { closeSync, openSync, readSync } from "node:fs";

/** How much of a file is read: a JPEG's size comes after its EXIF block, which can hold a thumbnail. */
const HEAD = 128 * 1024;

const be16 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const le16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const be32 = (b: Uint8Array, at: number): number => be16(b, at) * 0x10000 + be16(b, at + 2);
const le24 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** EXIF orientation (1-8) in a JPEG's APP1 block at `at` (its payload, after the length); 1 when there's none. */
function orientation(b: Uint8Array, at: number, end: number): number {
  if (ascii(b, at, 6) !== "Exif\0\0") return 1;
  const t = at + 6;
  const little = ascii(b, t, 2) === "II";
  const u16 = (p: number) => (little ? le16(b, p) : be16(b, p));
  const u32 = (p: number) => (little ? u16(p) + u16(p + 2) * 0x10000 : u16(p) * 0x10000 + u16(p + 2));
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return 1;
}

/** Width and height as the image is drawn (a JPEG turned by its EXIF orientation is drawn turned); null: not known. */
export function sizeOf(b: Uint8Array): [number, number] | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") return ok(be32(b, 16), be32(b, 20));
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return ok(le16(b, 6), le16(b, 8));
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const kind = ascii(b, 12, 4);
    if (kind === "VP8 ") return ok(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
    if (kind === "VP8L") {
      const [b0, b1, b2, b3] = [b[21] ?? 0, b[22] ?? 0, b[23] ?? 0, b[24] ?? 0];
      return ok(1 + (b0 | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
    }
    if (kind === "VP8X") return ok(1 + le24(b, 24), 1 + le24(b, 27));
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    let turn = 1;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const m = b[at + 1] ?? 0;
      // Fill bytes, and markers without a length.
      if (m === 0xff) {
        at++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        at += 2;
        continue;
      }
      const len = be16(b, at + 2);
      if (m === 0xe1) turn = orientation(b, at + 4, Math.min(b.length, at + 2 + len));
      // Start of frame (not DHT c4, JPG c8, DAC cc): its height, then its width.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = be16(b, at + 5);
        const w = be16(b, at + 7);
        return turn >= 5 ? ok(h, w) : ok(w, h);
      }
      if (m === 0xda || len < 2) return null;
      at += 2 + len;
    }
  }
  return null;
}

function ok(w: number, h: number): [number, number] | null {
  return w > 0 && h > 0 ? [w, h] : null;
}

/** The size of the image in `file` (see sizeOf); null when it can't be read or isn't known from its head. */
export function fileSize(file: string): [number, number] | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const b = new Uint8Array(HEAD);
    const n = readSync(fd, b, 0, HEAD, 0);
    return sizeOf(b.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
