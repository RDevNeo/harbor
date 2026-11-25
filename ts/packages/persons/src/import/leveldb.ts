// A read-only LevelDB reader, just enough for Chromium's "Local Storage/leveldb" folders: snappy blocks, table files
// (.ldb/.sst) and the write-ahead log (.log). Used once, by the import, to read Person Hub's Discord logins without
// running Chromium. It never writes to the folder. Values are returned to the caller only, never logged.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function varint(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    if (i >= b.length) throw new Error("truncated varint");
    const x = b[i++]!;
    v += (x & 0x7f) * 2 ** shift;
    if (!(x & 0x80)) return [v, i];
    shift += 7;
    if (shift > 63) throw new Error("bad varint");
  }
}

const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;

/** Snappy's raw format (what LevelDB compresses blocks with). */
export function unsnappy(src: Uint8Array): Uint8Array {
  let [len, i] = varint(src, 0);
  const out = new Uint8Array(len);
  let o = 0;
  while (i < src.length) {
    const tag = src[i++]!;
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let k = 0; k < bytes; k++) n += src[i + k]! * 2 ** (8 * k);
        i += bytes;
      }
      n += 1;
      if (o + n > len || i + n > src.length) throw new Error("bad snappy literal");
      out.set(src.subarray(i, i + n), o);
      i += n;
      o += n;
      continue;
    }
    let n: number;
    let off: number;
    if (kind === 1) {
      n = ((tag >> 2) & 7) + 4;
      off = ((tag >> 5) << 8) | src[i++]!;
    } else if (kind === 2) {
      n = (tag >> 2) + 1;
      off = src[i]! | (src[i + 1]! << 8);
      i += 2;
    } else {
      n = (tag >> 2) + 1;
      off = u32(src, i);
      i += 4;
    }
    if (off === 0 || off > o || o + n > len) throw new Error("bad snappy copy");
    for (let k = 0; k < n; k++) out[o + k] = out[o - off + k]!;
    o += n;
  }
  if (o !== len) throw new Error("snappy length mismatch");
  len = o;
  return out;
}

export interface Entry {
  key: Uint8Array;
  /** null: a deletion. */
  value: Uint8Array | null;
  seq: number;
}

function blockAt(file: Uint8Array, offset: number, size: number): Uint8Array {
  const raw = file.subarray(offset, offset + size);
  const type = file[offset + size];
  if (type === 0) return raw;
  if (type === 1) return unsnappy(raw);
  throw new Error(`unknown block compression ${type}`);
}

function blockEntries(block: Uint8Array): [Uint8Array, Uint8Array][] {
  const restarts = u32(block, block.length - 4);
  const end = block.length - 4 - restarts * 4;
  const out: [Uint8Array, Uint8Array][] = [];
  let i = 0;
  let last = new Uint8Array(0);
  while (i < end) {
    let shared: number, nonShared: number, vlen: number;
    [shared, i] = varint(block, i);
    [nonShared, i] = varint(block, i);
    [vlen, i] = varint(block, i);
    const key = new Uint8Array(shared + nonShared);
    key.set(last.subarray(0, shared));
    key.set(block.subarray(i, i + nonShared), shared);
    i += nonShared;
    const value = block.subarray(i, i + vlen);
    i += vlen;
    out.push([key, value]);
    last = key;
  }
  return out;
}

/** Every entry of a table file (.ldb / .sst). */
export function readTable(file: Uint8Array): Entry[] {
  if (file.length < 48) return [];
  const footer = file.subarray(file.length - 48);
  let i = 0;
  [, i] = varint(footer, i); // metaindex offset
  [, i] = varint(footer, i); // metaindex size
  let idxOff: number, idxSize: number;
  [idxOff, i] = varint(footer, i);
  [idxSize] = varint(footer, i);
  const out: Entry[] = [];
  for (const [, handle] of blockEntries(blockAt(file, idxOff, idxSize))) {
    let off: number, size: number, j: number;
    [off, j] = varint(handle, 0);
    [size] = varint(handle, j);
    for (const [ikey, value] of blockEntries(blockAt(file, off, size))) {
      if (ikey.length < 8) continue;
      const tag = ikey.subarray(ikey.length - 8);
      const type = tag[0]!;
      let seq = 0;
      for (let k = 7; k >= 1; k--) seq = seq * 256 + tag[k]!;
      out.push({ key: ikey.subarray(0, ikey.length - 8), value: type === 1 ? value : null, seq });
    }
  }
  return out;
}

/** Every entry of a write-ahead log (.log). */
export function readLog(file: Uint8Array): Entry[] {
  const BLOCK = 32768;
  const out: Entry[] = [];
  let pending: Uint8Array[] = [];
  let pos = 0;
  while (pos + 7 <= file.length) {
    const left = BLOCK - (pos % BLOCK);
    if (left < 7) {
      pos += left;
      continue;
    }
    const len = file[pos + 4]! | (file[pos + 5]! << 8);
    const type = file[pos + 6]!;
    const data = file.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 0 && len === 0) continue;
    if (type === 1) pending = [data];
    else if (type === 2) pending = [data];
    else if (type === 3) {
      pending.push(data);
      continue;
    } else if (type === 4) pending.push(data);
    else continue;
    if (type === 2) continue;
    const batch = Buffer.concat(pending);
    pending = [];
    if (batch.length < 12) continue;
    let seq = 0;
    for (let k = 7; k >= 0; k--) seq = seq * 256 + batch[k]!;
    const count = u32(batch, 8);
    let i = 12;
    try {
      for (let n = 0; n < count && i < batch.length; n++) {
        const t = batch[i++]!;
        let klen: number;
        [klen, i] = varint(batch, i);
        const key = batch.subarray(i, i + klen);
        i += klen;
        let value: Uint8Array | null = null;
        if (t === 1) {
          let vlen: number;
          [vlen, i] = varint(batch, i);
          value = batch.subarray(i, i + vlen);
          i += vlen;
        }
        out.push({ key, value, seq: seq + n });
      }
    } catch {
      // a torn last record: what came before stands
    }
  }
  return out;
}

/** The newest value of `key` over every table and log in `dir` (null: never set, or deleted). */
export function lookup(dir: string, key: Uint8Array): Uint8Array | null {
  let best: Entry | null = null;
  const want = Buffer.from(key);
  for (const name of readdirSync(dir)) {
    const kind = /\.(ldb|sst)$/.test(name) ? "table" : /\.log$/.test(name) ? "log" : null;
    if (!kind) continue;
    let entries: Entry[];
    try {
      const b = new Uint8Array(readFileSync(join(dir, name)));
      entries = kind === "table" ? readTable(b) : readLog(b);
    } catch {
      continue;
    }
    for (const e of entries) if (want.equals(Buffer.from(e.key)) && (!best || e.seq > best.seq)) best = e;
  }
  return best?.value ?? null;
}

/** Chromium's Local Storage key: "_" + origin + "\0\1" + the key (Latin-1). */
export const localStorageKey = (origin: string, key: string): Uint8Array => Buffer.concat([Buffer.from(`_${origin}`, "latin1"), Buffer.from([0, 1]), Buffer.from(key, "latin1")]);

/** A Local Storage value as text: first byte 1 = Latin-1, 0 = UTF-16LE. */
export function localStorageText(v: Uint8Array): string | null {
  if (!v.length) return null;
  const body = Buffer.from(v.subarray(1));
  if (v[0] === 1) return body.toString("latin1");
  if (v[0] === 0) return body.toString("utf16le");
  return null;
}

/** Discord's token in a (copied or original) partition's Local Storage, read-only; null when there's none. */
export function discordToken(partitionDir: string, origin = "https://discord.com"): string | null {
  let raw: Uint8Array | null;
  try {
    raw = lookup(join(partitionDir, "Local Storage", "leveldb"), localStorageKey(origin, "token"));
  } catch {
    return null;
  }
  const text = raw ? localStorageText(raw) : null;
  if (!text) return null;
  let t: unknown = text;
  try {
    t = JSON.parse(text);
  } catch {
    // stored bare
  }
  return typeof t === "string" && /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(t) ? t : null;
}
