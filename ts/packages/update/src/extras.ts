import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateConfig } from "./config.ts";
import { fetchSigned } from "./download.ts";
import { ensureDir, exists, fresh, isFile, read, remove, replace } from "./files.ts";
import type { Manifest } from "./manifest.ts";

export const VIDEO_LIB = "libmpv-harbor.so";
export const APK = "harbor-android.apk";
export const APK_VERSION = "harbor-android.version";

const RETRY_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 6 * 3600 * 1000;

export function retryAfter(n: number): number {
  return Math.min(RETRY_MS * 2 ** Math.min(Math.max(n - 1, 0), 10), RETRY_MAX_MS);
}

/** What Harbor's built-in browser left in the install folder (it was removed after 0.176): its Servo
 * engine, the engine's id, the --no-browser mark and a half-done download; the copy kept for a rollback too. */
const BROWSER_LEFTOVERS = ["harbor-browser", "browser.installed", "browser.id", ".no-browser", ".staging-browser"];

/** Removes the browser's leftovers from `dir` (and `prev`, the rolled-back-to copy); true when something was there. */
export function dropBrowser(dir: string, prev?: string): boolean {
  let found = false;
  for (const d of prev === undefined ? [dir] : [dir, prev]) {
    for (const f of BROWSER_LEFTOVERS) {
      const p = join(d, f);
      if (!exists(p)) continue;
      found = true;
      remove(p);
    }
  }
  return found;
}

export function videoStale(dir: string, id: string): boolean {
  return !isFile(join(dir, VIDEO_LIB)) || (id !== "" && read(join(dir, "video.installed")) !== id);
}

async function unpack(cfg: UpdateConfig, release: string, name: string, stage: string): Promise<string> {
  const file = await fetchSigned(cfg, release, `${name}.tar.gz`, stage);
  const p = Bun.spawn(["tar", "-xzf", file, "-C", stage], { stdout: "ignore", stderr: "ignore" });
  if ((await p.exited) !== 0) throw new Error(`${name}: could not unpack`);
  return join(stage, name);
}

export async function fetchVideo(cfg: UpdateConfig, release: string, id: string, dir: string, stage: string): Promise<void> {
  const from = await unpack(cfg, release, `harbor-video-${cfg.arch}-linux`, stage);
  if (!isFile(join(from, VIDEO_LIB))) throw new Error("the archive has no player");
  replace(join(from, VIDEO_LIB), join(dir, VIDEO_LIB));
  writeFileSync(join(dir, "video.installed"), id);
  remove(join(dir, "video-licenses"));
  try {
    renameSync(join(from, "licenses"), join(dir, "video-licenses"));
  } catch {
  }
}

export async function fetchApk(cfg: UpdateConfig, release: string, code: number, dir: string, stage: string): Promise<void> {
  const file = await fetchSigned(cfg, release, APK, stage);
  const v = join(stage, APK_VERSION);
  writeFileSync(v, String(code));
  replace(file, join(dir, APK));
  replace(v, join(dir, APK_VERSION));
}

export function apk(dir: string): { path: string; code: number } | null {
  const path = join(dir, APK);
  if (!isFile(path)) return null;
  const code = Number.parseInt(read(join(dir, APK_VERSION)), 10);
  return { path, code: Number.isFinite(code) ? code : 0 };
}

export function putApk(dir: string, bytes: Uint8Array, code: number): void {
  ensureDir(dir);
  const f = join(dir, `.${APK}.new`);
  const v = join(dir, `.${APK_VERSION}.new`);
  writeFileSync(f, bytes);
  writeFileSync(v, String(code));
  replace(f, join(dir, APK));
  replace(v, join(dir, APK_VERSION));
}

export interface ExtraWork {
  name: "video" | "apk";
  run: () => Promise<void>;
}

export function pendingExtras(cfg: UpdateConfig, dir: string, m: Manifest): ExtraWork[] {
  const work: ExtraWork[] = [];
  const stage = (n: string): string => fresh(join(dir, `.staging-${n}`));
  const staged = (n: string, job: (s: string) => Promise<void>) => async (): Promise<void> => {
    const s = stage(n);
    try {
      await job(s);
    } finally {
      remove(s);
    }
  };
  const { video, apk: phone } = m;
  if (video !== undefined && videoStale(dir, video.id)) work.push({ name: "video", run: staged("video", (s) => fetchVideo(cfg, video.release, video.id, dir, s)) });
  if (phone !== undefined && (apk(dir)?.code ?? -1) < phone.code) work.push({ name: "apk", run: staged("apk", (s) => fetchApk(cfg, phone.release, phone.code, dir, s)) });
  return work;
}
