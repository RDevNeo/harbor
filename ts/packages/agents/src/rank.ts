// tags.rs's file ranking (lower is better), used by the branch picker.

function byteLen(s: string): number {
  return Buffer.byteLength(s);
}

/** The letters of `q` in order in `hay`: how many were skipped between them, plus half the lead. */
export function inOrder(hay: string, q: string): number | undefined {
  const rest = [...hay];
  let i = 0;
  let gaps = 0;
  let lead = 0;
  let first = true;
  for (const c of q) {
    for (;;) {
      const x = rest[i++];
      if (x === undefined) return undefined;
      if (x === c) break;
      if (first) lead++;
      else gaps++;
    }
    first = false;
  }
  return gaps + Math.floor(lead / 2);
}

/** `q` found where a word starts (Rust's non-overlapping `match_indices`). */
export function atBoundary(hay: string, q: string): boolean {
  if (q === "") return true;
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) {
    if (i === 0 || "-_./ ".includes(hay[i - 1] ?? "")) return true;
  }
  return false;
}

/** A query with `/` is matched against the whole path, any other against the file name first. */
export function fileScore(path: string, query: string): number | undefined {
  if (query === "") return path.split("/").length - 1;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const name = p.split("/").pop() ?? p;
  const stem = name.split(".")[0] ?? name;
  if (q.includes("/")) {
    if (p === q) return 0;
    if (p.endsWith(q) && p.slice(0, p.length - q.length).endsWith("/")) return 5;
    if (p.startsWith(q)) return 10;
    if (atBoundary(p, q)) return 15;
    if (p.includes(q)) return 20;
    const g = inOrder(p, q);
    return g === undefined ? undefined : 200 + g;
  }
  if (name === q) return 0;
  if (stem === q) return 1;
  if (name.startsWith(q)) return 10;
  if (atBoundary(name, q)) return 20;
  if (name.includes(q)) return 30;
  if (atBoundary(p, q)) return 40;
  if (p.includes(q)) return 50;
  const g = inOrder(name, q);
  if (g !== undefined) return 100 + g;
  const h = inOrder(p, q);
  return h === undefined ? undefined : 300 + h;
}

export function rankFiles(files: readonly string[], query: string, limit: number): string[] {
  const v: [number, string][] = [];
  for (const f of files) {
    const s = fileScore(f, query);
    if (s !== undefined) v.push([s, f]);
  }
  v.sort((a, b) => a[0] - b[0] || byteLen(a[1]) - byteLen(b[1]) || Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])));
  return v.slice(0, limit).map((x) => x[1]);
}
