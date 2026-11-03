declare const HARBOR_VERSION: string | undefined;
declare const HARBOR_RUNTIME_VERSION: string | undefined;
declare const HARBOR_GIT_SHA: string | undefined;

export const DEV_VERSION = "0.0.0-dev";

export const VERSION: string = typeof HARBOR_VERSION === "string" ? HARBOR_VERSION : DEV_VERSION;

export const RUNTIME_VERSION: string = typeof HARBOR_RUNTIME_VERSION === "string" ? HARBOR_RUNTIME_VERSION : DEV_VERSION;

export const GIT_SHA: string | null = typeof HARBOR_GIT_SHA === "string" && HARBOR_GIT_SHA.length >= 7 ? HARBOR_GIT_SHA.slice(0, 7) : null;

/** The whole commit this build (the app bundle, or the single executable) was made from, for files fetched from the repository at that commit. */
export const GIT_COMMIT: string | null = typeof HARBOR_GIT_SHA === "string" && /^[0-9a-f]{7,40}$/.test(HARBOR_GIT_SHA) ? HARBOR_GIT_SHA : null;

/**
 * The repository ref whose `discord/` goes with this build: its commit, else its own release tag.
 * Never the runtime's version: an installed runtime only updates when it changes, and it advertises
 * the Rust parity version besides. Undefined for a build from source (rigs set HARBOR_DISCORD_SHELL).
 */
export function repoRef(commit: string | null = GIT_COMMIT, version: string = VERSION): string | undefined {
  if (commit !== null) return commit;
  return /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : undefined;
}

export type Parsed = readonly [major: number, minor: number, patch: number, release: boolean];

export function parse(v: string): Parsed | null {
  const t = v.trim().replace(/^v/, "");
  const dash = t.indexOf("-");
  const core = dash < 0 ? t : t.slice(0, dash);
  const parts = core.split(".");
  const num = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);
  const major = num(parts[0]);
  const minor = num(parts[1]);
  if (major === null || minor === null) return null;
  return [major, minor, num(parts[2]) ?? 0, dash < 0];
}

export function compare(a: string, b: string): number | null {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return Number(pa[3]) - Number(pb[3]);
}

export function newer(candidate: string, current: string): boolean {
  const c = compare(candidate, current);
  return c !== null && c > 0;
}

// The Rust release whose behaviour this app matches. Rust PCs and phones read only the first three numbers.
export const RUST_PARITY = "0.109.0";

export function advertised(v: string): string {
  return newer(v, RUST_PARITY) ? `${RUST_PARITY}.ts` : v;
}

export function versionCode(v: string): number {
  const p = parse(v);
  return p === null ? 0 : p[0] * 1_000_000 + p[1] * 1000 + p[2];
}

export function tagged(url: string): string {
  const at = url.trim().lastIndexOf("/tag/");
  if (at < 0) throw new Error("no release published yet");
  const tag = url.trim().slice(at + 5);
  if (parse(tag) === null) throw new Error(`unexpected release tag ${tag}`);
  return tag.replace(/^v/, "");
}

export function parseGlibc(v: string): readonly [number, number] | null {
  const parts = v.trim().split(".");
  const a = parts[0] !== undefined && /^\d+$/.test(parts[0]) ? Number(parts[0]) : null;
  const b = parts[1] !== undefined && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  return a === null || b === null ? null : [a, b];
}
