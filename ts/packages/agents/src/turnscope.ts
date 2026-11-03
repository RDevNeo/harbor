// Each local turn (its runner, the agent and every command the agent starts) runs in a systemd user
// scope of its own, under harbor-turns.slice: a burst throttles the turns instead of the desktop,
// systemd-oomd kills one turn instead of all of Harbor, and whatever a turn leaves running dies with
// its scope. The scope belongs to the user's systemd, not to Harbor's process tree, so turns still
// outlive a Harbor reload. Without systemd --user (macOS, Windows, containers) turns start as before.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const SLICE = "harbor-turns.slice";

/** All turns together. Percentages of RAM so a small laptop and a big desktop both get sane limits:
 *  on 8 GB about 2.6 GB before throttling and 3.7 GB at most (swap comes on top). oomd acts on lasting
 *  pressure only, and then on the one turn under the most of it. */
export const SLICE_LIMITS = ["MemoryHigh=35%", "MemoryMax=50%", "CPUWeight=50"];
export const SLICE_OOM = ["ManagedOOMMemoryPressure=kill", "ManagedOOMMemoryPressureLimit=80%", "ManagedOOMSwap=kill"];

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

let prepared: Promise<void> | undefined;

/** Once per Harbor: the slice's limits (runtime only, so nothing lands in the user's config), and
 *  Harbor's own unit asks oomd to pick something else first. */
function prepare(): Promise<void> {
  prepared ??= (async () => {
    const set = ["systemctl", "--user", "set-property", "--runtime", SLICE];
    // An older systemd without oomd's properties still gets the limits.
    if (!(await quiet([...set, ...SLICE_LIMITS, ...SLICE_OOM]))) await quiet([...set, ...SLICE_LIMITS]);
    const own = ownUnit();
    if (own !== undefined && process.env.NODE_ENV !== "test") void quiet(["systemctl", "--user", "set-property", "--runtime", own, "ManagedOOMPreference=avoid"]);
  })();
  return prepared;
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
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
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
  const fs = join("/sys/fs/cgroup", path);
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
}
