// A project, worktree or chat folder moved or renamed outside Harbor: what it is (`Ident`), whether a
// folder found elsewhere is it (`matches`), the bounded search that finds it (`locate`) and whether
// it went to the Trash instead (`trashed`). foldertrack.ts follows the folders and re-homes them.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths as osPaths } from "@harbor/os";
import { sessionDir } from "./movechat.ts";

/**
 * What a folder is, kept by its path: its device and inode (the same after a rename or a move on
 * the same disk), the id Harbor wrote in its `.git` (`.git/harbor-id`: a Git checkout, found on
 * another disk too), the admin folder a worktree's `.git` file points at (one per worktree), and a
 * few of its names (a plain folder's inode alone could be a new folder's after the old one went).
 */
export interface Ident {
  dev: string;
  ino: string;
  mark?: string;
  gitdir?: string;
  names?: string[];
  /** When it was read (ms). */
  at?: number;
}

/** A folder seen while looking. */
export interface Cand {
  dev: string;
  ino: string;
  mark: string | null;
  gitdir: string | null;
  /** What a worktree's admin folder says its `.git` is (`<admin>/gitdir`): its old place until `git worktree repair`. */
  back?: string | null;
  names: string[];
}

export const MARK_FILE = "harbor-id";
const NAMES = 24;

/** `p` with `from` (or a folder under it) moved to `to`; anything else as it is. */
export function rewrite(p: string, from: string, to: string): string {
  const rest = osPaths.under(p, from);
  if (rest === "") return to;
  return rest !== null ? to + p.slice(p.length - rest.length - 1) : p;
}

export function under(p: string, dir: string): boolean {
  return osPaths.under(p, dir) !== null;
}

/** The admin folder a worktree's `.git` file points at (absolute), null when `dir/.git` isn't such a file. */
export function gitdirOf(dir: string): string | null {
  try {
    const t = readFileSync(join(dir, ".git"), "utf8").trim();
    if (!t.startsWith("gitdir:")) return null;
    const g = t.slice(7).trim();
    return isAbsolute(g) ? g : join(dir, g);
  } catch {
    return null;
  }
}

/** The main checkout an admin folder (`<main>/.git/worktrees/<name>`) belongs to. */
export function mainOf(admin: string): string | null {
  const wts = dirname(admin);
  const git = dirname(wts);
  return basename(wts) === "worktrees" && basename(git) === ".git" ? dirname(git) : null;
}

function readMark(dir: string): string | null {
  try {
    const m = readFileSync(join(dir, ".git", MARK_FILE), "utf8").trim();
    return m === "" ? null : m;
  } catch {
    return null;
  }
}

/** A Git checkout's id, written into its `.git` folder the first time (out of the working tree: git doesn't see it). */
export function ensureMark(dir: string): string | null {
  const have = readMark(dir);
  if (have !== null) return have;
  try {
    if (!statSync(join(dir, ".git")).isDirectory()) return null;
    const m = randomUUID();
    writeFileSync(join(dir, ".git", MARK_FILE), `${m}\n`);
    return m;
  } catch {
    return null;
  }
}

const sample = (names: readonly string[]): string[] => [...names].filter((n) => n !== ".git").sort().slice(0, NAMES);

/** What folder `dir` is now (a Git checkout gets its id written), null when it isn't a folder. */
export function identOf(dir: string, mark = true): Ident | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir, { bigint: true });
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const id: Ident = { dev: String(st.dev), ino: String(st.ino) };
  const gitdir = gitdirOf(dir);
  if (gitdir !== null) id.gitdir = gitdir;
  else {
    const m = mark ? ensureMark(dir) : readMark(dir);
    if (m !== null) id.mark = m;
  }
  if (id.mark === undefined && id.gitdir === undefined) {
    try {
      id.names = sample(readdirSync(dir));
    } catch {
      // unreadable: the inode alone
    }
  }
  return id;
}

/** Whether the folder at `dir` is the one a record was read from (same device and inode). */
export function sameInode(id: Ident, dir: string): boolean {
  try {
    const st = statSync(dir, { bigint: true });
    return String(st.dev) === id.dev && String(st.ino) === id.ino;
  } catch {
    return false;
  }
}

/**
 * Whether folder `c` is the one `id` (which was at `old`) describes. A checkout by its id (on any
 * disk); a worktree by the admin folder its `.git` points at, when it's the same inode or that admin
 * folder still says the worktree is at `old` (a new worktree that took the name says otherwise), or
 * by inode and admin name when its checkout moved too; a plain folder by its inode, with some of the
 * same names in it.
 */
export function matches(id: Ident, c: Cand, old: string, adminMoved: (gitdir: string) => string = (g) => g): boolean {
  const sameInode = c.dev === id.dev && c.ino === id.ino;
  if (id.mark !== undefined) return c.mark === id.mark;
  if (id.gitdir !== undefined) {
    if (c.gitdir === null) return false;
    // As paths: git writes them with "/" on Windows too, Harbor's own with "\\" there.
    const same = (a: string | null | undefined, b: string): boolean => a != null && osPaths.under(a, b) === "";
    if (same(c.gitdir, id.gitdir) || same(c.gitdir, adminMoved(id.gitdir))) return sameInode || same(c.back, join(old, ".git"));
    return sameInode && basename(c.gitdir) === basename(id.gitdir);
  }
  if (!sameInode) return false;
  const want = id.names ?? [];
  if (want.length === 0) return true;
  const have = new Set(c.names);
  const both = want.filter((n) => have.has(n)).length;
  return both * 2 >= want.length;
}

/** What the search may look at. */
export interface Limits {
  /** Folders read at most, over every root. */
  dirs: number;
  /** How deep below each root. */
  depth: number;
  /** Gives up after this long (ms). */
  ms: number;
}

export const LIMITS: Limits = { dirs: 40_000, depth: 4, ms: 15_000 };

/** Folders never looked in: caches, dependencies, Harbor's and the desktop's own. */
const SKIP = new Set(["node_modules", "target", "__pycache__", "venv", "Trash", "snap", "proc", "sys", "dev"]);

/**
 * Looks for the folders `wanted` (old path → what it was) below `roots`, nearest first, without
 * going into Git checkouts (a project isn't in another) or dot folders. Returns old path → where it
 * is now, for each one found exactly once (two copies of a checkout: the one with its inode).
 */
export async function locate(wanted: ReadonlyMap<string, Ident>, roots: readonly string[], limits: Limits = LIMITS, skip: (dir: string) => boolean = () => false): Promise<Map<string, string>> {
  const found = new Map<string, (Cand & { path: string })[]>();
  const inodes = new Set([...wanted.values()].map((i) => `${i.dev}:${i.ino}`));
  const marks = new Set([...wanted.values()].flatMap((i) => (i.mark === undefined ? [] : [i.mark])));
  const seen = new Set<string>();
  const end = Date.now() + limits.ms;
  let budget = limits.dirs;
  const consider = (path: string, c: Cand): void => {
    for (const [old, id] of wanted) {
      if (!matches(id, c, old)) continue;
      const l = found.get(old) ?? [];
      if (!l.some((x) => x.path === path)) l.push({ ...c, path });
      found.set(old, l);
    }
  };
  // Done early only when each is found with its own inode (else a copy found later makes it two).
  const allFound = (): boolean => [...wanted].every(([k, id]) => (found.get(k) ?? []).some((c) => c.dev === id.dev && c.ino === id.ino));
  for (const root of roots) {
    let level: string[] = [root];
    for (let depth = 0; depth <= limits.depth && level.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (budget-- <= 0 || Date.now() > end) return pick(found, wanted);
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(dir, { bigint: true });
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const key = `${st.dev}:${st.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        const names = entries.map((e) => e.name);
        const git = names.includes(".git");
        let mark: string | null = null;
        let gitdir: string | null = null;
        let back: string | null = null;
        if (git) {
          gitdir = gitdirOf(dir);
          if (gitdir !== null) {
            try {
              back = (await readFile(join(gitdir, "gitdir"), "utf8")).trim();
            } catch {
              // its admin folder is gone
            }
          }
          if (gitdir === null && marks.size > 0) {
            try {
              mark = (await readFile(join(dir, ".git", MARK_FILE), "utf8")).trim() || null;
            } catch {
              // a checkout Harbor never followed
            }
          }
        }
        if (git || inodes.has(key)) consider(dir, { dev: String(st.dev), ino: String(st.ino), mark, gitdir, back, names: sample(names) });
        if (allFound() && depth > 0) return pick(found, wanted);
        // The root itself is looked in even when it's a checkout; below it, a checkout's insides aren't.
        if (git && depth > 0) continue;
        for (const e of entries) {
          if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
          const p = join(dir, e.name);
          if (!skip(p)) next.push(p);
        }
      }
      level = next;
    }
  }
  return pick(found, wanted);
}

function pick(found: Map<string, (Cand & { path: string })[]>, wanted: ReadonlyMap<string, Ident>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [old, l] of found) {
    const id = wanted.get(old);
    if (!id) continue;
    const exact = l.filter((c) => c.dev === id.dev && c.ino === id.ino);
    const one = l.length === 1 ? l[0] : exact.length === 1 ? exact[0] : undefined;
    if (one && one.path !== old) out.set(old, one.path);
  }
  return out;
}

/** The desktop's Trash of the user whose home is `home`: a folder in it, and where each came from (`.trashinfo` `Path=`). */
export function trashDir(home: string): string {
  return osPaths.trashHome({ ...process.env, HOME: home });
}

/** Whether `path` (or a folder it was in) went to the Trash: its `.trashinfo` names it, and what it names is still in the Trash. */
export function trashed(path: string, home: string): boolean {
  const t = trashDir(home);
  let infos: string[];
  try {
    infos = readdirSync(join(t, "info")).filter((n) => n.endsWith(".trashinfo"));
  } catch {
    return false;
  }
  for (const n of infos) {
    let text: string;
    try {
      text = readFileSync(join(t, "info", n), "utf8");
    } catch {
      continue;
    }
    const line = text.split("\n").find((l) => l.startsWith("Path="));
    if (line === undefined) continue;
    let orig: string;
    try {
      orig = decodeURIComponent(line.slice(5).trim());
    } catch {
      continue;
    }
    if (!under(path, orig)) continue;
    if (existsSync(join(t, "files", n.slice(0, -".trashinfo".length)))) return true;
  }
  return false;
}

/**
 * Claude Code keeps a folder's sessions and memory by its path (`<config>/projects/<slug>`): each
 * account's are copied to the new path's place (nothing there is overwritten; the old stays).
 * Returns how many accounts had some.
 */
export function copySessions(configs: readonly (string | null)[], from: string, to: string): number {
  let n = 0;
  for (const c of new Set(configs)) {
    const src = sessionDir(c, from);
    const dst = sessionDir(c, to);
    if (src === dst || !existsSync(src)) continue;
    try {
      cpSync(src, dst, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
      n++;
    } catch (x) {
      console.error(`harbor: copying Claude's sessions of ${from} to ${to}: ${x instanceof Error ? x.message : String(x)}`);
    }
  }
  return n;
}
