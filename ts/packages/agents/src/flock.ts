// An exclusive file lock (flock(2) through @harbor/os): Bun has none, and the Claude CLI and the usage
// monitor serialize writes to `.credentials.json` with one.
import { libc } from "@harbor/os";
import { closeSync, openSync } from "node:fs";

/** Holds an exclusive lock on `path` (created if missing) until the returned function runs; null when it couldn't. */
export function lockFile(path: string): (() => void) | null {
  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch {
    return null;
  }
  if (libc.flock(fd, libc.LOCK_EX) !== 0) {
    closeSync(fd);
    return null;
  }
  return () => closeSync(fd);
}
