import { isAbsolute, join, normalize, parse as parsePath, sep } from "node:path";
import { dataDir, home } from "./paths.ts";

export { home };

/**
 * The Projects folder (kv `projects_dir`, this PC's): where new projects and clones go. Set, it
 * also holds the worktrees (`.worktrees/<name>`) and the folders of chats without a project
 * (`chats/`). Not set: new projects go to ~/Projects, worktrees to Harbor's data folder and chats
 * without a project run in the home folder, as before it existed.
 */
export const KEY = "projects_dir";

interface Kv {
  get(k: string): string | null;
}
/** "~/x", and on Windows "~\x" too. */
/** "~/x", and on Windows "~\\x" too. */
const underHome = (v: string): boolean => v.startsWith("~/") || (sep === "\\" && v.startsWith("~\\"));

/** Normalized, without a trailing separator (either one on Windows), a root (/ or C:\) kept whole. */
function clean(p: string): string {
  const n = normalize(p);
  const root = parsePath(n).root;
  return n.length > root.length ? n.replace(sep === "\\" ? /[\\/]+$/ : /\/+$/, "") : n;
}

/** The folder the user picked ("~/x" taken as under the home folder), null when none is. */
export function chosen(kv: Kv | null | undefined, h: string = home()): string | null {
  const v = (kv?.get(KEY) ?? "").trim();
  if (v === "") return null;
  const p = v === "~" ? h : underHome(v) ? join(h, v.slice(2)) : v;
  return isAbsolute(p) ? clean(p) : null;
}

/** Where new projects and clones go. */
export function projectsDir(kv: Kv | null | undefined, h: string = home()): string {
  return chosen(kv, h) ?? join(h, "Projects");
}

/** Where new worktrees go: `<Projects folder>/.worktrees` once one is chosen, else Harbor's data folder. */
export function worktreesDir(kv: Kv | null | undefined, h: string = home(), data: string = dataDir()): string {
  const c = chosen(kv, h);
  return c === null ? join(data, "worktrees") : join(c, ".worktrees");
}

/** Where a new chat without a project runs: `<Projects folder>/chats` once one is chosen, else the home folder. */
export function chatsDir(kv: Kv | null | undefined, h: string = home()): string {
  const c = chosen(kv, h);
  return c === null ? h : join(c, "chats");
}

/** The value to store for a folder the user typed or picked: absolute, or why not. */
export function parse(input: string, h: string = home()): { dir: string } | { err: string } {
  const t = input.trim();
  if (t === "") return { err: "Pick a folder" };
  const p = t === "~" ? h : underHome(t) ? join(h, t.slice(2)) : t;
  if (!isAbsolute(p)) return { err: "Use a full path, like ~/Projects" };
  return { dir: clean(p) };
}
