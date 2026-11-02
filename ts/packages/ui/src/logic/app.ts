/** How long ago `ts` was, short: "now", "38m", "5h", "1d". */
export function ago(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** `path` with the home folder `home` written `~`. */
export function tilde(path: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  if (path === h || path === `${h}/`) return "~";
  if (h !== "" && path.startsWith(`${h}/`)) return `~/${path.slice(h.length + 1).replace(/^\/+/, "")}`;
  return path;
}

const UTF8 = new TextEncoder();
const LOSSY = new TextDecoder("utf-8", { fatal: false });

function hex(b: number | undefined): number | null {
  if (b === undefined) return null;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  return null;
}

/** `%XX` escapes decoded as bytes (a URI's path); anything else stays as it is. */
export function percentDecode(s: string): string {
  const b = UTF8.encode(s);
  const out: number[] = [];
  let i = 0;
  while (i < b.length) {
    const c = b[i] ?? 0;
    if (c === 0x25 && i + 2 < b.length) {
      const h = hex(b[i + 1]);
      const l = hex(b[i + 2]);
      if (h !== null && l !== null) {
        out.push((h << 4) | l);
        i += 3;
        continue;
      }
    }
    out.push(c);
    i += 1;
  }
  return LOSSY.decode(new Uint8Array(out));
}

/** The files a clipboard text names as `file://` lines (a file manager's copy), those that `exists`; null when it isn't such a list. */
export function copiedFiles(text: string, exists: (path: string) => boolean): string[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0 || !lines.every((l) => l.startsWith("file://"))) return null;
  const paths = lines.map((l) => percentDecode(l.slice("file://".length))).filter(exists);
  return paths.length > 0 ? paths : null;
}

/** `s` cut to about `n` UTF-8 bytes: its first two thirds and its last third, with a marker saying how much was left out. */
export function clipMiddle(s: string, n: number): string {
  const b = UTF8.encode(s);
  if (b.length <= n) return s;
  const floor = (i: number) => {
    let k = i;
    while (k > 0 && k < b.length && ((b[k] ?? 0) & 0xc0) === 0x80) k--;
    return k;
  };
  const head = floor(Math.floor((n * 2) / 3));
  const tail = floor(b.length - Math.floor(n / 3));
  return `${LOSSY.decode(b.subarray(0, head))}\n\n… (${tail - head} bytes cut) …\n\n${LOSSY.decode(b.subarray(tail))}`;
}
