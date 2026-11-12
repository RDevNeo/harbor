// Whether a folder is on this PC, for checks that run again and again (every few seconds, every redraw) over
// folders that may well be another PC's: a project of a peer keeps that PC's path (/home/someone/…). On macOS
// /home is the automounter's, and every stat under it costs several milliseconds, so a missing folder is
// remembered for a while by its outermost missing parent: everything under it answers at once.
import { statSync } from "node:fs";
import { dirname, sep } from "node:path";

/** How long a missing folder (and everything under it) is taken as missing before it's looked at again. */
export const MISSING_MS = 30_000;

/** Missing folders, outermost: when each was found missing. */
const missing = new Map<string, number>();

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Folder `p` is here; a missing one isn't looked at again for MISSING_MS (`forget` sooner). */
export function here(p: string, now: number = Date.now()): boolean {
  if (p === "") return false;
  for (let a = p; ; a = dirname(a)) {
    const at = missing.get(a);
    if (at !== undefined) {
      if (now - at < MISSING_MS) return false;
      missing.delete(a);
    }
    if (a === dirname(a)) break;
  }
  if (isDir(p)) return true;
  // Its outermost missing parent: the next folders under it answer without a look.
  let top = p;
  for (let a = dirname(p); a !== dirname(a) && !isDir(a); a = dirname(a)) top = a;
  if (missing.size >= 4096) missing.clear();
  missing.set(top, now);
  return false;
}

/** Look again next time: Harbor made a folder (a clone, a new project), or `p` and all under it (null: every one). */
export function forget(p: string | null = null): void {
  if (p === null) return missing.clear();
  const inside = (a: string, b: string): boolean => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
  for (const k of missing.keys()) if (inside(k, p) || inside(p, k)) missing.delete(k);
}
