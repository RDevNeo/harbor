// Screenshots as pixels, pure code (no system calls), so it's tested on any system: what the capture tools
// write (PPM, BMP, PNG), a crop, a downscale by area averaging, and a small PNG (RGB, Sub-filtered rows).
import { deflate } from "node:zlib";
import { promisify } from "node:util";
import { decodePng } from "../win32/formats.ts";

/** RGBA, top row first. */
export interface Image {
  w: number;
  h: number;
  rgba: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A binary PPM (P6, maxval 255): what `grim -t ppm` and ImageMagick's `ppm:-` write. */
export function parsePpm(b: Uint8Array): Image | null {
  let o = 0;
  const token = (): string => {
    for (;;) {
      while (o < b.length && /\s/.test(String.fromCharCode(b[o] ?? 0))) o++;
      if (b[o] === 0x23) while (o < b.length && b[o] !== 0x0a) o++;
      else break;
    }
    let s = "";
    while (o < b.length && !/\s/.test(String.fromCharCode(b[o] ?? 0))) s += String.fromCharCode(b[o++] ?? 0);
    return s;
  };
  if (token() !== "P6") return null;
  const w = Number(token());
  const h = Number(token());
  const max = Number(token());
  o++;
  if (!(w > 0 && h > 0) || max !== 255 || b.length - o < w * h * 3) return null;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = o; i < w * h; i++, j += 3) {
    rgba[i * 4] = b[j] ?? 0;
    rgba[i * 4 + 1] = b[j + 1] ?? 0;
    rgba[i * 4 + 2] = b[j + 2] ?? 0;
    rgba[i * 4 + 3] = 255;
  }
  return { w, h, rgba };
}

/** A BMP file of 24 or 32 bits a pixel, uncompressed or with bit fields in BGRA order (what `screencapture -t bmp` writes). */
export function parseBmp(b: Uint8Array): Image | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const off = v.getUint32(10, true);
  const w = v.getInt32(18, true);
  const rawH = v.getInt32(22, true);
  const bpp = v.getUint16(28, true);
  const comp = v.getUint32(30, true);
  if (w <= 0 || rawH === 0 || (bpp !== 24 && bpp !== 32) || (comp !== 0 && comp !== 3)) return null;
  const h = Math.abs(rawH);
  const bytes = bpp / 8;
  const stride = Math.ceil((w * bytes) / 4) * 4;
  if (b.length < off + stride * h) return null;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = off + (rawH > 0 ? h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      const s = src + x * bytes;
      const d = (y * w + x) * 4;
      rgba[d] = b[s + 2] ?? 0;
      rgba[d + 1] = b[s + 1] ?? 0;
      rgba[d + 2] = b[s] ?? 0;
      rgba[d + 3] = 255;
    }
  }
  return { w, h, rgba };
}

/** PNG, PPM or BMP, by its first bytes. */
export function decode(b: Uint8Array): Image | null {
  if (b[0] === 0x89 && b[1] === 0x50) {
    const p = decodePng(b);
    return p ? { w: p.w, h: p.h, rgba: p.rgba } : null;
  }
  if (b[0] === 0x50 && b[1] === 0x36) return parsePpm(b);
  if (b[0] === 0x42 && b[1] === 0x4d) return parseBmp(b);
  return null;
}

/** BGRA rows (Windows' DIBs, top row first) as RGBA, in place; alpha set opaque. */
export function bgraToRgba(px: Uint8Array): Uint8Array {
  for (let i = 0; i < px.length; i += 4) {
    const b = px[i] ?? 0;
    px[i] = px[i + 2] ?? 0;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return px;
}

/** `r` clamped into the image (whole pixels). */
export function clampRect(img: { w: number; h: number }, r: Rect): Rect {
  const x = Math.max(0, Math.min(img.w - 1, Math.floor(r.x)));
  const y = Math.max(0, Math.min(img.h - 1, Math.floor(r.y)));
  const w = Math.max(1, Math.min(img.w - x, Math.round(r.w)));
  const h = Math.max(1, Math.min(img.h - y, Math.round(r.h)));
  return { x, y, w, h };
}

export function crop(img: Image, r: Rect): Image {
  const c = clampRect(img, r);
  if (c.x === 0 && c.y === 0 && c.w === img.w && c.h === img.h) return img;
  const out = new Uint8Array(c.w * c.h * 4);
  for (let y = 0; y < c.h; y++) {
    const s = ((c.y + y) * img.w + c.x) * 4;
    out.set(img.rgba.subarray(s, s + c.w * 4), y * c.w * 4);
  }
  return { w: c.w, h: c.h, rgba: out };
}

/** `img` at `w`×`h`: each target pixel averages the source pixels it covers (fractional edges weighted), so text
 *  stays legible when it shrinks; larger targets are sampled nearest. */
export function resize(img: Image, w: number, h: number): Image {
  if (w === img.w && h === img.h) return img;
  const out = new Uint8Array(w * h * 4);
  const sx = img.w / w;
  const sy = img.h / h;
  if (sx < 1 || sy < 1) {
    for (let y = 0; y < h; y++) {
      const yy = Math.min(img.h - 1, Math.floor((y + 0.5) * sy));
      for (let x = 0; x < w; x++) {
        const xx = Math.min(img.w - 1, Math.floor((x + 0.5) * sx));
        out.set(img.rgba.subarray((yy * img.w + xx) * 4, (yy * img.w + xx) * 4 + 4), (y * w + x) * 4);
      }
    }
    return { w, h, rgba: out };
  }
  const src = img.rgba;
  const acc = new Float64Array(w * 3);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let yy = Math.floor(y0); yy < Math.min(img.h, Math.ceil(y1)); yy++) {
      const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
      const row = yy * img.w * 4;
      for (let x = 0; x < w; x++) {
        const x0 = x * sx;
        const x1 = x0 + sx;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let xx = Math.floor(x0); xx < Math.min(img.w, Math.ceil(x1)); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          const s = row + xx * 4;
          r += (src[s] ?? 0) * wx;
          g += (src[s + 1] ?? 0) * wx;
          b += (src[s + 2] ?? 0) * wx;
        }
        acc[x * 3] = (acc[x * 3] ?? 0) + r * wy;
        acc[x * 3 + 1] = (acc[x * 3 + 1] ?? 0) + g * wy;
        acc[x * 3 + 2] = (acc[x * 3 + 2] ?? 0) + b * wy;
      }
    }
    const area = sx * sy;
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      out[d] = Math.round((acc[x * 3] ?? 0) / area);
      out[d + 1] = Math.round((acc[x * 3 + 1] ?? 0) / area);
      out[d + 2] = Math.round((acc[x * 3 + 2] ?? 0) / area);
      out[d + 3] = 255;
    }
  }
  return { w, h, rgba: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const b of parts) for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const deflateAsync = promisify(deflate);

/** The image as an RGB PNG, rows Sub-filtered (screens are flat areas: a fraction of the unfiltered size). The
 *  compression runs on libuv's pool, off the caller's thread. */
export async function png(img: Image): Promise<Uint8Array> {
  const { w, h, rgba } = img;
  const stride = w * 3 + 1;
  const raw = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const o = y * stride;
    raw[o] = 1;
    let pr = 0;
    let pg = 0;
    let pb = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const r = rgba[s] ?? 0;
      const g = rgba[s + 1] ?? 0;
      const b = rgba[s + 2] ?? 0;
      raw[o + 1 + x * 3] = (r - pr) & 0xff;
      raw[o + 2 + x * 3] = (g - pg) & 0xff;
      raw[o + 3 + x * 3] = (b - pb) & 0xff;
      pr = r;
      pg = g;
      pb = b;
    }
  }
  const body = new Uint8Array(await deflateAsync(raw, { level: 6 }));
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32([out.subarray(4, 8), data]));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", body), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
