import { dlopen, FFIType } from "bun:ffi";
import { PUBKEY, parsePublicKey, type PublicKey } from "./minisign.ts";
import { installDir } from "./files.ts";
import { parseGlibc, RUNTIME_VERSION, VERSION } from "./version.ts";

export type Arch = "x86_64" | "aarch64";

export const REPO = "RDevNeo/harbor";
export const GITHUB = "https://github.com";
export const WORKER = "https://harbor-accounts.rdevneo.workers.dev";

export interface RuntimeInfo {
  version: string;
  bundle: string;
  preview: boolean;
  exe: string;
}

// Set by the launcher before it imports the bundle, which is a separate copy of this code.
declare global {
  var __harbor: { runtime?: RuntimeInfo } | undefined;
}

export function runtimeInfo(): RuntimeInfo | undefined {
  return globalThis.__harbor?.runtime;
}

export interface UpdateConfig {
  dir: string | null;
  version: string;
  runtime: string;
  preview: boolean;
  arch: Arch;
  repo: string;
  github: string;
  worker: string | null;
  pubkey: string;
  fetch: typeof fetch;
  log: (msg: string) => void;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  exe: string;
  /** A run from source (`bun harbor.ts`): the entry script `exe` (bun) runs. */
  script?: string;
  glibc: () => readonly [number, number] | null;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export function currentArch(): Arch {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

export function defaultConfig(env: Record<string, string | undefined> = process.env): UpdateConfig {
  const rt = runtimeInfo();
  const exe = rt?.exe ?? process.execPath;
  return {
    dir: installDir(exe),
    version: VERSION,
    runtime: rt?.version ?? RUNTIME_VERSION,
    preview: rt?.preview ?? false,
    arch: currentArch(),
    repo: REPO,
    github: GITHUB,
    worker: env.HARBOR_UPDATE_WORKER === "off" ? null : (env.HARBOR_UPDATE_WORKER ?? WORKER),
    pubkey: PUBKEY,
    fetch: globalThis.fetch,
    log: (m) => console.error(`harbor: ${m}`),
    now: Date.now,
    sleep,
    random: Math.random,
    exe,
    ...(rt ? {} : { script: Bun.main }),
    glibc: hostGlibc,
  };
}

function hostGlibc(): readonly [number, number] | null {
  try {
    const lib = dlopen("libc.so.6", { gnu_get_libc_version: { args: [], returns: FFIType.cstring } });
    return parseGlibc(String(lib.symbols.gnu_get_libc_version()));
  } catch {
    return null;
  }
}

const keys = new Map<string, Promise<PublicKey>>();

export function publicKey(cfg: UpdateConfig): Promise<PublicKey> {
  let k = keys.get(cfg.pubkey);
  if (k === undefined) {
    k = parsePublicKey(cfg.pubkey);
    keys.set(cfg.pubkey, k);
  }
  return k;
}

export function assetUrl(cfg: UpdateConfig, release: string, name: string): string {
  return `${cfg.github}/${cfg.repo}/releases/download/v${release}/${name}`;
}
