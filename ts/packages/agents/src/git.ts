import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { home } from "./paths.ts";

export interface Status {
  branch: string;
  changed: number;
  ahead: number;
  behind: number;
  /** origin's web address. */
  remote: string | null;
  /** origin's URL as configured. */
  origin: string | null;
}

/** How long a git query may take before it's killed (a hung mount, a held lock). */
export const GIT_TIMEOUT_MS = 10_000;

export interface Output {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class TimedOut extends Error {}

export async function outputWithin(argv: string[], limitMs: number, opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<Output> {
  const p = Bun.spawn(argv, { cwd: opts.cwd ?? process.cwd(), env: opts.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, limitMs);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(timer);
  if (timedOut) throw new TimedOut(`timed out after ${Math.floor(limitMs / 1000)}s`);
  return { code: p.exitCode, stdout, stderr };
}

/** No optional locks (a status never holds index.lock) and no fsmonitor (a repo's own config could name any command). */
export async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const out = await outputWithin(["git", "-c", "core.fsmonitor=false", "-C", dir, ...args], GIT_TIMEOUT_MS, { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return out.code === 0 ? out.stdout.trim() : null;
  } catch {
    return null;
  }
}

export async function status(dir: string): Promise<Status | null> {
  const porcelain = await git(dir, ["status", "--porcelain=v2", "--branch"]);
  if (porcelain === null) return null;
  const s: Status = { branch: "", changed: 0, ahead: 0, behind: 0, remote: null, origin: null };
  for (const l of porcelain.split("\n")) {
    if (l === "") continue;
    if (l.startsWith("# branch.head ")) s.branch = l.slice(14);
    else if (l.startsWith("# branch.ab ")) {
      const [a, b] = l.slice(12).trim().split(/\s+/);
      s.ahead = count(a?.replace(/^\++/, ""));
      s.behind = count(b?.replace(/^-+/, ""));
    } else if (!l.startsWith("#")) s.changed++;
  }
  s.origin = await origin(dir);
  s.remote = s.origin === null ? null : webUrl(s.origin);
  return s;
}

function count(v: string | undefined): number {
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : 0;
}

export async function origin(dir: string): Promise<string | null> {
  const u = await git(dir, ["remote", "get-url", "origin"]);
  return u === null || u === "" ? null : u;
}

/** git@github.com:a/b.git and https://github.com/a/b.git both become https://github.com/a/b */
export function webUrl(url: string): string {
  let u = url.trim();
  while (u.endsWith(".git")) u = u.slice(0, -4);
  if (u.startsWith("ssh://")) {
    let rest = u.slice(6);
    const at = rest.indexOf("@");
    if (at >= 0) rest = rest.slice(at + 1);
    const slash = rest.indexOf("/");
    if (slash >= 0) return `https://${rest.slice(0, slash).split(":")[0]}/${rest.slice(slash + 1)}`;
  }
  if (u.startsWith("git@")) {
    const rest = u.slice(4);
    const c = rest.indexOf(":");
    if (c >= 0) return `https://${rest.slice(0, c)}/${rest.slice(c + 1)}`;
  }
  return u;
}

/** Finds git repositories up to two levels under the usual project folders. */
export function discover(): string[] {
  const found: string[] = [];
  for (const r of ["Projects", "projects", "work", "Work", "code", "src", "dev", "Documents"]) scan(join(home(), r), 0, found);
  return [...new Set(found)].sort();
}

function scan(dir: string, depth: number, out: string[]): void {
  if (existsSync(join(dir, ".git"))) {
    out.push(dir);
    return;
  }
  if (depth >= 2) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "target") continue;
    if (e.isDirectory()) scan(join(dir, e.name), depth + 1, out);
  }
}

export function openUrl(url: string): void {
  try {
    Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // no xdg-open: the link just doesn't open
  }
}
