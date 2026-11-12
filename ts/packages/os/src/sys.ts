// The machine: its memory, its boot, its network tables.
import { readFileSync } from "node:fs";
import { platform } from "./platform.ts";

const procfs = (): boolean => platform() === "linux";

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Bytes. */
export interface Memory {
  total: number;
  /** What programs can still get without swapping: the kernel's own estimate, caches it can drop included. */
  available: number;
  swapTotal: number;
  swapFree: number;
}

/** /proc/meminfo's text (this PC's, or a Linux device's over SSH). */
export function parseMeminfo(text: string): Memory | null {
  const kb = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return m?.[1] === undefined ? null : Number(m[1]) * 1024;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable") ?? kb("MemFree");
  if (total === null || available === null || total <= 0) return null;
  const swapTotal = kb("SwapTotal") ?? 0;
  return { total, available, swapTotal, swapFree: kb("SwapFree") ?? swapTotal };
}

/** This PC's memory; null when it can't be read. */
export function memory(): Memory | null {
  if (!procfs()) return null;
  const t = read("/proc/meminfo");
  return t === null ? null : parseMeminfo(t);
}

/** Free memory in MB (MemAvailable); null when it can't be read. `HARBOR_TEST_MEMAVAIL_MB` stands in for it in rigs. */
export function memAvailableMb(env: Record<string, string | undefined> = process.env): number | null {
  const forced = env.HARBOR_TEST_MEMAVAIL_MB;
  if (forced !== undefined && /^\d+$/.test(forced)) return Number(forced);
  const m = memory();
  return m === null ? null : Math.floor(m.available / (1024 * 1024));
}

/** Changes at every boot, the same until the next; "" when unknown. */
export function bootId(): string {
  if (!procfs()) return "";
  return read("/proc/sys/kernel/random/boot_id")?.trim() ?? "";
}

/** The kernel's network tables Harbor reads (/proc/net/<name> on Linux). */
export type NetTable = "route" | "ipv6_route" | "tcp" | "tcp6" | "if_inet6";

/**
 * A network table's text in Linux's /proc/net format; null where there is none (other systems, for now:
 * their callers then act as when the table can't be read).
 */
export function netTable(name: NetTable): string | null {
  return procfs() ? read(`/proc/net/${name}`) : null;
}
