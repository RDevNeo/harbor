import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { chmod, lstat, lutimes, mkdir, open, rm, symlink, utimes, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

/**
 * A folder sent to another PC as a stream (Move to PC… of a whole project): its entries, each a
 * frame of [4-byte length][JSON header][the file's bytes], cut into pieces of at most
 * `PIECE_BYTES` so each piece is one request of its own (a slow link fails one piece, not the
 * whole copy, and nothing holds more than a piece in memory). The receiver writes into a fresh
 * folder of its own: every place is checked to stay inside it, and links are made only once
 * every file is written, so nothing is written through one.
 */

/** One piece of the stream, at most. */
export const PIECE_BYTES = 8 << 20;
/** A frame's header, at most. */
const MAX_HEADER = 64 << 10;
const READ_BYTES = 1 << 20;

export type EntryKind = "dir" | "file" | "link" | "bundle" | "gone";

/** One entry: a folder, a file, a link; `bundle` is git's bundle of the project (kept aside), `gone` a file to delete after checkout. */
export interface Entry {
  rel: string;
  kind: EntryKind;
  mode: number;
  size: number;
  /** Modified, in ms. */
  mtime: number;
  /** A link's target. */
  target?: string;
  /** Where the bytes are read from on the sender (not sent). */
  src?: string;
}

export interface Scan {
  entries: Entry[];
  files: number;
  bytes: number;
  /** What can't be copied (sockets, pipes, devices, unreadable folders), as places in the folder. */
  skipped: string[];
}

/** A place in the folder as a plain relative path: no "", ".", ".." part, not absolute, no NUL or backslash. */
export function plainRel(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\0") || rel.includes("\\") || rel.length > 4096) return false;
  return rel.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

/**
 * A link's target as it travels: a relative one with "/" between its parts (Windows reads its links back with
 * "\", which a Linux or macOS PC would take as part of a name); an absolute one as it is.
 */
export function wireTarget(t: string): string {
  return sep === "\\" && !isAbsolute(t) ? t.replaceAll("\\", "/") : t;
}

/** A link's target as this system writes it: a relative one with Windows' separator there. */
export function localTarget(t: string): string {
  return sep === "\\" && !isAbsolute(t) && !t.startsWith("/") ? t.replaceAll("/", "\\") : t;
}

function entryOf(abs: string, rel: string): Entry | null {
  const st = lstatSync(abs);
  const base = { rel, mode: st.mode & 0o7777, mtime: Math.trunc(st.mtimeMs) };
  if (st.isSymbolicLink()) return { ...base, kind: "link", size: 0, target: wireTarget(readlinkSync(abs)) };
  if (st.isDirectory()) return { ...base, kind: "dir", size: 0 };
  if (st.isFile()) return { ...base, kind: "file", size: st.size, src: abs };
  return null;
}

/**
 * Every entry under `root`, parents before what they hold (null `only`), or just the places in
 * `only` (relative, with the folders that lead to them).
 */
export function scanFolder(root: string, only: string[] | null = null): Scan {
  const out: Scan = { entries: [], files: 0, bytes: 0, skipped: [] };
  const add = (e: Entry) => {
    out.entries.push(e);
    if (e.kind === "file") {
      out.files += 1;
      out.bytes += e.size;
    }
  };
  const walk = (abs: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      out.skipped.push(rel === "" ? "." : rel);
      return;
    }
    for (const n of names) {
      const r = rel === "" ? n : `${rel}/${n}`;
      const a = join(abs, n);
      let e: Entry | null;
      try {
        e = entryOf(a, r);
      } catch {
        out.skipped.push(r);
        continue;
      }
      if (e === null) {
        out.skipped.push(r);
        continue;
      }
      add(e);
      if (e.kind === "dir") walk(a, r);
    }
  };
  if (only !== null) {
    const dirs = new Set<string>();
    const whole = new Set<string>();
    for (const rel of [...new Set(only.map((x) => x.replace(/\/+$/, "")))].sort()) {
      if (!plainRel(rel)) continue;
      const parts = rel.split("/");
      // Inside a folder already sent whole.
      if (parts.some((_, i) => i > 0 && whole.has(parts.slice(0, i).join("/")))) continue;
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        if (dirs.has(d)) continue;
        dirs.add(d);
        try {
          const e = entryOf(join(root, d), d);
          if (e?.kind === "dir") add(e);
        } catch {
          // gone meanwhile
        }
      }
      try {
        const e = entryOf(join(root, rel), rel);
        if (e === null) out.skipped.push(rel);
        else if (e.kind === "dir") {
          // A folder git lists whole (untracked, or a repository of its own): all it holds.
          if (!dirs.has(rel)) {
            dirs.add(rel);
            add(e);
          }
          whole.add(rel);
          walk(join(root, rel), rel);
        } else add(e);
      } catch {
        // gone meanwhile: nothing to copy
      }
    }
    return out;
  }
  walk(root, "");
  return out;
}

function frameHead(e: Entry): Buffer {
  const h: Record<string, unknown> = { rel: e.rel, kind: e.kind, mode: e.mode, size: e.size, mtime: e.mtime };
  if (e.target !== undefined) h.target = e.target;
  const json = Buffer.from(JSON.stringify(h));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([len, json]);
}

/** The bytes the stream of `entries` is: what the progress counts against. */
export function streamBytes(entries: Entry[]): number {
  let n = 0;
  for (const e of entries) n += frameHead(e).length + (e.kind === "file" || e.kind === "bundle" ? e.size : 0);
  return n;
}

/**
 * The stream of `entries` in pieces of `size` bytes (the last one shorter). A file that shrank
 * while it was read stops it: what was sent would be wrong.
 */
export async function* pieces(entries: Entry[], size = PIECE_BYTES): AsyncGenerator<Buffer> {
  let buf: Buffer[] = [];
  let have = 0;
  const push = function* (b: Buffer): Generator<Buffer> {
    let rest = b;
    while (rest.length > 0) {
      const take = Math.min(rest.length, size - have);
      buf.push(rest.subarray(0, take));
      have += take;
      rest = rest.subarray(take);
      if (have === size) {
        yield Buffer.concat(buf);
        buf = [];
        have = 0;
      }
    }
  };
  for (const e of entries) {
    yield* push(frameHead(e));
    if ((e.kind !== "file" && e.kind !== "bundle") || e.size === 0) continue;
    const fh = await open(e.src ?? "", "r");
    try {
      let left = e.size;
      let at = 0;
      while (left > 0) {
        const chunk = Buffer.alloc(Math.min(left, READ_BYTES));
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, at);
        if (bytesRead === 0) throw new Error(`${e.rel} changed while it was copied: try again`);
        yield* push(chunk.subarray(0, bytesRead));
        left -= bytesRead;
        at += bytesRead;
      }
    } finally {
      await fh.close();
    }
  }
  if (have > 0) yield Buffer.concat(buf);
}

/** What the receiver noted besides the files: git's bundle and the files to delete after checkout. */
export interface Unpacked {
  bundle: string | null;
  gone: string[];
  files: number;
  bytes: number;
}

/**
 * The receiving end: writes the stream into `root` (a folder this PC just made, empty), piece by
 * piece. `aside` is where a `bundle` entry goes.
 */
export class Unpacker {
  private buf: Buffer = Buffer.alloc(0);
  private head: Entry | null = null;
  private left = 0;
  private fh: FileHandle | null = null;
  private readonly links: Entry[] = [];
  private readonly dirs: Entry[] = [];
  private readonly made = new Set<string>([""]);
  readonly out: Unpacked = { bundle: null, gone: [], files: 0, bytes: 0 };
  /** Bytes of the stream taken so far. */
  taken = 0;

  constructor(
    readonly root: string,
    private readonly aside: string,
  ) {}

  private parent(rel: string): string {
    const i = rel.lastIndexOf("/");
    return i < 0 ? "" : rel.slice(0, i);
  }

  /**
   * Folder `rel` and the ones leading to it, made where missing. One that is there must be a
   * folder, not a link: what the root held before (a checkout) can't lead a write outside it.
   */
  private async dirsTo(rel: string): Promise<void> {
    if (this.made.has(rel)) return;
    await this.dirsTo(this.parent(rel));
    const abs = join(this.root, rel);
    const st = await lstat(abs).catch(() => null);
    if (st === null) await mkdir(abs, { mode: 0o700 });
    else if (!st.isDirectory()) throw new Error(`refused to write through ${rel}: it isn't a folder`);
    this.made.add(rel);
  }

  /** Deletes `rel` of the folder (a file the sender's checkout no longer has), never through a link. */
  async remove(rel: string): Promise<void> {
    if (!plainRel(rel)) return;
    await this.dirsTo(this.parent(rel));
    await rm(join(this.root, rel), { force: true, recursive: true });
  }

  private async begin(e: Entry): Promise<void> {
    if (e.kind === "bundle") {
      if (this.out.bundle !== null) throw new Error("two bundles in one stream");
      this.out.bundle = this.aside;
      this.fh = await open(this.aside, "wx", 0o600);
      this.left = e.size;
      return;
    }
    if (!plainRel(e.rel)) throw new Error(`refused a file outside the folder: ${e.rel}`);
    if (e.kind === "gone") {
      this.out.gone.push(e.rel);
      return;
    }
    // Folders come before what they hold; a missing one is made (a partial list's parents).
    await this.dirsTo(this.parent(e.rel));
    const abs = join(this.root, e.rel);
    if (e.kind === "dir") {
      await this.dirsTo(e.rel);
      this.dirs.push(e);
      return;
    }
    if (e.kind === "link") {
      this.links.push(e);
      return;
    }
    // A file over one that's there (a checkout's own file the folder changed): replaced.
    await rm(abs, { force: true });
    this.fh = await open(abs, "wx", 0o600);
    this.out.files += 1;
    this.left = e.size;
    this.head = e;
    if (e.size === 0) await this.endFile();
  }

  private async endFile(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    if (fh !== null) await fh.close();
    const e = this.head;
    this.head = null;
    if (e === null || e.kind !== "file") return;
    const abs = join(this.root, e.rel);
    await chmod(abs, e.mode & 0o777);
    await utimes(abs, e.mtime / 1000, e.mtime / 1000).catch(() => undefined);
  }

  /** The next piece, in order. */
  async push(piece: Buffer): Promise<void> {
    this.taken += piece.length;
    this.buf = this.buf.length === 0 ? piece : Buffer.concat([this.buf, piece]);
    for (;;) {
      if (this.left > 0) {
        if (this.buf.length === 0) return;
        const n = Math.min(this.left, this.buf.length);
        await this.fh?.write(this.buf.subarray(0, n));
        this.buf = this.buf.subarray(n);
        this.left -= n;
        this.out.bytes += n;
        if (this.left === 0) await this.endFile();
        continue;
      }
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > MAX_HEADER) throw new Error("the copy came garbled");
      if (this.buf.length < 4 + len) return;
      let h: Record<string, unknown>;
      try {
        h = JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")) as Record<string, unknown>;
      } catch {
        throw new Error("the copy came garbled");
      }
      this.buf = this.buf.subarray(4 + len);
      const kind = h.kind;
      if (kind !== "dir" && kind !== "file" && kind !== "link" && kind !== "bundle" && kind !== "gone") throw new Error("the copy came garbled");
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
      const e: Entry = { rel: typeof h.rel === "string" ? h.rel : "", kind, mode: num(h.mode), size: num(h.size), mtime: num(h.mtime) };
      if (typeof h.target === "string") e.target = h.target;
      if (kind === "link" && (e.target === undefined || e.target === "" || e.target.includes("\0"))) throw new Error(`a link without a target: ${e.rel}`);
      await this.begin(e);
    }
  }

  /** The stream ended: it must end on an entry's end; then the links and folders' modes and times. */
  async finish(): Promise<Unpacked> {
    if (this.left > 0 || this.buf.length > 0) throw new Error("the copy came cut short");
    await this.endFile();
    // Each link's folders are looked at again: an earlier link can't lead a later one outside.
    this.made.clear();
    this.made.add("");
    for (const l of this.links) {
      this.made.clear();
      this.made.add("");
      await this.dirsTo(this.parent(l.rel));
      const abs = join(this.root, l.rel);
      await rm(abs, { force: true, recursive: false }).catch(() => undefined);
      await symlink(localTarget(l.target ?? ""), abs);
      await lutimes(abs, l.mtime / 1000, l.mtime / 1000).catch(() => undefined);
    }
    // Deepest first, so a folder's time isn't changed again by what's made in it.
    for (const d of [...this.dirs].reverse()) {
      const abs = join(this.root, d.rel);
      await chmod(abs, (d.mode & 0o777) | 0o700).catch(() => undefined);
      await utimes(abs, d.mtime / 1000, d.mtime / 1000).catch(() => undefined);
    }
    return this.out;
  }

  /** Stops: closes what's open (the caller removes the folder). */
  async abort(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    if (fh !== null) await fh.close().catch(() => undefined);
  }
}

/** "1.2 GB", "340 MB", "12 KB". */
export function sizeText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} bytes`;
}
