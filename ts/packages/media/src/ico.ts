const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

export const isIco = (b: Uint8Array): boolean => b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4] ?? 0) + (b[5] ?? 0) * 256 > 0;

export type IcoImage = { kind: "png"; data: Uint8Array } | { kind: "raw"; width: number; height: number; data: Uint8Array };

interface Entry {
  width: number;
  height: number;
  bpp: number;
  size: number;
  offset: number;
}

function entries(b: Uint8Array): Entry[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = v.getUint16(4, true);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    if (at + 16 > b.length) break;
    out.push({
      width: b[at] || 256,
      height: b[at + 1] || 256,
      bpp: v.getUint16(at + 6, true),
      size: v.getUint32(at + 8, true),
      offset: v.getUint32(at + 12, true),
    });
  }
  return out;
}

export function decodeIco(b: Uint8Array): IcoImage {
  const best = entries(b)
    .filter((e) => e.offset + e.size <= b.length && e.size > 0)
    .sort((x, y) => y.width * y.height - x.width * x.height || y.bpp - x.bpp)[0];
  if (!best) throw new Error("empty icon file");
  const data = b.subarray(best.offset, best.offset + best.size);
  if (PNG_MAGIC.every((m, i) => data[i] === m)) return { kind: "png", data };
  return bitmap(data);
}

function bitmap(d: Uint8Array): IcoImage {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 40) throw new Error("bad icon bitmap");
  const header = v.getUint32(0, true);
  const width = v.getInt32(4, true);
  const height = Math.floor(v.getInt32(8, true) / 2);
  const bpp = v.getUint16(14, true);
  const compression = v.getUint32(16, true);
  let colors = v.getUint32(32, true);
  if (width <= 0 || width > 256 || height <= 0 || height > 256) throw new Error("bad icon size");
  if (compression !== 0) throw new Error("compressed icon bitmaps aren't supported");
  if (![1, 4, 8, 24, 32].includes(bpp)) throw new Error(`${bpp}-bit icon bitmaps aren't supported`);
  if (bpp <= 8 && colors === 0) colors = 1 << bpp;
  const paletteAt = header;
  const pixelsAt = paletteAt + (bpp <= 8 ? colors * 4 : 0);
  const stride = Math.floor((width * bpp + 31) / 32) * 4;
  const maskAt = pixelsAt + stride * height;
  const maskStride = Math.floor((width + 31) / 32) * 4;
  const out = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixelsAt + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let bl = 0;
      let a = 255;
      if (bpp === 32 || bpp === 24) {
        const p = row + x * (bpp / 8);
        bl = d[p] ?? 0;
        g = d[p + 1] ?? 0;
        r = d[p + 2] ?? 0;
        if (bpp === 32) {
          a = d[p + 3] ?? 0;
          if (a !== 0) anyAlpha = true;
        }
      } else {
        const per = 8 / bpp;
        const byte = d[row + Math.floor(x / per)] ?? 0;
        const shift = 8 - bpp * ((x % per) + 1);
        const idx = (byte >> shift) & ((1 << bpp) - 1);
        const p = paletteAt + idx * 4;
        bl = d[p] ?? 0;
        g = d[p + 1] ?? 0;
        r = d[p + 2] ?? 0;
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = bl;
      out[o + 3] = a;
    }
  }
  if (bpp !== 32 || !anyAlpha) {
    for (let y = 0; y < height; y++) {
      const row = maskAt + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) {
        const bit = ((d[row + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        out[(y * width + x) * 4 + 3] = bit === 1 ? 0 : 255;
      }
    }
  }
  return { kind: "raw", width, height, data: out };
}
