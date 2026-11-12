// Each local turn (its runner, the agent and every command the agent starts) runs in a systemd user
// scope of its own, under harbor-turns.slice: a burst throttles the turns instead of the desktop,
// systemd-oomd kills one turn instead of all of Harbor, and whatever a turn leaves running dies with
// its scope. The scope belongs to the user's systemd, not to Harbor's process tree, so turns still
// outlive a Harbor reload. Without systemd --user (macOS, Windows, containers) turns start as before.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { proc } from "@harbor/os";

export const SLICE = "harbor-turns.slice";

/** The slice SLICE sits in (a dash in a slice's name nests it). It is what competes with the desktop's
 *  app.slice for CPU: a weight on SLICE alone, its only child, would change nothing. */
export const PARENT = "harbor.slice";

/** All turns together. Percentages of RAM so a small laptop and a big desktop both get sane limits:
 *  on 8 GB about 2.6 GB before throttling and 3.7 GB at most (swap comes on top). oomd acts on lasting
 *  pressure only, and then on the one turn under the most of it. */
export const SLICE_LIMITS = ["MemoryHigh=35%", "MemoryMax=50%", "CPUWeight=20"];
export const SLICE_OOM = ["ManagedOOMMemoryPressure=kill", "ManagedOOMMemoryPressureLimit=80%", "ManagedOOMSwap=kill"];
/** Turns get a fifth of the CPU (and, where the user's systemd has the io controller, of the disk) that an app
 *  at the default weight gets when both want it: builds and test loops can't starve the window. */
export const PARENT_LIMITS = ["CPUWeight=20"];
export const IO_LIMITS = ["IOWeight=20"];

/** Harbor's own unit (the window, the hub, the store): ahead of the desktop's other apps for CPU, and its
 *  memory protected so pressure from turns and other apps reclaims elsewhere first: a window whose pages were
 *  swapped out or evicted waits on the disk at every click, and Hyprland calls it not responding. */
export const APP_LIMITS = ["CPUWeight=200", "ManagedOOMPreference=avoid"];
export const APP_IO = ["IOWeight=200"];

/** The memory Harbor main keeps from reclaim: its window and store (~250-400 MB) plus some of the database's
 *  pages, at most 8% of RAM so a small PC keeps room for everything else. */
export function appMemoryLow(total: number = totalmem()): number {
  return Math.min(512 * 2 ** 20, Math.round((total * 0.08) / 2 ** 20) * 2 ** 20);
}

/** How long a finished turn's leftovers get after SIGTERM before the scope is killed. */
const GRACE_MS = 1500;

/** The scope a turn folder's runner starts in. */
export function unitOf(dir: string): string {
  return `harbor-turn-${basename(dir).replace(/[^A-Za-z0-9:_.-]/g, "_")}.scope`;
}

/** Where systemd --user listens; Harbor may have been started without it in its environment. */
function runtimeDir(): string {
  return process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
}

function env(): Record<string, string | undefined> {
  return { ...process.env, XDG_RUNTIME_DIR: runtimeDir() };
}

let usable: boolean | undefined;

/** systemd --user is there to make scopes (`HARBOR_TURN_SCOPE=0` turns them off). */
export function available(): boolean {
  usable ??=
    process.platform === "linux" &&
    process.env.HARBOR_TURN_SCOPE !== "0" &&
    Bun.which("systemd-run") !== null &&
    Bun.which("systemctl") !== null &&
    existsSync(join(runtimeDir(), "systemd/private"));
  return usable;
}

/** systemd answering slowly (or not at all) counts as no systemd: a turn's start doesn't wait on it. */
const ANSWER_MS = 5000;

async function quiet(argv: string[]): Promise<boolean> {
  try {
    const p = Bun.spawn(argv, { env: env(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), ANSWER_MS);
    const code = await p.exited;
    clearTimeout(t);
    return code === 0 && p.signalCode === null;
  } catch {
    return false;
  }
}

/** `systemctl --user set-property --runtime` (nothing lands in the user's config). */
function setProperty(unit: string, props: readonly string[]): Promise<boolean> {
  return quiet(["systemctl", "--user", "set-property", "--runtime", unit, ...props]);
}

/** Where cgroup v2 is mounted. */
const CGROUP_ROOT = "/sys/fs/cgroup";

let prepared: Promise<void> | undefined;

/** Once per Harbor: the slice's limits (runtime only, so nothing lands in the user's config). */
function prepare(): Promise<void> {
  prepared ??= (async () => {
    // An older systemd without oomd's properties still gets the limits.
    if (!(await setProperty(SLICE, [...SLICE_LIMITS, ...SLICE_OOM]))) await setProperty(SLICE, SLICE_LIMITS);
    await setProperty(PARENT, PARENT_LIMITS);
    // The io controller is often not delegated to the user's systemd: then these say nothing and do nothing.
    await setProperty(SLICE, IO_LIMITS);
    await setProperty(PARENT, IO_LIMITS);
    await protectApp();
  })();
  return prepared;
}

let protecting: Promise<void> | undefined;

/**
 * Once per Harbor main, at start: APP_LIMITS and MemoryLow on its own unit (runtime only). A cgroup's memory.low
 * protects only as much as its parents pass down, so the slices between the unit and the user's manager
 * (app.slice, app-graphical.slice) get at least as much, never less than they have. Not in tests or rigs
 * (NODE_ENV=test, HARBOR_TURN_SCOPE=0), nor where Harbor isn't a unit of its own (a terminal's scope).
 */
export function protectApp(): Promise<void> {
  protecting ??= (async () => {
    if (!available() || process.env.NODE_ENV === "test") return;
    const own = ownUnit();
    const path = cgroupOf("self");
    if (own === undefined || path === undefined) return;
    const low = appMemoryLow();
    const set = setProperty;
    if (!(await set(own, [...APP_LIMITS, `MemoryLow=${low}`]))) await set(own, [`MemoryLow=${low}`]);
    await set(own, APP_IO);
    for (const slice of slicesAbove(path)) {
      if (lowOf(slice.dir) < low) await set(slice.unit, [`MemoryLow=${low}`]);
    }
  })();
  return protecting;
}

/** The slices between a unit's cgroup and the user's manager (user@N.service), nearest first. */
export function slicesAbove(path: string): { unit: string; dir: string }[] {
  const out: { unit: string; dir: string }[] = [];
  for (let p = dirname(path); p !== "/" && p !== "." && !/\/user@\d+\.service$/.test(p); p = dirname(p)) {
    const unit = basename(p);
    if (!unit.endsWith(".slice")) break;
    out.push({ unit, dir: join(CGROUP_ROOT, p) });
  }
  return out;
}

function lowOf(dir: string): number {
  try {
    const t = readFileSync(join(dir, "memory.low"), "utf8").trim();
    return t === "max" ? Number.POSITIVE_INFINITY : Number(t) || 0;
  } catch {
    return 0;
  }
}

/** This process's own unit in the user's systemd, if it is a plain app scope or service. */
function ownUnit(): string | undefined {
  const path = cgroupOf("self");
  if (path === undefined || !/\/user@\d+\.service\//.test(path)) return undefined;
  const unit = basename(path);
  if (unit.startsWith("harbor-turn-") || !/\.(scope|service)$/.test(unit)) return undefined;
  return unit;
}

/** The cgroup v2 path of a process ("self" or a pid). */
function cgroupOf(pid: number | "self"): string | undefined {
  try {
    const line = (proc.cgroupText(pid) ?? "")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    return line === undefined ? undefined : line.slice(3);
  } catch {
    return undefined;
  }
}

/** The turn's scope as a cgroup folder, read from a process in it; nothing if it isn't in that turn's scope. */
export function scopeOf(pid: number | "self", dir: string): string | undefined {
  const path = cgroupOf(pid);
  if (path === undefined || basename(path) !== unitOf(dir)) return undefined;
  const fs = join(CGROUP_ROOT, path);
  return existsSync(fs) ? fs : undefined;
}

/** Starts `argv` (the setsid'd runner) in the turn's scope; false if no scope could be made, so the caller starts it plainly. */
export async function start(argv: readonly string[], dir: string, chat: number): Promise<boolean> {
  if (!available()) return false;
  await prepare();
  const ok = await quiet([
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--slice=${SLICE}`,
    `--unit=${unitOf(dir)}`,
    `--description=Harbor turn (chat ${chat})`,
    "--",
    ...argv,
  ]);
  // systemd-run fails before it runs anything, so the plain start can't run the turn twice.
  if (!ok) usable = false;
  return ok;
}

function procs(scope: string): number[] {
  try {
    return readFileSync(join(scope, "cgroup.procs"), "utf8")
      .split("\n")
      .filter((l) => /^\d+$/.test(l))
      .map(Number);
  } catch {
    return [];
  }
}

function signal(list: readonly number[], sig: NodeJS.Signals): void {
  for (const p of list) {
    try {
      process.kill(p, sig);
    } catch {
      // gone meanwhile
    }
  }
}

/** Asks every process in a managed scope to stop, including children in other process groups. */
export function terminate(scope: string): void {
  signal(procs(scope), "SIGTERM");
}

/** Kills everything in the scope at once (also processes forking meanwhile). */
export function kill(scope: string): void {
  try {
    writeFileSync(join(scope, "cgroup.kill"), "1");
    return;
  } catch {
    // a kernel before 5.14: one by one
  }
  for (let i = 0; i < 4; i++) {
    const left = procs(scope).filter((p) => p !== process.pid);
    if (left.length === 0) return;
    signal(left, "SIGKILL");
  }
}

/** The runner, once its agent exited and `exit` is written: what the turn left running gets SIGTERM, then the scope is killed (the runner with it). */
export async function endOwn(dir: string): Promise<void> {
  const scope = scopeOf("self", dir);
  if (scope === undefined) return;
  const others = (): number[] => procs(scope).filter((p) => p !== process.pid);
  if (others().length === 0) return;
  signal(others(), "SIGTERM");
  const t = Date.now();
  while (others().length > 0 && Date.now() - t < GRACE_MS) await Bun.sleep(50);
  if (others().length > 0) kill(scope);
}

/** Harbor, for a turn it stopped or whose runner died without saying how it ended: whatever is left in
 *  its scope goes. `scope` is the runner's, read while it was alive; without it systemd stops the unit. */
export function end(dir: string, scope: string | undefined): void {
  if (scope !== undefined && existsSync(scope)) {
    kill(scope);
    return;
  }
  if (available()) void quiet(["systemctl", "--user", "stop", unitOf(dir)]);
}

/** For tests: forget what was found out about systemd. */
export function reset(): void {
  usable = undefined;
  prepared = undefined;
  protecting = undefined;
}
