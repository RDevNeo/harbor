// An exclusive file lock (by path, through @harbor/os): Bun has none, and the Claude CLI and the usage
// monitor serialize writes to `.credentials.json` with one.
import { lock } from "@harbor/os";

/** Holds an exclusive lock on `path` (created if missing) until the returned function runs; null when it couldn't. */
export function lockFile(path: string): (() => void) | null {
  const held = lock.hold(path, true);
  return held ? () => held.release() : null;
}
