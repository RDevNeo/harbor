import { closeSync, existsSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isatty } from "node:tty";
import { libc } from "@harbor/os";

export const START_LOG = "start.log";
export const FAILED_LOG = "failed-start.log";

/**
 * A start from the desktop has its stderr where nobody reads it. Until `confirmed()`, it goes to start.log in
 * the install folder, then back where it was. A terminal keeps it.
 */
export function captureStart(dir: string, confirmed: () => boolean): void {
  if (!libc.redirectable() || isatty(2)) return;
  let fd: number;
  try {
    fd = openSync(join(dir, START_LOG), "w", 0o600);
  } catch {
    return;
  }
  const saved = libc.dup(2) ?? -1;
  if (saved < 0 || (libc.dup2(fd, 2) ?? -1) < 0) {
    if (saved >= 0) libc.close(saved);
    closeSync(fd);
    return;
  }
  closeSync(fd);
  const t = setInterval(() => {
    if (!confirmed()) return;
    clearInterval(t);
    libc.dup2(saved, 2);
    libc.close(saved);
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
