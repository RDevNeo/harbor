import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateConfig } from "./config.ts";
import { DownloadError, fetchSigned } from "./download.ts";
import { pendingExtras } from "./extras.ts";
import { BUNDLE_FILE, fresh, isFile, read, remove, replace, RUNTIME_FILE, sweepAside, writeAtomic } from "./files.ts";
import { MANIFEST, parseManifest, type Manifest } from "./manifest.ts";
import { newer } from "./version.ts";
import { platform } from "@harbor/os";

export const PREVIOUS = ".previous";
export const SKIP = ".skip";
/**
 * How long a new runtime or bundle may take to answer. Windows checks a new 170 MB harbor.exe before its first
 * start (measured 17-21 s, most of it Defender): that start happens here, in the background, so the person's next
 * start of the same file (renamed into place, already checked) is quick.
 */
const SMOKE_MS = platform() === "win32" ? 180_000 : 10_000;

export function dirOf(cfg: UpdateConfig): string {
  if (cfg.dir === null) throw new Error("not an installed copy");
  return cfg.dir;
}

export function onDisk(cfg: UpdateConfig): string | null {
  if (cfg.dir === null) return null;
  const v = read(join(cfg.dir, "VERSION"));
  return v !== "" && v !== cfg.version ? v : null;
}

export function current(cfg: UpdateConfig): string {
  return cfg.preview ? (onDisk(cfg) ?? cfg.version) : cfg.version;
}

export function runtimeOnDisk(cfg: UpdateConfig): string {
  return (cfg.dir === null ? "" : read(join(cfg.dir, "RUNTIME"))) || cfg.runtime;
}

export function hasPrevious(cfg: UpdateConfig): boolean {
  return cfg.dir !== null && (isFile(join(cfg.dir, PREVIOUS, BUNDLE_FILE)) || isFile(join(cfg.dir, PREVIOUS, RUNTIME_FILE)));
}

export function skipped(cfg: UpdateConfig, version: string): boolean {
  return cfg.dir !== null && read(join(cfg.dir, SKIP)) === version;
}

export async function runSmoke(exe: string, args: string[]): Promise<string> {
  const p = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), SMOKE_MS);
  try {
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error("it doesn't run here");
    return out.trim();
  } catch (e) {
    throw new Error(e instanceof Error && e.message === "it doesn't run here" ? e.message : "it doesn't answer");
  } finally {
    clearTimeout(timer);
  }
}

export async function smokeRuntime(exe: string, expected: string): Promise<void> {
  const said = await runSmoke(exe, ["runtime-version"]).catch((e: Error) => {
    throw new Error(`the new runtime ${e.message}`);
  });
  if (said !== expected) throw new Error(`the runtime says it is ${said || "nothing"}, not ${expected}`);
}

export async function smokeBundle(runtime: string, bundle: string, expected: string): Promise<void> {
  const said = await runSmoke(runtime, ["smoke-bundle", bundle]).catch((e: Error) => {
    throw new Error(`the new bundle ${e.message}`);
  });
  if (said !== `harbor ${expected}`) throw new Error(`the bundle says ${said || "nothing"}, not harbor ${expected}`);
}

// A release of the Rust app only: nothing in it runs here.
export class NoBuild extends Error {
  constructor(readonly version: string) {
    super(`Harbor ${version} has no build of this app`);
  }
}

async function fetchManifest(cfg: UpdateConfig, version: string, stage: string): Promise<Manifest> {
  const file = await fetchSigned(cfg, version, MANIFEST, stage).catch((e: unknown) => {
    throw e instanceof DownloadError && e.status === 404 ? new NoBuild(version) : e;
  });
  const m = parseManifest(await Bun.file(file).text());
  if (m.version !== version) throw new Error("the manifest is for another version");
  return m;
}

export interface Installed {
  version: string;
  runtimeUpdated: boolean;
  manifest: Manifest;
}

// Runtime first, bundle last: whoever watches the bundle file sees one change.
/**
 * The release's runtime for this system: `harbor-runtime-<arch>` on Linux, `harbor-runtime-<arch>-macos` on
 * macOS, `harbor-runtime-<arch>-windows.exe` on Windows.
 */
export function runtimeAsset(cfg: Pick<UpdateConfig, "arch" | "os">): string {
  if (cfg.os === "macos") return `harbor-runtime-${cfg.arch}-macos`;
  if (cfg.os === "windows") return `harbor-runtime-${cfg.arch}-windows.exe`;
  return `harbor-runtime-${cfg.arch}`;
}

export async function install(cfg: UpdateConfig, version: string): Promise<Installed> {
  const dir = dirOf(cfg);
  sweepAside(dir);
  const stage = fresh(join(dir, ".staging"));
  try {
    const manifest = await fetchManifest(cfg, version, stage);
    let runtimeStaged: string | null = null;
    const have = runtimeOnDisk(cfg);
    if (newer(manifest.minRuntime, have)) {
      if (newer(manifest.minRuntime, manifest.runtime)) throw new Error(`the bundle needs runtime ${manifest.minRuntime} but the release names ${manifest.runtime}`);
      runtimeStaged = await fetchSigned(cfg, manifest.runtime, runtimeAsset(cfg), stage);
      chmodSync(runtimeStaged, 0o755);
      await smokeRuntime(runtimeStaged, manifest.runtime);
    }
    const bundle = await fetchSigned(cfg, version, BUNDLE_FILE, stage);
    await smokeBundle(runtimeStaged ?? join(dir, RUNTIME_FILE), bundle, version);

    const prev = fresh(join(dir, PREVIOUS));
    writeFileSync(join(prev, "VERSION"), current(cfg));
    writeFileSync(join(prev, "RUNTIME"), runtimeOnDisk(cfg));
    if (isFile(join(dir, "manifest.json"))) copyFileSync(join(dir, "manifest.json"), join(prev, "manifest.json"));
    // The extras first: they can take minutes, and nothing that runs Harbor itself has changed yet.
    for (const job of pendingExtras(cfg, dir, manifest)) {
      await job.run().catch((e: Error) => cfg.log(`${job.name} not updated: ${e.message}`));
    }
    // Then runtime and bundle back to back, and VERSION last: a running Harbor reloads when VERSION
    // changes (run.ts), so it never starts a new runtime beside the old bundle or the other way round.
    if (runtimeStaged !== null) {
      replace(runtimeStaged, join(dir, RUNTIME_FILE), prev);
      writeAtomic(join(dir, "RUNTIME"), manifest.runtime);
    }
    replace(bundle, join(dir, BUNDLE_FILE), prev);
    writeAtomic(join(dir, "manifest.json"), JSON.stringify(manifest));
    remove(join(dir, SKIP));
    writeAtomic(join(dir, "VERSION"), version);
    return { version, runtimeUpdated: runtimeStaged !== null, manifest };
  } finally {
    remove(stage);
  }
}

export function rollback(cfg: UpdateConfig, why?: string, log?: string): { restored: string; gaveUp: string } {
  const dir = dirOf(cfg);
  const prev = join(dir, PREVIOUS);
  if (!hasPrevious(cfg)) throw new Error("no previous version kept");
  const restored = read(join(prev, "VERSION"));
  const gaveUp = read(join(dir, "VERSION")) || cfg.version;
  writeFileSync(join(dir, SKIP), gaveUp);
  if (isFile(join(prev, RUNTIME_FILE))) {
    replace(join(prev, RUNTIME_FILE), join(dir, RUNTIME_FILE));
    const rt = read(join(prev, "RUNTIME"));
    if (rt === "") remove(join(dir, "RUNTIME"));
    else writeAtomic(join(dir, "RUNTIME"), rt);
  }
  if (isFile(join(prev, "manifest.json"))) replace(join(prev, "manifest.json"), join(dir, "manifest.json"));
  else remove(join(dir, "manifest.json"));
  if (restored !== "") writeAtomic(join(dir, "VERSION"), restored);
  if (isFile(join(prev, BUNDLE_FILE))) replace(join(prev, BUNDLE_FILE), join(dir, BUNDLE_FILE));
  remove(prev);
  if (why !== undefined) writeAtomic(join(dir, "rolled-back.json"), JSON.stringify({ version: gaveUp, restored, why, at: Math.floor(cfg.now() / 1000), ...(log === undefined ? {} : { log }) }));
  return { restored, gaveUp };
}

export interface RolledBack {
  version: string;
  restored: string;
  why: string;
  at: number;
  /** The failed start's stderr. */
  log?: string;
}

export function rolledBack(cfg: UpdateConfig): RolledBack | null {
  if (cfg.dir === null) return null;
  try {
    const v = JSON.parse(read(join(cfg.dir, "rolled-back.json"))) as Partial<RolledBack>;
    return typeof v.version === "string" && typeof v.why === "string" ? { version: v.version, restored: v.restored ?? "", why: v.why, at: v.at ?? 0, ...(typeof v.log === "string" ? { log: v.log } : {}) } : null;
  } catch {
    return null;
  }
}
