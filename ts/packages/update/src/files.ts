import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { proc } from "@harbor/os";

export const MANAGED = ".managed";
export const RUNTIME_FILE = "harbor";
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
  rmSync(p, { recursive: true, force: true });
}

// Linux appends " (deleted)" once an update replaced the running file.
export function selfExe(execPath: string = process.execPath): string {
  return execPath.replace(/ \(deleted\)$/, "");
}

export function installDir(execPath: string = process.execPath): string | null {
  const dir = dirname(selfExe(execPath));
  return isFile(join(dir, MANAGED)) ? dir : null;
}

export function replace(src: string, dst: string, prev?: string): void {
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
  renameSync(tmp, p);
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
