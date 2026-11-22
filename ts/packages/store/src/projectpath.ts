// Project paths as the mesh passes them between PCs of different systems: a Windows PC's
// `C:\Users\sam\Projects\app` reaches a Linux or macOS PC as it is, and a Linux PC's
// `/home/sam/app` reaches Windows. Node's `path` reads only this PC's kind (on Linux, `basename`
// of a Windows path is the whole of it), so these read a path by its own kind, whatever this PC is.

/** A Windows path: a drive (`C:\…`, `c:/…`), a share (`\\host\share`) or a long one (`\\?\C:\…`). */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || /^\\\\/.test(p);
}

/** Its parts, by either separator; a Windows path's drive ("C:") or long-path prefix aren't among them. */
function parts(p: string): string[] {
  let s = p;
  if (/^\\\\[?.]\\/.test(s)) s = s.slice(4);
  const all = s.split(/[\\/]+/).filter((x) => x !== "" && x !== ".");
  if (/^[A-Za-z]:$/.test(all[0] ?? "")) all.shift();
  return all;
}

/** The last part of path `p` of any system ("" for a root or ""): what its folder is called. */
export function pathTail(p: string): string {
  return parts(p.trim()).at(-1) ?? "";
}

/**
 * Path `p` written so that the same folder gives the same text from any PC: either separator as
 * "/", no repeated or trailing one, and a Windows path in lower case (its drive and names don't
 * care about case). A POSIX path keeps its case.
 */
export function pathKey(p: string): string {
  const t = p.trim();
  if (t === "") return "";
  if (isWindowsPath(t)) {
    const unc = /^\\\\(?![?.]\\)/.test(t);
    let s = t.replace(/^\\\\[?.]\\/, "").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
    if (s.length > 1) s = s.replace(/\/+$/, "");
    if (/^[A-Za-z]:$/.test(s)) s += "/";
    return (unc ? `/${s}` : s).toLowerCase();
  }
  const s = t.replace(/\/{2,}/g, "/");
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

/** Whether `a` and `b` are the same folder's path as PCs of any system write it. */
export function samePath(a: string, b: string): boolean {
  return a === b || (a !== "" && pathKey(a) === pathKey(b));
}

/** What a folder can't be called on one system or another: Windows' reserved characters and control characters. */
const BAD = /[<>:"/\\|?*\u0000-\u001f\u007f]+/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const MAX = 100;

/**
 * A name a folder can have on every system, for a project called `name` (or at path `name`, of
 * any system: its last part): Windows' reserved characters as "-", no leading or trailing dots,
 * spaces or dashes, not one of Windows' device names, at most 100 characters; `fallback` when
 * nothing's left. `C:\Users\sam\Projects\app` gives "app".
 */
export function folderName(name: string, fallback = "project"): string {
  const tail = pathTail(name);
  let s = tail.replace(BAD, "-").replace(/-{2,}/g, "-").replace(/^[\s.-]+|[\s.-]+$/g, "");
  if (s.length > MAX) s = s.slice(0, MAX).replace(/[\s.-]+$/, "");
  if (s === "") return fallback;
  return RESERVED.test(s) ? `${s}-project` : s;
}

/**
 * Whether folder name `seg` is one Harbor made from another system's whole path (a Windows
 * PC's project cloned on Linux as `C:\Users\sam\Projects\app`): it holds a path's separators or a
 * drive. Such a folder breaks tools (Bun can't read it as its current folder, Node won't import
 * from it), so it's renamed to `folderName` of it.
 */
export function isForeignPathName(seg: string): boolean {
  return seg.includes("\\") || /^[A-Za-z]:([\\/]|$)/.test(seg);
}

/** `want`, else `want-2`, `want-3`… : the first that `taken` says is free. */
export function freeName(want: string, taken: (name: string) => boolean): string {
  if (!taken(want)) return want;
  for (let n = 2; ; n++) if (!taken(`${want}-${n}`)) return `${want}-${n}`;
}
