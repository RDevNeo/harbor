// Starting programs that must outlive Harbor: a reload or Harbor exiting doesn't reach them.
import { spawn, spawnSync } from "node:child_process";
import { constants, openSync, readSync } from "node:fs";
import { platform } from "./platform.ts";

/**
 * `argv` as a command that starts it in a session of its own and returns at once, the program no
 * child of the caller's (Linux: `setsid -f`), for a launcher that runs it (a systemd scope); null
 * where there's no such command (macOS: startDetached starts it).
 */
export function detachedArgv(argv: readonly string[]): string[] | null {
  return platform() === "linux" ? ["setsid", "-f", ...argv] : null;
}

/** Starts `argv` in a session of its own, with no stdio, and doesn't wait for it. Throws when it couldn't start. */
export function startDetached(argv: readonly string[]): void {
  const wrapped = detachedArgv(argv);
  if (wrapped !== null) {
    const r = spawnSync(wrapped[0] as string, wrapped.slice(1), { stdio: "ignore" });
    if (r.error || r.status === null) throw new Error(`couldn't start ${wrapped[0]}`);
    return;
  }
  // setsid() in the child: its own session and process group, so signals to Harbor's don't reach it.
  // Windows: a process of its own with no console window (DETACHED_PROCESS, CREATE_NO_WINDOW).
  const p = spawn(argv[0] as string, argv.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
  p.on("error", () => {});
  if (p.pid === undefined) throw new Error(`couldn't start ${argv[0]}`);
  p.unref();
}

/** A compiled Harbor (one executable), not Bun on its sources: the bundle's own path is Bun's virtual one. */
export function compiled(): boolean {
  return Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
}

/** How to start this program again: the executable, and from source its entry script. */
export function selfArgv(): string[] {
  const exe = process.execPath.replace(/ \(deleted\)$/, "");
  if (compiled()) return [exe];
  return [exe, process.env.HARBOR_ENTRY ?? Bun.main];
}

/**
 * A file a child program writes its output to, after what it holds already: an append-mode fd on Linux and
 * macOS. Windows: an append-mode handle there is write-at-end only, which Git Bash's programs (sh, bash and
 * what they run) refuse ("write error: Bad file descriptor"); this one is read-write, placed at the end. Two
 * outputs into one file share one such fd (each its own would write over the other's).
 */
export function outputFile(path: string, mode = 0o600): number {
  if (platform() !== "win32") return openSync(path, "a", mode);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, mode);
  // To the end: reads move this handle's place (positional ones put it back).
  const buf = Buffer.alloc(1 << 16);
  while (readSync(fd, buf, 0, buf.length, null) > 0) {
    // what was written before this one
  }
  return fd;
}
