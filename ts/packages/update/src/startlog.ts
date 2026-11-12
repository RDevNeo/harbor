import { closeSync, existsSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isatty } from "node:tty";
import { format } from "node:util";
import { libc, platform } from "@harbor/os";

export const START_LOG = "start.log";
export const FAILED_LOG = "failed-start.log";

/**
 * A start from the desktop has its stderr where nobody reads it. Until `confirmed()`, it goes to start.log in
 * the install folder, then back where it was. A terminal keeps it.
 */
export function captureStart(dir: string, confirmed: () => boolean): void {
  if (isatty(2)) return;
  if (platform() === "win32") {
    captureWindows(join(dir, START_LOG), confirmed);
    return;
  }
  if (!libc.redirectable()) return;
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

/**
 * Windows has no dup2 for Bun's fd 2: native code's stderr handle is pointed at the file (addons, crash
 * reports), and what Bun writes itself is copied there: console.error and console.warn, process.stderr, and an
 * uncaught exception or unhandled rejection, which still ends the process as before. All of it until confirmed.
 */
function captureWindows(path: string, confirmed: () => boolean): void {
  const restoreNative = libc.stderrHandleTo(path);
  let fd: number;
  try {
    fd = openSync(path, "a", 0o600);
  } catch {
    restoreNative?.();
    return;
  }
  const put = (text: string): void => {
    try {
      writeSync(fd, text);
    } catch {
      // the log is gone: the start goes on
    }
  };
  const was = { error: console.error, warn: console.warn, write: process.stderr.write };
  console.error = (...a: unknown[]): void => {
    put(`${format(...a)}\n`);
    was.error.apply(console, a);
  };
  console.warn = (...a: unknown[]): void => {
    put(`${format(...a)}\n`);
    was.warn.apply(console, a);
  };
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    put(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return (was.write as (...x: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  const monitor = (e: unknown, origin: string): void => put(`${origin}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  // Thrown again: Bun's own end for an unhandled rejection (printed, exit 1), and the monitor writes it here.
  const rejected = (reason: unknown): never => {
    throw reason;
  };
  process.on("uncaughtExceptionMonitor", monitor);
  process.on("unhandledRejection", rejected);
  const t = setInterval(() => {
    if (!confirmed()) return;
    clearInterval(t);
    console.error = was.error;
    console.warn = was.warn;
    process.stderr.write = was.write;
    process.off("uncaughtExceptionMonitor", monitor);
    process.off("unhandledRejection", rejected);
    restoreNative?.();
    closeSync(fd);
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
