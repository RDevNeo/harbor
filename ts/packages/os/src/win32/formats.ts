// What Windows' clipboard formats hold, as bytes, and Harbor's MIME types to and from them: pure code
// (no system calls), so it's tested on any system. win32-clipboard.ts moves the bytes.
import { deflateSync, inflateSync } from "node:zlib";

// --- PNG <-> DIB (a bitmap without its file header: what CF_DIB holds) ---

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA pixels (top row first) as a PNG file. */
export function encodePng(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}

export interface Pixels {
  w: number;
  h: number;
  /** RGBA, top row first. */
  rgba: Uint8Array;
}

/**
 * A PNG's pixels: 8-bit greyscale, grey+alpha, RGB, RGBA or palette images, not interlaced (what Harbor
 * and sharp write, and most PNGs on a clipboard). Null for anything else.
 */
export function decodePng(png: Uint8Array): Pixels | null {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let w = 0;
  let h = 0;
  let type = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  for (let o = 8; o + 8 <= b.length; ) {
    const len = b.readUInt32BE(o);
    const t = b.toString("latin1", o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    if (t === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) return null;
      type = data[9] ?? 0;
    } else if (t === "PLTE") palette = data;
    else if (t === "tRNS") trns = data;
    else if (t === "IDAT") idat.push(data);
    else if (t === "IEND") break;
    o += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (channels === undefined || w === 0 || h === 0 || (type === 3 && palette === null)) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = w * channels;
  if (raw.length < h * (stride + 1)) return null;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (px[out + x - channels] ?? 0) : 0;
      const up = y > 0 ? (px[out - stride + x] ?? 0) : 0;
      const ul = y > 0 && x >= channels ? (px[out - stride + x - channels] ?? 0) : 0;
      let v = line[x] ?? 0;
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - ul;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      } else if (f !== 0) return null;
      px[out + x] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r = 0;
    let g = 0;
    let bl = 0;
    let al = 255;
    if (type === 0) r = g = bl = px[i] ?? 0;
    else if (type === 4) {
      r = g = bl = px[i * 2] ?? 0;
      al = px[i * 2 + 1] ?? 255;
    } else if (type === 2) {
      r = px[i * 3] ?? 0;
      g = px[i * 3 + 1] ?? 0;
      bl = px[i * 3 + 2] ?? 0;
    } else if (type === 6) {
      r = px[i * 4] ?? 0;
      g = px[i * 4 + 1] ?? 0;
      bl = px[i * 4 + 2] ?? 0;
      al = px[i * 4 + 3] ?? 255;
    } else {
      const k = px[i] ?? 0;
      r = palette?.[k * 3] ?? 0;
      g = palette?.[k * 3 + 1] ?? 0;
      bl = palette?.[k * 3 + 2] ?? 0;
      al = trns !== null && k < trns.length ? (trns[k] ?? 255) : 255;
    }
    rgba.set([r, g, bl, al], i * 4);
  }
  return { w, h, rgba };
}

const BI_RGB = 0;
const BI_BITFIELDS = 3;

/** Pixels as a CF_DIB: a BITMAPINFOHEADER and 32-bit BGRA rows, bottom row first. */
export function encodeDib(p: Pixels): Uint8Array {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(p.w, 4);
  head.writeInt32LE(p.h, 8);
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(BI_RGB, 16);
  head.writeUInt32LE(p.w * p.h * 4, 20);
  const body = new Uint8Array(p.w * p.h * 4);
  for (let y = 0; y < p.h; y++) {
    const src = (p.h - 1 - y) * p.w * 4;
    for (let x = 0; x < p.w; x++) {
      const s = src + x * 4;
      const d = (y * p.w + x) * 4;
      body[d] = p.rgba[s + 2] ?? 0;
      body[d + 1] = p.rgba[s + 1] ?? 0;
      body[d + 2] = p.rgba[s] ?? 0;
      body[d + 3] = p.rgba[s + 3] ?? 0;
    }
  }
  return new Uint8Array(Buffer.concat([head, body]));
}

/**
 * A CF_DIB or CF_DIBV5's pixels: 24- or 32-bit, plain or with bit masks (screenshots, browsers, Paint).
 * A 32-bit bitmap whose alpha is all 0 is opaque (most apps leave it 0). Null for anything else.
 */
export function decodeDib(dib: Uint8Array): Pixels | null {
  const b = Buffer.from(dib.buffer, dib.byteOffset, dib.byteLength);
  if (b.length < 40) return null;
  const headSize = b.readUInt32LE(0);
  const w = b.readInt32LE(4);
  const rawH = b.readInt32LE(8);
  const bits = b.readUInt16LE(14);
  const compression = b.readUInt32LE(16);
  const colors = b.readUInt32LE(32);
  if (w <= 0 || rawH === 0 || (bits !== 24 && bits !== 32)) return null;
  if (compression !== BI_RGB && compression !== BI_BITFIELDS) return null;
  const h = Math.abs(rawH);
  let masks = [0xff0000, 0xff00, 0xff, 0xff000000];
  let offset = headSize + colors * 4;
  if (compression === BI_BITFIELDS) {
    // A BITMAPINFOHEADER's masks follow it; a V4/V5 header holds them (and alpha's) inside.
    if (headSize === 40) {
      masks = [b.readUInt32LE(40), b.readUInt32LE(44), b.readUInt32LE(48), 0];
      offset += 12;
    } else if (headSize >= 56) masks = [b.readUInt32LE(40), b.readUInt32LE(44), b.readUInt32LE(48), b.readUInt32LE(52)];
  } else if (bits === 24) masks = [0xff0000, 0xff00, 0xff, 0];
  const stride = Math.ceil((w * bits) / 32) * 4;
  if (b.length < offset + stride * h) return null;
  const channel = (v: number, m: number): number => {
    if (m === 0) return -1;
    let shift = 0;
    while (((m >>> shift) & 1) === 0) shift++;
    const top = m >>> shift;
    return Math.round((((v & m) >>> shift) * 255) / top);
  };
  const rgba = new Uint8Array(w * h * 4);
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const row = offset + (rawH > 0 ? h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      const v = bits === 32 ? b.readUInt32LE(row + x * 4) : (b[row + x * 3] ?? 0) | ((b[row + x * 3 + 1] ?? 0) << 8) | ((b[row + x * 3 + 2] ?? 0) << 16);
      const d = (y * w + x) * 4;
      rgba[d] = channel(v, masks[0] ?? 0);
      rgba[d + 1] = channel(v, masks[1] ?? 0);
      rgba[d + 2] = channel(v, masks[2] ?? 0);
      const a = bits === 32 ? channel(v, masks[3] ?? 0) : -1;
      rgba[d + 3] = a < 0 ? 255 : a;
      if (a > 0) anyAlpha = true;
    }
  }
  if (!anyAlpha) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { w, h, rgba };
}

// --- HTML (CF_HTML: "Version:0.9" headers with byte offsets, then the page) ---

/** An HTML fragment as Windows' "HTML Format" holds it. */
export function encodeCfHtml(html: string): Uint8Array {
  const start = "<html><body>\r\n<!--StartFragment-->";
  const end = "<!--EndFragment-->\r\n</body></html>";
  const head = (a: number, b: number, c: number, d: number): string =>
    `Version:0.9\r\nStartHTML:${pad(a)}\r\nEndHTML:${pad(b)}\r\nStartFragment:${pad(c)}\r\nEndFragment:${pad(d)}\r\n`;
  const pad = (n: number): string => String(n).padStart(10, "0");
  const len = (s: string): number => Buffer.byteLength(s, "utf8");
  const h0 = len(head(0, 0, 0, 0));
  const frag = h0 + len(start);
  const fragEnd = frag + len(html);
  const total = fragEnd + len(end);
  return new Uint8Array(Buffer.from(`${head(h0, total, frag, fragEnd)}${start}${html}${end}`, "utf8"));
}

/** The fragment (else the whole page) of a CF_HTML. */
export function decodeCfHtml(data: Uint8Array): string {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const text = b.toString("latin1");
  const at = (k: string): number => {
    const m = new RegExp(`^${k}:(-?\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : -1;
  };
  const end = (n: number): number => (n >= 0 && n <= b.length ? n : -1);
  const s = end(at("StartFragment"));
  const e = end(at("EndFragment"));
  if (s >= 0 && e > s) return b.toString("utf8", s, e);
  const hs = end(at("StartHTML"));
  const he = end(at("EndHTML"));
  if (hs >= 0 && he > hs) return b.toString("utf8", hs, he);
  return b.toString("utf8").replace(/\0+$/, "");
}

// --- Files (CF_HDROP: a DROPFILES header, then UTF-16 paths each ending in 0, then one more 0) ---

/** Local paths as a CF_HDROP. */
export function encodeHdrop(paths: readonly string[]): Uint8Array {
  const head = Buffer.alloc(20);
  head.writeUInt32LE(20, 0); // pFiles: where the list starts
  head.writeUInt32LE(1, 16); // fWide
  return new Uint8Array(Buffer.concat([head, Buffer.from(`${paths.join("\0")}\0\0`, "utf16le")]));
}

/** The paths of a CF_HDROP. */
export function decodeHdrop(data: Uint8Array): string[] {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 20) return [];
  const at = b.readUInt32LE(0);
  const wideNames = b.readUInt32LE(16) !== 0;
  const text = wideNames ? b.toString("utf16le", at) : b.toString("latin1", at);
  return text.split("\0").filter((s, i, all) => s !== "" && all.slice(0, i).every((p) => p !== ""));
}

/** A uri-list's file paths (file:///C:/… as C:\…); other URIs are left out. */
export function pathsOfUriList(list: string): string[] {
  const out: string[] = [];
  for (const line of list.split(/\r?\n/)) {
    const l = line.trim();
    if (l === "" || l.startsWith("#") || !l.startsWith("file:")) continue;
    try {
      const u = new URL(l);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      p = p.replaceAll("/", "\\");
      out.push(u.host !== "" && u.host !== "localhost" ? `\\\\${u.host}${p}` : p);
    } catch {}
  }
  return out;
}

/** Paths as a uri-list, each line ending in CRLF. */
export function uriListOfPaths(paths: readonly string[]): string {
  return paths
    .map((p) => {
      const unc = /^\\\\([^\\]+)(\\.*)$/.exec(p);
      const host = unc ? unc[1] : "";
      const rest = (unc ? (unc[2] ?? "") : `/${p}`).replaceAll("\\", "/");
      return `file://${host}${rest.split("/").map(encodeURIComponent).join("/").replace(/^\/([A-Za-z])%3A/, "/$1:")}\r\n`;
    })
    .join("");
}
