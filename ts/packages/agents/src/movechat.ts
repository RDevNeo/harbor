// Claude Code resumes only sessions of the folder it runs in: a chat that moves needs a copy of
// each session where its new folder's sessions are.
import { copyFileSync, cpSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { home } from "./paths.ts";

/** Claude Code's folder name for a working directory: the real path, every character but ASCII letters and digits as '-'. */
export function projectSlug(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // a folder that doesn't exist (yet) maps by its given path, as Claude Code's would
  }
  return [...real].map((c) => (/^[A-Za-z0-9]$/.test(c) ? c : "-")).join("");
}

/** Where an account (its config dir; null: ~/.claude) keeps the sessions of `cwd`. */
export function sessionDir(config: string | null, cwd: string): string {
  return join(config ?? join(home(), ".claude"), "projects", projectSlug(cwd));
}

function modified(p: string): bigint | null {
  try {
    return statSync(p, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const newestFirst = (a: string, b: string): number => {
  const x = modified(a) ?? -1n;
  const y = modified(b) ?? -1n;
  return x === y ? 0 : x > y ? -1 : 1;
};

/** Every copy of session `sid` in the account's project folders, newest first. */
export function sessionCopies(config: string | null, sid: string): string[] {
  const root = join(config ?? join(home(), ".claude"), "projects");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    // no projects folder: no sessions
  }
  return dirs.map((d) => join(root, d, `${sid}.jsonl`)).filter(isFile).sort(newestFirst);
}

/** Makes session `sid` resumable in `cwd`: its newest copy goes in the folder's place. False if there's no copy at all. */
export function ensureSession(config: string | null, sid: string, cwd: string): boolean {
  return ensureSessionIn(config, [], sid, cwd);
}

/** Also takes the newest copy from the profiles `also` (a chat commanded from another PC runs in an overlay profile). */
export function ensureSessionIn(config: string | null, also: readonly string[], sid: string, cwd: string): boolean {
  const copies = [...sessionCopies(config, sid), ...also.flatMap((p) => sessionCopies(p, sid))].sort(newestFirst);
  const src = copies[0];
  if (src === undefined) return false;
  const dir = sessionDir(config, cwd);
  const dst = join(dir, `${sid}.jsonl`);
  const d = modified(dst);
  const s = modified(src);
  if (src === dst || (d !== null && s !== null && d >= s)) return true;
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, dst);
  // Its sidecar folder (sub-agent transcripts, tool output overflow), if any.
  const side = src.slice(0, -".jsonl".length);
  if (isDir(side)) {
    try {
      cpSync(side, join(dir, sid), { recursive: true });
    } catch {
      // the session is there; only its sidecar files are missing
    }
  }
  return true;
}
