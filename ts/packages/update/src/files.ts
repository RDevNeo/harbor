import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { platform, proc } from "@harbor/os";

export const MANAGED = ".managed";
/** Windows can't delete or overwrite a running program's file, only rename it. */
const WINDOWS = platform() === "win32";
export const RUNTIME_FILE = WINDOWS ? "harbor.exe" : "harbor";
/** What a file renamed out of the way (Windows: still running) is called, until `sweepAside` deletes it. */
export const ASIDE = ".old-";
export const BUNDLE_FILE = "harbor-app.js";

export function read(p: string): string {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

export const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function remove(p: string): void {
  // Windows: a file another program has open stays a moment after it closes (antivirus, the indexer).
  rmSync(p, WINDOWS ? { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } : { recursive: true, force: true });
}

/** Moves `p` out of the way, beside itself, when Windows won't delete it (a running harbor.exe). */
function aside(p: string): void {
  renameSync(p, `${p}${ASIDE}${Date.now()}`);
}

/** Deletes what `replace` moved aside before, now that nothing runs it (best effort: still running stays). */
export function sweepAside(dir: string): void {
  if (!WINDOWS) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.includes(ASIDE)) continue;
    try {
      rmSync(join(dir, n), { recursive: true, force: true });
    } catch {}
  }
}

// Linux appends " (deleted)" once an update replaced the running file.
export function selfExe(execPath: string = process.execPath): string {
  return execPath.replace(/ \(deleted\)$/, "");
}

export function installDir(execPath: string = process.execPath): string | null {
  const dir = dirname(selfExe(execPath));
  return isFile(join(dir, MANAGED)) ? dir : null;
}

export function replace(src: string, dst: string, prev?: string, windows: boolean = WINDOWS): void {
  if (windows) {
    // The file in use (harbor.exe running) can be renamed, not overwritten: kept in `prev` by renaming, or set aside.
    if (isFile(dst)) {
      if (prev !== undefined) {
        const keep = join(prev, basename(dst));
        if (isFile(keep)) aside(keep);
        renameSync(dst, keep);
      } else aside(dst);
    }
    renameSync(src, dst);
    return;
  }
  if (prev !== undefined && isFile(dst)) {
    const keep = join(prev, basename(dst));
    remove(keep);
    try {
      linkSync(dst, keep);
    } catch {
      copyFileSync(dst, keep);
    }
  }
  renameSync(src, dst);
}

export function writeAtomic(p: string, data: string): void {
  const tmp = `${p}.new`;
  writeFileSync(tmp, data);
  // Windows: rename over a file another program is reading fails a moment; tried again.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, p);
      return;
    } catch (e) {
      if (!WINDOWS || i >= 3) throw e;
      Bun.sleepSync(20);
    }
  }
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export const fresh = (p: string): string => {
  remove(p);
  return ensureDir(p);
};

export const exists = existsSync;

export const alive = (pid: number): boolean => proc.running(pid);

export function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}
