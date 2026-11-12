// How each commit this PC ran has held up (follow-main, docs in followmain.ts): how long it ran, how it
// ended, and whether its build's checks passed. `soaked.ts` tags a release only for a commit that ran
// here long enough without a crash. One small JSON file under Harbor's data folder, written about once a
// minute while Harbor runs.
import { join } from "node:path";
import { ensureDir, readJson, writeAtomic } from "./files.ts";
import { sys } from "@harbor/os";

export const HEALTH_FILE = "health.json";
/** A run's heartbeat: how often its uptime is added up. */
export const BEAT_MS = 60_000;
/** A longer gap between two beats is a suspend (or a stopped process), not uptime. */
export const MAX_GAP_MS = 150_000;
/** A crash this soon after the start counts towards a rollback (`earlyCrashes`). */
export const EARLY_MS = 10 * 60_000;
/** How many early crashes, within `CRASH_WINDOW_MS`, roll a build of main back. */
export const CRASH_LIMIT = 2;
export const CRASH_WINDOW_MS = 60 * 60_000;
/** The default soak before a commit may be released (`soaked.ts --hours`). */
export const SOAK_HOURS = 6;
const KEEP = 200;

export interface Run {
  pid: number;
  /** The kernel's boot id: a run that ended with the PC (shutdown, logout) isn't a crash. */
  boot: string;
  start: number;
  last: number;
}

export interface Crash {
  at: number;
  why: string;
  /** Within `EARLY_MS` of its start. */
  early: boolean;
}

export interface Checks {
  /** `tsc --noEmit` in the build's clone. */
  tsc: boolean;
  /** The bundle loads in this PC's runtime (`smoke-bundle`). */
  smoke: boolean;
  at: number;
}

export interface CommitHealth {
  commit: string;
  version: string;
  /** When it first ran here, in ms. */
  first: number;
  /** Time it ran, beats added up, suspends left out. */
  uptimeMs: number;
  crashes: Crash[];
  checks: Checks | null;
  /** The run going on (or the last one, if it never said how it ended). */
  run: Run | null;
  /** Its runs that ended well (a restart, a quit). */
  clean: number;
}

export interface HealthFile {
  commits: Record<string, CommitHealth>;
}

export const healthPath = (dir: string): string => join(dir, HEALTH_FILE);

export function readHealth(dir: string): HealthFile {
  const h = readJson<Partial<HealthFile>>(healthPath(dir));
  const commits: Record<string, CommitHealth> = {};
  if (h !== null && typeof h.commits === "object" && h.commits !== null) {
    for (const [k, v] of Object.entries(h.commits)) {
      if (typeof v !== "object" || v === null || typeof v.commit !== "string") continue;
      commits[k] = {
        commit: v.commit,
        version: typeof v.version === "string" ? v.version : "",
        first: Number(v.first) || 0,
        uptimeMs: Number(v.uptimeMs) || 0,
        crashes: Array.isArray(v.crashes) ? v.crashes.filter((c) => typeof c?.at === "number") : [],
        checks: v.checks && typeof v.checks === "object" ? v.checks : null,
        run: v.run && typeof v.run === "object" && typeof v.run.pid === "number" ? v.run : null,
        clean: Number(v.clean) || 0,
      };
    }
  }
  return { commits };
}

function write(dir: string, h: HealthFile): void {
  const all = Object.values(h.commits).sort((a, b) => b.first - a.first);
  const kept: Record<string, CommitHealth> = {};
  for (const c of all.slice(0, KEEP)) kept[c.commit] = c;
  ensureDir(dir);
  writeAtomic(healthPath(dir), JSON.stringify({ commits: kept }));
}

function entry(h: HealthFile, commit: string, version: string, now: number): CommitHealth {
  let c = h.commits[commit];
  if (c === undefined) {
    c = { commit, version, first: now, uptimeMs: 0, crashes: [], checks: null, run: null, clean: 0 };
    h.commits[commit] = c;
  }
  if (version !== "") c.version = version;
  return c;
}

export const bootId = (): string => sys.bootId();

const gapUptime = (from: number, to: number): number => (to > from && to - from <= MAX_GAP_MS ? to - from : 0);

/**
 * Settles a run that never said how it ended: in the same boot, with its process gone, it crashed (or was
 * killed); a run of an earlier boot ended with the PC. `alive` is the process check (files.ts `alive`).
 */
function settle(c: CommitHealth, boot: string, alive: (pid: number) => boolean, me: number): void {
  const r = c.run;
  if (r === null || r.pid === me) return;
  if (r.boot === boot && alive(r.pid)) return;
  if (r.boot === boot || boot === "" || r.boot === "") c.crashes.push({ at: r.last, why: "it stopped without exiting (crashed or killed)", early: r.last - r.start < EARLY_MS });
  c.run = null;
}

export interface Who {
  pid: number;
  boot: string;
  alive: (pid: number) => boolean;
}

/** This process starts running `commit`: earlier runs that never ended are settled first. */
export function begin(dir: string, commit: string, version: string, who: Who, now: number): CommitHealth {
  const h = readHealth(dir);
  for (const c of Object.values(h.commits)) settle(c, who.boot, who.alive, who.pid);
  const c = entry(h, commit, version, now);
  c.run = { pid: who.pid, boot: who.boot, start: now, last: now };
  write(dir, h);
  return c;
}

export function beat(dir: string, commit: string, pid: number, now: number): void {
  const h = readHealth(dir);
  const c = h.commits[commit];
  if (c?.run?.pid !== pid) return;
  c.uptimeMs += gapUptime(c.run.last, now);
  c.run.last = now;
  write(dir, h);
}

/** The process ends: code 0 is a clean end (a quit, a restart into an update), anything else a crash. */
export function end(dir: string, commit: string, pid: number, code: number, now: number): void {
  const h = readHealth(dir);
  const c = h.commits[commit];
  if (c?.run?.pid !== pid) return;
  c.uptimeMs += gapUptime(c.run.last, now);
  if (code === 0) c.clean++;
  else c.crashes.push({ at: now, why: `it exited with code ${code}`, early: now - c.run.start < EARLY_MS });
  c.run = null;
  write(dir, h);
}

export function recordChecks(dir: string, commit: string, version: string, checks: Omit<Checks, "at">, now: number): void {
  const h = readHealth(dir);
  entry(h, commit, version, now).checks = { ...checks, at: now };
  write(dir, h);
}

/** A crash recorded from outside the run (the start watchdog rolled the build back). */
export function recordCrash(dir: string, commit: string, version: string, why: string, now: number): void {
  const h = readHealth(dir);
  const c = entry(h, commit, version, now);
  if (!c.crashes.some((x) => x.why === why && Math.abs(x.at - now) < 60_000)) c.crashes.push({ at: now, why, early: true });
  write(dir, h);
}

export function earlyCrashes(c: CommitHealth | undefined, now: number, windowMs: number = CRASH_WINDOW_MS): number {
  return c === undefined ? 0 : c.crashes.filter((x) => x.early && now - x.at <= windowMs).length;
}

export type Soak = { ok: true } | { ok: false; why: string };

/** Whether `c` may be released: ran `hours` here, never crashed, and its build's checks passed. */
export function soak(c: CommitHealth | undefined, hours: number = SOAK_HOURS, now: number = Date.now()): Soak {
  if (c === undefined) return { ok: false, why: "never ran here" };
  if (c.crashes.length > 0) return { ok: false, why: `crashed ${c.crashes.length}× (${c.crashes[c.crashes.length - 1]?.why})` };
  if (c.checks === null) return { ok: false, why: "no checks recorded (not a follow-main build)" };
  if (!c.checks.tsc || !c.checks.smoke) return { ok: false, why: "its checks failed" };
  const live = c.run === null ? 0 : gapUptime(c.run.last, now);
  const ran = c.uptimeMs + live;
  if (ran < hours * 3_600_000) return { ok: false, why: `ran ${hoursText(ran)} of ${hours} h` };
  return { ok: true };
}

export const hoursText = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);
