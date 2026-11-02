import { join } from "node:path";
import type { UpdateConfig } from "./config.ts";
import { alive, readJson, remove, writeAtomic } from "./files.ts";
import { dirOf, hasPrevious, rollback } from "./install.ts";
import { fail, readMeta, writeMeta } from "./previewmeta.ts";
import { keepFailedLog } from "./startlog.ts";

export const ATTEMPT = "starting.json";
export const START_LIMIT_MS = 30_000;
export const SETTLE_MS = 2_000;
const LOOK_MS = 200;

export interface Attempt {
  version: string;
  pid: number;
  at: number;
  stage: "trying" | "ok";
  kind: "release" | "preview";
  args: string[];
  id: string;
}

export function readAttempt(dir: string): Attempt | null {
  const a = readJson<Partial<Attempt>>(join(dir, ATTEMPT));
  if (a === null || typeof a.pid !== "number" || (a.stage !== "trying" && a.stage !== "ok")) return null;
  return {
    version: a.version ?? "",
    pid: a.pid,
    at: a.at ?? 0,
    stage: a.stage,
    kind: a.kind === "preview" ? "preview" : "release",
    args: Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === "string") : [],
    id: a.id ?? "",
  };
}

export function beginAttempt(cfg: UpdateConfig, a: Omit<Attempt, "at" | "stage">): void {
  writeAtomic(join(dirOf(cfg), ATTEMPT), JSON.stringify({ ...a, at: cfg.now(), stage: "trying" } satisfies Attempt));
}

export async function confirmStart(cfg: UpdateConfig, settleMs: number = SETTLE_MS): Promise<boolean> {
  if (cfg.dir === null) return false;
  const dir = cfg.dir;
  const mine = (): Attempt | null => {
    const a = readAttempt(dir);
    return a !== null && a.pid === process.pid && a.stage === "trying" ? a : null;
  };
  const first = mine();
  if (first === null) return false;
  if (first.kind === "preview") {
    const m = readMeta(dir);
    if (m !== null && m.id === first.id) writeMeta(dir, { ...m, shown_ms: cfg.now() });
  }
  await cfg.sleep(settleMs);
  const a = mine();
  if (a === null) return false;
  writeAtomic(join(dir, ATTEMPT), JSON.stringify({ ...a, stage: "ok" } satisfies Attempt));
  if (a.kind === "preview") {
    const m = readMeta(dir);
    if (m !== null && m.id === a.id && m.stage === "trying") writeMeta(dir, { ...m, stage: "ok" });
  }
  return true;
}

export function failedStart(cfg: UpdateConfig, a: Attempt, why: string): "rolled-back" | "preview-failed" | "nothing-to-fall-back-to" {
  const dir = dirOf(cfg);
  remove(join(dir, ATTEMPT));
  const log = keepFailedLog(dir);
  if (a.kind === "preview") {
    fail(dir, a.id, why);
    return "preview-failed";
  }
  if (!hasPrevious(cfg)) {
    cfg.log(`${a.version} failed to start (${why}) and there is no earlier version to go back to${log === undefined ? "" : `; its errors are in ${log}`}`);
    return "nothing-to-fall-back-to";
  }
  rollback(cfg, why, log);
  return "rolled-back";
}

// The watchdog may have died with the process (a systemd unit), so a start nobody confirmed counts as failed.
export function recoverUnconfirmed(cfg: UpdateConfig): ReturnType<typeof failedStart> | null {
  if (cfg.dir === null) return null;
  const a = readAttempt(cfg.dir);
  if (a === null || a.stage !== "trying" || a.pid === process.pid) return null;
  if (alive(a.pid) && cfg.now() - a.at < START_LIMIT_MS * 2) return null;
  return failedStart(cfg, a, "it never finished starting");
}

export interface WatchDeps {
  relaunch: (args: string[]) => void;
  kill: (pid: number) => void;
}

export async function watch(cfg: UpdateConfig, pid: number, deps: WatchDeps): Promise<number> {
  const dir = dirOf(cfg);
  const began = cfg.now();
  let why: string;
  for (;;) {
    await cfg.sleep(LOOK_MS);
    const a = readAttempt(dir);
    if (a === null || a.pid !== pid || a.stage !== "trying") return 0;
    if (!alive(pid)) {
      why = "it exited while starting";
      break;
    }
    if (cfg.now() - began > START_LIMIT_MS) {
      deps.kill(pid);
      for (let i = 0; i < 100 && alive(pid); i++) await cfg.sleep(50);
      why = "it showed no frame in time";
      break;
    }
  }
  const a = readAttempt(dir);
  if (a === null || a.pid !== pid) return 0;
  // Started again with nothing to go back to, it would fail the same way, and arm another watchdog.
  if (failedStart(cfg, a, why) !== "nothing-to-fall-back-to") deps.relaunch(a.args);
  return 0;
}
