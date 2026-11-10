import { appendFileSync, readFileSync, rmSync, statSync } from "node:fs";
import type { UpdateConfig } from "./config.ts";
import { isFile } from "./files.ts";
import { fail, readMeta } from "./previewmeta.ts";

export const STATE_KEY = "reload_state";
export const RELOADED_PID = "HARBOR_RELOADED_PID";
export const BACKGROUND_FLAG = "--background";
/** Set by a restart with a window: the file the new process says "ready" (its window is built) and then "shown" in. */
export const HANDOVER = "HARBOR_HANDOVER";
/** How long the old process waits for the new one's window to be built before it steps aside anyway. */
export const READY_MS = 45_000;
/** How long the old window stays, after the old process let go, waiting for the new one to show. */
export const SHOWN_MS = 20_000;
const POLL_MS = 20;
const DEV_HOOKS = ["HARBOR_VIEW", "HARBOR_POINTER"];
const WATCH_MS = 1500;

export interface Kv {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

// The shape the Rust app writes, so a restart between the two apps keeps the screen.
export type Snapshot = Record<string, unknown>;

export function draftsOf(drafts: ReadonlyMap<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, t] of drafts) if (t.trim() !== "") out[String(k)] = t;
  return out;
}

export function draftsFrom(snapshot: Snapshot): Map<number, string> {
  const out = new Map<number, string>();
  const raw = snapshot.drafts;
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, t] of Object.entries(raw)) {
    const id = Number(k);
    if (Number.isInteger(id) && typeof t === "string") out.set(id, t);
  }
  return out;
}

export function takeSnapshot(kv: Kv): Snapshot | null {
  const text = kv.get(STATE_KEY);
  if (text === null || text === "") return null;
  kv.set(STATE_KEY, "");
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Snapshot) : null;
  } catch {
    return null;
  }
}

export interface ReloaderOptions {
  cfg: UpdateConfig;
  kv: Kv;
  snapshot: () => Snapshot;
  args: () => string[];
  hidden: () => boolean;
  beforeExit?: () => void | Promise<void>;
  release?: () => void;
  spawn?: (cmd: string[], env: Record<string, string | undefined>) => Spawned | void;
  exit?: (code: number) => void;
  /**
   * A restart with a window hands over (handover.ts): this file is where the new process says it's ready. The new one
   * starts first and builds its window while this one still runs; then this one saves the screen, stops and lets go,
   * and its window stays until the new one shows (no blank moment). Unset: the plain restart.
   */
  handover?: string;
  /** After the snapshot: what the window takes from now on goes to the next process at once. */
  leaving?: () => void;
  /** Extra environment that puts the new window where this one is (handover.ts `placeEnv`). */
  place?: () => Promise<Record<string, string>>;
}

export interface Spawned {
  /** Resolves when the process ends. */
  exited: Promise<unknown>;
}

function spawnDetached(cmd: string[], env: Record<string, string | undefined>): Spawned {
  const p = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  p.unref();
  return { exited: p.exited };
}

/** What the new process wrote in the handover file. */
export function handoverSaid(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** The new process's side: a line in the handover file ("ready", "shown"). */
export function handoverSay(file: string, word: string): void {
  try {
    appendFileSync(file, `${word}\n`);
  } catch {
    // The old process is gone already: nobody to tell.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Until the file says `word`, the process ends, or `ms` pass. */
async function until(file: string, word: string, ended: () => boolean, ms: number): Promise<"said" | "ended" | "late"> {
  const end = Date.now() + ms;
  for (;;) {
    if (handoverSaid(file).includes(word)) return "said";
    if (ended()) return "ended";
    if (Date.now() >= end) return "late";
    await sleep(POLL_MS);
  }
}

export class Reloader {
  private going = false;
  /** A new process is starting beside this one (its focus requests aren't the user's). */
  handingOver = false;

  constructor(private readonly o: ReloaderOptions) {}

  async now(): Promise<boolean> {
    if (this.going) return true;
    const { cfg } = this.o;
    if (!isFile(cfg.exe)) {
      cfg.log(`reload failed: ${cfg.exe} is gone`);
      return false;
    }
    this.going = true;
    const hidden = this.o.hidden();
    const args = this.o.args().filter((a) => a !== BACKGROUND_FLAG);
    if (hidden) args.push(BACKGROUND_FLAG);
    const env: Record<string, string | undefined> = { ...process.env, [RELOADED_PID]: String(process.pid) };
    for (const k of DEV_HOOKS) delete env[k];
    delete env[HANDOVER];
    const cmd = [cfg.exe, ...(cfg.script === undefined ? [] : [cfg.script]), ...args];
    if (!hidden && this.o.handover !== undefined && (await this.handOver(cmd, env, this.o.handover))) return true;
    this.o.kv.set(STATE_KEY, JSON.stringify(this.o.snapshot()));
    try {
      await this.o.beforeExit?.();
      // The Rust app waits for the lock only when it replaced its own pid.
      this.o.release?.();
      (this.o.spawn ?? spawnDetached)(cmd, env);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      cfg.log(`reload failed: ${err}`);
      this.failed(err);
      this.going = false;
      return false;
    }
    (this.o.exit ?? process.exit)(0);
    return true;
  }

  /**
   * The new process starts now and builds its window while this one goes on; once it's ready this one saves the
   * screen, stops, lets go of the lock, and leaves when the new window shows. False: it ended before it was ready (an
   * older Harbor, which knows no handover, or a start that failed): the plain restart follows.
   */
  private async handOver(cmd: string[], env: Record<string, string | undefined>, file: string): Promise<boolean> {
    const { cfg } = this.o;
    rmSync(file, { force: true });
    try {
      Object.assign(env, await this.o.place?.());
    } catch {
      // Where the window goes is a nicety.
    }
    let ended = false;
    this.handingOver = true;
    try {
      const child = (this.o.spawn ?? spawnDetached)(cmd, { ...env, [HANDOVER]: file });
      void child?.exited.then(() => (ended = true));
    } catch (e) {
      this.handingOver = false;
      cfg.log(`reload: the handover didn't start (${e instanceof Error ? e.message : String(e)}): restarting the plain way`);
      return false;
    }
    const ready = await until(file, "ready", () => ended, READY_MS);
    if (ready === "ended") {
      this.handingOver = false;
      rmSync(file, { force: true });
      cfg.log("reload: the new process ended before it was ready: restarting the plain way");
      return false;
    }
    this.o.kv.set(STATE_KEY, JSON.stringify(this.o.snapshot()));
    this.o.leaving?.();
    try {
      await this.o.beforeExit?.();
    } finally {
      this.o.release?.();
    }
    // The window stays until the new one is on screen.
    await until(file, "shown", () => ended, SHOWN_MS);
    (this.o.exit ?? process.exit)(0);
    return true;
  }

  private failed(err: string): void {
    const dir = this.o.cfg.dir;
    const m = dir === null ? null : readMeta(dir);
    if (dir !== null && m !== null) fail(dir, m.id, err);
  }
}

type Stamp = string;

function stamp(p: string): Stamp | null {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
}

export function watchFiles(paths: string[], onChange: () => void, pollMs: number = WATCH_MS): () => void {
  const start = paths.map(stamp);
  let last = start;
  const timer = setInterval(() => {
    const now = paths.map(stamp);
    const changed = now.some((s, i) => s !== null && s !== start[i]);
    const settled = now.every((s, i) => s === last[i]);
    if (changed && settled) {
      clearInterval(timer);
      onChange();
      return;
    }
    last = now;
  }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}
