import { statSync } from "node:fs";
import type { UpdateConfig } from "./config.ts";
import { isFile } from "./files.ts";
import { fail, readMeta } from "./previewmeta.ts";

export const STATE_KEY = "reload_state";
export const RELOADED_PID = "HARBOR_RELOADED_PID";
export const BACKGROUND_FLAG = "--background";
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
  beforeExit?: () => void;
  release?: () => void;
  spawn?: (cmd: string[], env: Record<string, string | undefined>) => void;
  exit?: (code: number) => void;
}

function spawnDetached(cmd: string[], env: Record<string, string | undefined>): void {
  const p = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  p.unref();
}

export class Reloader {
  private going = false;

  constructor(private readonly o: ReloaderOptions) {}

  async now(): Promise<boolean> {
    if (this.going) return true;
    const { cfg } = this.o;
    if (!isFile(cfg.exe)) {
      cfg.log(`reload failed: ${cfg.exe} is gone`);
      return false;
    }
    this.going = true;
    this.o.kv.set(STATE_KEY, JSON.stringify(this.o.snapshot()));
    const args = this.o.args().filter((a) => a !== BACKGROUND_FLAG);
    if (this.o.hidden()) args.push(BACKGROUND_FLAG);
    const env: Record<string, string | undefined> = { ...process.env, [RELOADED_PID]: String(process.pid) };
    for (const k of DEV_HOOKS) delete env[k];
    try {
      this.o.beforeExit?.();
      (this.o.spawn ?? spawnDetached)([cfg.exe, ...args], env);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      cfg.log(`reload failed: ${err}`);
      this.failed(err);
      this.going = false;
      return false;
    }
    this.o.release?.();
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
