// The Microsoft Visual C++ runtime DLLs that slint-ui's Windows addon links (MSVCP140, VCRUNTIME140, and
// VCRUNTIME140_1 under MSVCP140): a clean Windows has none of them, so Harbor carries them beside the addon
// ("app-local", as the Visual C++ redistributable's licence allows). They come from Microsoft's own
// redistributable, pinned by its hash: the cabinets inside it are found and read here (CAB with MSZIP), so the
// build needs no cabextract or Windows.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** VC_redist.x64.exe 14.44.35211 (the address carries its SHA-256). */
const REDIST = {
  url: "https://download.visualstudio.microsoft.com/download/pr/e9604e21-4b79-4096-a4b3-1b63d4b55b4d/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe",
  sha256: "cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b",
};

/** The DLLs Harbor needs, by their name inside the cabinet. */
export const DLLS: Readonly<Record<string, string>> = {
  "msvcp140.dll_amd64": "msvcp140.dll",
  "vcruntime140.dll_amd64": "vcruntime140.dll",
  "vcruntime140_1.dll_amd64": "vcruntime140_1.dll",
};

interface CabFile {
  name: string;
  size: number;
  offset: number;
  folder: number;
}

/** Every file of the cabinet starting at `at` in `buf` (MSZIP folders only), as name → bytes; null when it isn't one. */
export function readCab(buf: Buffer, at: number, want: (name: string) => boolean): Map<string, Buffer> | null {
  if (buf.toString("latin1", at, at + 4) !== "MSCF") return null;
  const u16 = (o: number): number => buf.readUInt16LE(at + o);
  const u32 = (o: number): number => buf.readUInt32LE(at + o);
  const size = u32(8);
  if (size < 36 || at + size > buf.length) return null;
  const filesAt = u32(16);
  const folders = u16(26);
  const files = u16(28);
  const flags = u16(30);
  let p = 36;
  let folderReserve = 0;
  let dataReserve = 0;
  if (flags & 4) {
    const headerReserve = u16(36);
    folderReserve = buf[at + 38] ?? 0;
    dataReserve = buf[at + 39] ?? 0;
    p = 40 + headerReserve;
  }
  // A cabinet continued from or into another (flags 1, 2) names them here: not one this reader handles.
  if (flags & 3) return null;
  const folderList: Array<{ start: number; blocks: number; type: number }> = [];
  for (let i = 0; i < folders; i++, p += 8 + folderReserve) folderList.push({ start: u32(p), blocks: u16(p + 4), type: u16(p + 6) });
  const fileList: CabFile[] = [];
  p = filesAt;
  for (let i = 0; i < files; i++) {
    const end = buf.indexOf(0, at + p + 16);
    fileList.push({ size: u32(p), offset: u32(p + 4), folder: u16(p + 8), name: buf.toString("latin1", at + p + 16, end) });
    p = end - at + 1;
  }
  const out = new Map<string, Buffer>();
  const unpacked = new Map<number, Buffer>();
  for (const f of fileList) {
    if (!want(f.name)) continue;
    let data = unpacked.get(f.folder);
    if (data === undefined) {
      const folder = folderList[f.folder];
      if (folder === undefined || (folder.type & 0xf) !== 1) throw new Error(`cabinet folder ${f.folder}: not MSZIP`);
      data = unpackMszip(buf, at + folder.start, folder.blocks, dataReserve);
      unpacked.set(f.folder, data);
    }
    out.set(f.name, data.subarray(f.offset, f.offset + f.size));
  }
  return out;
}

/** MSZIP: each block is "CK" and a deflate stream whose window is the output so far (the last 32 KiB of it). */
function unpackMszip(buf: Buffer, at: number, blocks: number, reserve: number): Buffer {
  const parts: Buffer[] = [];
  let window = Buffer.alloc(0);
  let p = at;
  for (let i = 0; i < blocks; i++) {
    const packed = buf.readUInt16LE(p + 4);
    const plain = buf.readUInt16LE(p + 6);
    const data = buf.subarray(p + 8 + reserve, p + 8 + reserve + packed);
    if (data.toString("latin1", 0, 2) !== "CK") throw new Error("MSZIP block without its CK mark");
    const out = inflateRawSync(data.subarray(2), window.length > 0 ? { dictionary: window } : {});
    if (out.length !== plain) throw new Error(`MSZIP block ${i}: ${out.length} bytes, wanted ${plain}`);
    parts.push(out);
    window = Buffer.concat([window, out]).subarray(-32768);
    p += 8 + reserve + packed;
  }
  return Buffer.concat(parts);
}

/**
 * The DLLs out of the redistributable's bytes: its installer's cabinet (found by its MSCF mark) holds more
 * cabinets, one of which holds the DLLs; each cabinet inside is read in turn until all are found.
 */
export function extract(exe: Buffer, depth = 0): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  const take = (files: Map<string, Buffer>): void => {
    for (const [n, b] of files) {
      if (n in DLLS) found.set(n, b);
      else if (depth < 2 && b.toString("latin1", 0, 4) === "MSCF") for (const [m, c] of extract(b, depth + 1)) found.set(m, c);
    }
  };
  const all = Object.keys(DLLS).length;
  for (let at = exe.indexOf("MSCF"); at >= 0 && found.size < all; at = exe.indexOf("MSCF", at + 4)) {
    try {
      const files = readCab(exe, at, (n) => n in DLLS || depth < 2);
      if (files !== null) take(files);
    } catch {
      // an MSCF that isn't a cabinet's start (or one this reader can't read): the next
    }
  }
  return found;
}

/** The three DLLs in `dir` (downloaded and unpacked once, kept by the redistributable's hash): their paths by file name. */
export async function vcRuntime(dir: string): Promise<Record<string, string>> {
  const into = join(dir, `vcruntime-${REDIST.sha256.slice(0, 16)}`);
  const paths = Object.fromEntries(Object.values(DLLS).map((n) => [n, join(into, n)]));
  if (Object.values(paths).every((p) => existsSync(p))) return paths;
  const res = await fetch(REDIST.url);
  if (!res.ok) throw new Error(`VC_redist.x64.exe: HTTP ${res.status}`);
  const exe = Buffer.from(await res.arrayBuffer());
  const sum = createHash("sha256").update(exe).digest("hex");
  if (sum !== REDIST.sha256) throw new Error(`VC_redist.x64.exe: sha256 ${sum}, wanted ${REDIST.sha256}`);
  const found = extract(exe);
  const tmp = `${into}.${process.pid}`;
  mkdirSync(tmp, { recursive: true });
  for (const [inCab, name] of Object.entries(DLLS)) {
    const b = found.get(inCab);
    if (b === undefined) throw new Error(`VC_redist.x64.exe has no ${inCab}`);
    writeFileSync(join(tmp, name), b);
  }
  mkdirSync(dir, { recursive: true });
  renameSync(tmp, into);
  return paths;
}

if (import.meta.main) {
  // bun scripts/vcruntime.ts EXE OUTDIR: unpack a downloaded redistributable (a check against cabextract).
  const [exe, out] = process.argv.slice(2);
  if (exe === undefined || out === undefined) {
    console.error("usage: vcruntime.ts VC_redist.x64.exe OUTDIR");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  for (const [n, b] of extract(readFileSync(exe))) writeFileSync(join(out, DLLS[n] ?? n), b);
}
