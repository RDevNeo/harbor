import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isatty } from "node:tty";

export const START_LOG = "start.log";
export const FAILED_LOG = "failed-start.log";

/**
 * A start from the desktop has its stderr where nobody reads it. Until `confirmed()`, it goes to start.log in
 * the install folder, then back where it was. A terminal keeps it.
 */
export function captureStart(dir: string, confirmed: () => boolean): void {
  if (process.platform !== "linux" || isatty(2)) return;
  const libc = dlopen("libc.so.6", {
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  let fd: number;
  try {
    fd = openSync(join(dir, START_LOG), "w", 0o600);
  } catch {
    return;
  }
  const saved = libc.symbols.dup(2);
  if (saved < 0 || libc.symbols.dup2(fd, 2) < 0) {
    if (saved >= 0) libc.symbols.close(saved);
    closeSync(fd);
    return;
  }
  closeSync(fd);
  const t = setInterval(() => {
    if (!confirmed()) return;
    clearInterval(t);
    libc.symbols.dup2(saved, 2);
    libc.symbols.close(saved);
  }, 500);
  t.unref();
}

/** Keeps the failed start's stderr under a name the next start doesn't overwrite; its path, if there was one. */
export function keepFailedLog(dir: string): string | undefined {
  const from = join(dir, START_LOG);
  if (!existsSync(from)) return undefined;
  const to = join(dir, FAILED_LOG);
  try {
    renameSync(from, to);
    return to;
  } catch {
    return undefined;
  }
}
