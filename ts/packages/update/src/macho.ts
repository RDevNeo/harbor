// Mach-O load commands, enough to point a library at another copy of a library it links: what
// `install_name_tool -change` / `-id` do when the new path fits in the old one's room. The file's code
// signature is then stale: macOS needs it signed again (os.codesign.adhoc) before it loads it.

const MH_MAGIC_64 = 0xfeedfacf;
const LC_ID_DYLIB = 0xd;
const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LINKS = new Set([LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB]);

interface DylibCommand {
  kind: "id" | "link";
  /** Where the name's bytes start, and the room they have (up to the command's end). */
  at: number;
  room: number;
  name: string;
}

function commands(b: Buffer): DylibCommand[] {
  if (b.length < 32 || b.readUInt32LE(0) !== MH_MAGIC_64) throw new Error("not a 64-bit little-endian Mach-O file (a universal one isn't handled)");
  const n = b.readUInt32LE(16);
  const out: DylibCommand[] = [];
  let off = 32;
  for (let i = 0; i < n; i++) {
    if (off + 8 > b.length) throw new Error("a load command runs past the file's end");
    const cmd = b.readUInt32LE(off);
    const size = b.readUInt32LE(off + 4);
    if (size < 8 || off + size > b.length) throw new Error("a load command has a bad size");
    if (cmd === LC_ID_DYLIB || LINKS.has(cmd)) {
      const at = off + b.readUInt32LE(off + 8);
      const end = off + size;
      const nul = b.indexOf(0, at);
      out.push({ kind: cmd === LC_ID_DYLIB ? "id" : "link", at, room: end - at, name: b.toString("utf8", at, nul < 0 || nul > end ? end : nul) });
    }
    off += size;
  }
  return out;
}

/** The libraries the file links, in order. */
export function links(b: Buffer): string[] {
  return commands(b)
    .filter((c) => c.kind === "link")
    .map((c) => c.name);
}

/** The file's own install name, if it's a library. */
export function id(b: Buffer): string | null {
  return commands(b).find((c) => c.kind === "id")?.name ?? null;
}

function write(b: Buffer, c: DylibCommand, name: string): void {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length + 1 > c.room) throw new Error(`"${name}" doesn't fit where "${c.name}" was`);
  b.fill(0, c.at, c.at + c.room);
  bytes.copy(b, c.at);
}

/** Points every link to `from` at `to`, in place; how many it changed. */
export function changeLink(b: Buffer, from: string, to: string): number {
  let n = 0;
  for (const c of commands(b)) {
    if (c.kind !== "link" || c.name !== from) continue;
    write(b, c, to);
    n++;
  }
  return n;
}

/** Sets the library's own install name, in place; false when the file has none. */
export function changeId(b: Buffer, name: string): boolean {
  const c = commands(b).find((x) => x.kind === "id");
  if (!c) return false;
  write(b, c, name);
  return true;
}
