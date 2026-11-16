import { join } from "node:path";
import type { UpdateConfig } from "./config.ts";
import { remove } from "./files.ts";
import { ATTEMPT, readAttempt } from "./startup.ts";

/**
 * This process leaves its start to another one (Windows' Run as administrator hands it to a scheduled task): its
 * attempt goes, so the watchdog doesn't take its leaving for a failed start and roll the update back. (Not in
 * startup.ts: that file is part of the runtime, and this only the app's.)
 */
export function abandonStart(cfg: UpdateConfig, pid: number = process.pid): void {
  if (cfg.dir === null) return;
  if (readAttempt(cfg.dir)?.pid === pid) remove(join(cfg.dir, ATTEMPT));
}
