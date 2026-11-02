import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateConfig } from "./config.ts";
import { fetchSigned } from "./download.ts";
import { ensureDir, exists, fresh, isFile, read, remove, replace } from "./files.ts";
import type { Manifest } from "./manifest.ts";

export const NO_BROWSER = ".no-browser";
export const VIDEO_LIB = "libmpv-harbor.so";
export const APK = "harbor-android.apk";
export const APK_VERSION = "harbor-android.version";
export const BROWSER_GLIBC: readonly [number, number] = [2, 39];

const RETRY_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 6 * 3600 * 1000;

export function retryAfter(n: number): number {
  return Math.min(RETRY_MS * 2 ** Math.min(Math.max(n - 1, 0), 10), RETRY_MAX_MS);
}

// Servo is built on Ubuntu 24.04.
export function browserUnsupported(cfg: UpdateConfig): string | null {
  const g = cfg.glibc();
  if (g === null) return "The browser engine (Servo) needs a glibc-based system (glibc 2.39 or newer).";
  if (g[0] > BROWSER_GLIBC[0] || (g[0] === BROWSER_GLIBC[0] && g[1] >= BROWSER_GLIBC[1])) return null;
  return `The browser engine (Servo) needs glibc 2.39 or newer; this system has ${g[0]}.${g[1]}.`;
}

export function engineStale(cfg: UpdateConfig, dir: string, id: string): boolean {
  if (exists(join(dir, NO_BROWSER)) || browserUnsupported(cfg) !== null) return false;
  if (!isFile(join(dir, "harbor-browser"))) return true;
  const installed = read(join(dir, "browser.installed"));
  return installed !== "" && id !== "" && installed !== id;
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

export async function fetchBrowser(cfg: UpdateConfig, release: string, id: string, dir: string, stage: string, prev?: string): Promise<void> {
  const from = await unpack(cfg, release, `harbor-browser-${cfg.arch}-linux`, stage);
  replace(join(from, "harbor-browser"), join(dir, "harbor-browser"), prev);
  writeFileSync(join(dir, "browser.installed"), id);
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
  name: "browser" | "video" | "apk";
  run: () => Promise<void>;
}

export function pendingExtras(cfg: UpdateConfig, dir: string, m: Manifest, prev?: string): ExtraWork[] {
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
  const { browser, video, apk: phone } = m;
  if (browser !== undefined && engineStale(cfg, dir, browser.id)) work.push({ name: "browser", run: staged("browser", (s) => fetchBrowser(cfg, browser.release, browser.id, dir, s, prev)) });
  if (video !== undefined && videoStale(dir, video.id)) work.push({ name: "video", run: staged("video", (s) => fetchVideo(cfg, video.release, video.id, dir, s)) });
  if (phone !== undefined && (apk(dir)?.code ?? -1) < phone.code) work.push({ name: "apk", run: staged("apk", (s) => fetchApk(cfg, phone.release, phone.code, dir, s)) });
  return work;
}
