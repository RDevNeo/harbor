// What @harbor/store stallwatch.ts needs of the OS: a Worker that samples the main thread from the kernel's
// view while it is stuck (Linux: /proc/self/task/<tid>/{stat,wchan,syscall}), and the PC's pressure (PSI).
import { readdirSync, readFileSync } from "node:fs";
import { platform } from "./platform.ts";
// Its source, not its path: a compiled executable or a bundle has no stallworker.ts beside it.
import * as workerText from "./stallworker.ts" with { type: "text" };

/** The sampling Worker's source (see stallworker.ts for its messages), or null where the OS has none. */
export function samplerSource(): string | null {
  return platform() === "linux" ? (workerText as unknown as { default: string }).default : null;
}

/** The thread id of the main thread, as the sampler wants it. */
export function mainThread(): number {
  return process.pid;
}

/** The PC's pressure right now: the share of the last 10 s some task waited on CPU, disk or memory ("" unknown). */
export function pressure(): string {
  if (platform() !== "linux") return "";
  const out: string[] = [];
  for (const k of ["cpu", "io", "memory"]) {
    try {
      const m = /^some avg10=([\d.]+)/m.exec(readFileSync(`/proc/pressure/${k}`, "utf8"));
      if (m) out.push(`${k} ${Math.round(Number(m[1]))}%`);
    } catch {
      // no PSI (older kernel)
    }
  }
  return out.join(", ");
}

/** Open fds and threads of this process (-1 unknown), for leak traces. */
export function handles(): { fds: number; threads: number } {
  if (platform() !== "linux") return { fds: -1, threads: -1 };
  const count = (dir: string): number => {
    try {
      return readdirSync(dir).length;
    } catch {
      return -1;
    }
  };
  return { fds: count("/proc/self/fd"), threads: count("/proc/self/task") };
}

/** Resident and swapped KB of this process (0 unknown). */
export function selfMemoryKb(): { rss: number; swap: number } {
  if (platform() !== "linux") return { rss: 0, swap: 0 };
  let status = "";
  try {
    status = readFileSync("/proc/self/status", "utf8");
  } catch {
    // gone
  }
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0);
  return { rss: kb("VmRSS"), swap: kb("VmSwap") };
}
