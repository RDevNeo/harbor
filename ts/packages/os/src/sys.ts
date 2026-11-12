// The machine: its memory, its boot, its network tables.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "./platform.ts";
import { win } from "./win32/load.ts";

const procfs = (): boolean => platform() === "linux";

let darwinLib: typeof import("./darwin.ts") | undefined;
const mac = (): typeof import("./darwin.ts") | undefined =>
  platform() === "darwin" ? (darwinLib ??= require("./darwin.ts") as typeof import("./darwin.ts")) : undefined;

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

/**
 * macOS's `sysctl hw.memsize vm.swapusage` and `vm_stat` (this Mac's, or a Mac device's over SSH). What's
 * available is what Activity Monitor doesn't count as Memory Used (app memory, wired, compressed).
 */
export function parseDarwinMemory(text: string): Memory | null {
  const total = Number(text.match(/^hw\.memsize:\s*(\d+)/m)?.[1] ?? Number.NaN);
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? Number.NaN);
  if (!(total > 0) || !(page > 0)) return null;
  const pages = (name: string): number | null => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"));
    return m?.[1] === undefined ? null : Number(m[1]);
  };
  const anon = pages("Anonymous pages");
  const app = anon !== null ? Math.max(0, anon - (pages("Pages purgeable") ?? 0)) : (pages("Pages active") ?? 0);
  const used = Math.min(total, (app + (pages("Pages wired down") ?? 0) + (pages("Pages occupied by compressor") ?? 0)) * page);
  const swap = (k: string): number => {
    const m = text.match(new RegExp(`vm\\.swapusage:.*?${k} = ([\\d.]+)([KMG])`));
    return m?.[1] === undefined ? 0 : Number(m[1]) * 1024 ** ({ K: 1, M: 2, G: 3 }[m[2] as "K" | "M" | "G"] ?? 2);
  };
  return { total, available: total - used, swapTotal: swap("total"), swapFree: swap("free") };
}

/** This PC's memory; null when it can't be read. */
export function memory(): Memory | null {
  const w = win();
  if (w) return w.sys.memory();
  const m = mac();
  if (m) return parseDarwinMemory(m.memoryText());
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
  const w = win();
  if (w) return w.sys.bootId();
  const m = mac();
  if (m) return m.bootTime();
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

/** A TCP socket listening on this PC: its port and the user that owns it (null: unknown). */
export interface Listener {
  port: number;
  uid: number | null;
}

/** /proc/net/tcp{,6} rows in LISTEN state (st 0A): sl local rem st queues timer retrnsmt uid … */
export function parseProcTcp(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8 || c[3] !== "0A") continue;
    const port = Number.parseInt(c[1]?.split(":")[1] ?? "", 16);
    if (Number.isInteger(port)) out.push({ port, uid: /^\d+$/.test(c[7] ?? "") ? Number(c[7]) : null });
  }
  return out;
}

/** macOS's `netstat -anv -p tcp` LISTEN rows: the local address ends in `.port`, and `process:pid` names the owner. */
export function parseNetstat(text: string, uidOf: (pid: number) => number | undefined): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split("\n")) {
    const c = line.trim().split(/\s+/);
    if (!c[0]?.startsWith("tcp") || !c.includes("LISTEN")) continue;
    const port = Number(c[3]?.slice((c[3] ?? "").lastIndexOf(".") + 1));
    if (!Number.isInteger(port)) continue;
    const owner = c.slice(c.indexOf("LISTEN") + 1).find((x) => /:\d+$/.test(x));
    const pid = owner === undefined ? Number.NaN : Number(owner.slice(owner.lastIndexOf(":") + 1));
    out.push({ port, uid: Number.isInteger(pid) ? (uidOf(pid) ?? null) : null });
  }
  return out;
}

/** Every TCP socket listening on this PC, any user's; null where there's no way to ask. */
export function tcpListeners(): Listener[] | null {
  const w = win();
  if (w) return w.sys.tcpListeners();
  if (mac()) {
    const r = spawnSync("netstat", ["-anv", "-p", "tcp"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    const { ownerOf } = require("./proc.ts") as typeof import("./proc.ts");
    return parseNetstat(r.stdout, ownerOf);
  }
  const tables = [netTable("tcp"), netTable("tcp6")].filter((t): t is string => t !== null);
  return tables.length === 0 ? null : tables.flatMap(parseProcTcp);
}
