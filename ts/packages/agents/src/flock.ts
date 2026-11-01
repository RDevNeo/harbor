// flock(2) through libc: Bun has no file locks, and the Claude CLI and the usage monitor
// serialize writes to `.credentials.json` with one.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const LOCK_EX = 2;

let lib: { symbols: { flock: (fd: number, op: number) => number } } | null | undefined;

function libc(): typeof lib {
  if (lib !== undefined) return lib;
  for (const name of ["libc.so.6", "libc.so"]) {
    try {
      lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      return lib;
    } catch {}
  }
  lib = null;
  return lib;
}

/** Holds an exclusive lock on `path` (created if missing) until the returned function runs; null when it couldn't. */
export function lockFile(path: string): (() => void) | null {
  const l = libc();
  if (!l) return null;
  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch {
    return null;
  }
  if (l.symbols.flock(fd, LOCK_EX) !== 0) {
    closeSync(fd);
    return null;
  }
  return () => closeSync(fd);
}
