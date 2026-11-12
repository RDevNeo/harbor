// Starting programs that must outlive Harbor: a reload or Harbor exiting doesn't reach them.
import { spawn, spawnSync } from "node:child_process";
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
  const p = spawn(argv[0] as string, argv.slice(1), { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  if (p.pid === undefined) throw new Error(`couldn't start ${argv[0]}`);
  p.unref();
}

/** How to start this program again: the executable, and from source its entry script. */
export function selfArgv(): string[] {
  const exe = process.execPath.replace(/ \(deleted\)$/, "");
  if (Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/")) return [exe];
  return [exe, process.env.HARBOR_ENTRY ?? Bun.main];
}
