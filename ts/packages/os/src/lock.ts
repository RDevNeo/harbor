// Exclusive file locks between processes, by path: flock(2) where there is a libc (Linux, macOS), a byte-range
// lock on a handle of its own on Windows (Bun's descriptors there aren't the C runtime's, so an fd can't be
// locked). The system drops a lock when its holder dies, so a crash never blocks the next start.
import { closeSync, openSync } from "node:fs";
import { flock, LOCK_EX, LOCK_NB, LOCK_UN } from "./libc.ts";
import { win } from "./win32/load.ts";

export interface Held {
  release(): void;
}

/**
 * Takes the exclusive lock on `path` (created if missing): with `wait`, blocks until it is free. Null when
 * another process holds it; undefined when it can't be had at all (no file locks here, or the file can't be
 * opened: a read-only folder), and callers then go on as if they held it.
 */
export function hold(path: string, wait: boolean): Held | null | undefined {
  const w = win();
  if (w) return w.lock.hold(path, wait);
  let fd: number;
  try {
    fd = openSync(path, "a+", 0o600);
  } catch {
    return undefined;
  }
  const got = flock(fd, LOCK_EX | (wait ? 0 : LOCK_NB));
  if (got === null) {
    closeSync(fd);
    return undefined;
  }
  if (got !== 0) {
    closeSync(fd);
    return null;
  }
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      closeSync(fd);
    },
  };
}

/** Whether another process holds the lock on `path` now (without keeping it). Null when that can't be told. */
export function heldElsewhere(path: string): boolean | null {
  const w = win();
  if (w) return w.lock.heldElsewhere(path);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const got = flock(fd, LOCK_EX | LOCK_NB);
    if (got === null) return null;
    if (got === 0) flock(fd, LOCK_UN);
    return got !== 0;
  } finally {
    closeSync(fd);
  }
}
