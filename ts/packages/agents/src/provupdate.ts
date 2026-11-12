import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { childPath, which } from "./providers.ts";

export const TOOLS = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" } as const;
export type Tool = keyof typeof TOOLS;
export type Method = "mise" | "native" | "npm" | "brew" | "other" | "missing";
export interface Install { tool: Tool; path: string; resolved: string; method: Method; manager: string; target: string }
export interface Status { tool: Tool; current: string; latest: string; method: Method; status: string; available: boolean; busy: boolean }
/** A CLI this PC moved to a newer version. */
export interface Done { tool: Tool; from: string; to: string }
export const NAMES: Record<Tool, string> = { claude: "Claude Code", codex: "Codex" };
/** "Claude Code updated to 2.1.322 on pc" or, for several at once, "Claude Code updated to 2.1.322 and Codex to 0.164.0 on pc". */
export function updatedText(done: readonly Done[], pc: string): string {
  const parts = done.map((d, i) => `${NAMES[d.tool]}${i === 0 ? " updated" : ""} to ${d.to}`);
  return `${parts.join(" and ")}${pc ? ` on ${pc}` : ""}`;
}
export interface Io {
  which(name: string): string | null;
  real(path: string): string;
  run(argv: string[]): Promise<string>;
  latest(tool: Tool): Promise<string>;
}
const version = (s: string) => s.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "";
export function newer(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
export const io: Io = {
  which,
  real: (p) => { try { return realpathSync(p); } catch { return p; } },
  async run(argv) {
    const p = Bun.spawn(argv, { cwd: homedir(), env: { ...process.env, PATH: childPath() }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 180_000);
    try {
      const [out, error, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error((error || out || `Command exited ${code}`).trim().slice(-600));
      return out.trim();
    } finally { clearTimeout(timer); }
  },
  async latest(tool) {
    const r = await fetch(`https://registry.npmjs.org/${TOOLS[tool]}/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Version check failed (${r.status})`);
    const v = await r.json() as { version?: unknown };
    if (typeof v.version !== "string" || !/^\d+\.\d+\.\d+$/.test(v.version)) throw new Error("Invalid registry version");
    return v.version;
  },
};

/** Inspect the executable Harbor actually launches, never install a second copy in a different prefix. */
export async function detect(tool: Tool, io: Io): Promise<Install> {
  const path = io.which(tool) ?? "";
  const resolved = path ? io.real(path) : "";
  const base: Install = { tool, path, resolved, method: path ? "other" : "missing", manager: "", target: "" };
  if (!path) return base;
  if (/\/mise\/(shims|installs)\//.test(path) || /\/mise\/installs\//.test(resolved)) {
    const manager = io.which("mise");
    if (!manager) return base;
    const active = await io.run([manager, "which", tool]);
    if (!io.real(active).includes(`/mise/installs/${tool}/`)) return base;
    return { ...base, resolved: io.real(active), method: "mise", manager, target: tool };
  }
  const brew = resolved.match(/^(.*?)\/(Cellar|Caskroom)\/([^/]+)\//);
  if (brew && [tool, "claude-code"].includes(brew[3]!)) {
    const manager = join(brew[1]!, "bin/brew");
    if (io.which("brew") && io.real(io.which("brew")!) === io.real(manager)) return { ...base, method: "brew", manager, target: brew[3]! };
    return base;
  }
  // Each one's own installer: releases side by side, a link swapped to the new one (`claude update`, `codex update`).
  if (tool === "claude" && /\/.local\/share\/claude\/versions\//.test(resolved)) return { ...base, method: "native", manager: path, target: "" };
  if (tool === "codex" && /\/.codex\/packages\/standalone\/releases\//.test(resolved)) return { ...base, method: "native", manager: path, target: "" };
  if (resolved.includes(`/node_modules/${TOOLS[tool]}/`)) {
    const manager = io.which("npm");
    if (manager) {
      const root = await io.run([manager, "root", "-g"]);
      if (resolved.startsWith(`${io.real(root)}/${TOOLS[tool]}/`)) return { ...base, method: "npm", manager, target: TOOLS[tool] };
    }
  }
  return base;
}
export function command(i: Install, latest: string): string[] | null {
  if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error("Invalid target version");
  switch (i.method) {
    case "mise": return [i.manager, "install", `${i.target}@${latest}`];
    case "native": return [i.path, "update"];
    case "npm": return [i.manager, "install", "--global", `${i.target}@${latest}`];
    case "brew": return [i.manager, "upgrade", i.target];
    default: return null;
  }
}

export class ProviderUpdates {
  private states = new Map<Tool, Status>();
  private checks = new Map<Tool, Promise<void>>();
  private requested = new Set<Tool>();
  private lastAttempt = new Map<Tool, number>();
  private jobs = new Map<Tool, Promise<void>>();
  /** Updates done since the last report: told together once nothing else is going to update. */
  private done: Done[] = [];
  constructor(private readonly io: Io, private readonly changed: () => void = () => {}, private readonly idle: (tool: Tool) => boolean = () => true, private readonly updated: (done: Done[]) => void = () => {}) {}
  /** The update of `tool` going on (any update for null), for a turn to wait for. */
  pending(tool: Tool | null = null): Promise<void> | null {
    const jobs = tool === null ? [...this.jobs.values()] : this.jobs.has(tool) ? [this.jobs.get(tool)!] : [];
    return jobs.length ? Promise.all(jobs).then(() => {}) : null;
  }
  list(): Status[] { return (Object.keys(TOOLS) as Tool[]).map((tool) => this.states.get(tool) ?? { tool, current: "", latest: "", method: "missing", status: "Not checked", available: false, busy: false }); }
  private put(tool: Tool, s: Partial<Status>) {
    this.states.set(tool, { ...this.list().find((x) => x.tool === tool)!, ...s });
    this.changed();
  }
  check(tool: Tool): Promise<void> {
    if (this.jobs.has(tool)) return this.jobs.get(tool)!;
    if (this.checks.has(tool)) return this.checks.get(tool)!;
    const p = this.inspect(tool).finally(() => this.checks.delete(tool));
    this.checks.set(tool, p);
    return p;
  }
  private async inspect(tool: Tool) {
    this.put(tool, { busy: true, status: "Checking…" });
    try {
      const i = await detect(tool, this.io);
      const current = i.path ? version(await this.io.run([i.path, "--version"])) : "";
      this.put(tool, { current, method: i.method });
      const latest = await this.io.latest(tool);
      const available = current !== "" && newer(latest, current);
      this.put(tool, { current, latest, method: i.method, available, status: !i.path ? "Not installed" : !current ? "Could not read CLI version" : i.method === "other" ? "Update using the installer that owns this CLI, then Check again." : available ? `Version ${latest} available` : "Up to date" });
    } catch (e) { this.put(tool, { status: String(e), available: false }); }
    finally { this.put(tool, { busy: false }); }
  }
  tick(): void {
    if (this.jobs.size || !autoUpdates()) return;
    for (const s of this.list()) {
      if (s.busy || !this.idle(s.tool) || (!this.requested.has(s.tool) && !(s.available && s.method !== "other"))) continue;
      if (Date.now() - (this.lastAttempt.get(s.tool) ?? 0) < 6 * 3600_000) continue;
      void this.update(s.tool);
      return;
    }
    if (this.done.length && !this.list().some((s) => s.busy)) this.updated(this.done.splice(0));
  }
  update(tool: Tool): Promise<void> {
    if (this.jobs.has(tool)) return this.jobs.get(tool)!;
    const job = this.install(tool).finally(() => this.jobs.delete(tool));
    this.jobs.set(tool, job);
    return job;
  }
  private async install(tool: Tool) {
    await this.checks.get(tool);
    // Package managers can remove files that a running CLI loads later. Don't touch one during its turns.
    if (!this.idle(tool)) { this.requested.add(tool); this.put(tool, { status: "Update queued until this CLI's turns finish on this PC." }); return; }
    this.requested.delete(tool);
    this.lastAttempt.set(tool, Date.now());
    this.put(tool, { busy: true, status: "Updating…" });
    try {
      const i = await detect(tool, this.io);
      const latest = await this.io.latest(tool);
      const argv = command(i, latest);
      if (!argv) throw new Error("Use the installer that owns this CLI to update it; Harbor could not identify a supported install method.");
      const current = version(await this.io.run([i.path, "--version"]));
      if (!current) throw new Error("Could not read the installed version; no changes made.");
      if (newer(latest, current)) await this.io.run(argv);
      await this.inspect(tool);
      const state = this.list().find((s) => s.tool === tool)!;
      if (state.current && newer(state.current, current)) {
        console.log(`provider update (${tool}): ${current} -> ${state.current}`);
        this.done = [...this.done.filter((d) => d.tool !== tool), { tool, from: current, to: state.current }];
      }
      if (state.current !== latest && newer(latest, state.current)) {
        const status = `Installer did not activate ${latest}. Its registry may be behind or the configured version is pinned.`;
        this.put(tool, { status });
        console.warn(`provider update (${tool}): ${status}`);
      }
    } catch (e) { this.put(tool, { status: String(e) }); console.warn(`provider update (${tool}): ${String(e)}`); }
    finally { this.put(tool, { busy: false }); }
  }
}

/**
 * Whether the CLIs are updated by themselves: not in an offline run or a test session on someone's PC
 * (HARBOR_OFFLINE, HARBOR_NO_PROVIDER_UPDATES), where Harbor must leave their installs as they are.
 */
export function autoUpdates(env: Record<string, string | undefined> = process.env): boolean {
  return !env.HARBOR_OFFLINE && !env.HARBOR_NO_PROVIDER_UPDATES;
}

export let providerUpdates = new ProviderUpdates(io);
export function configureUpdates(changed: () => void, idle: (tool: Tool) => boolean, updated: (done: Done[]) => void): ProviderUpdates {
  providerUpdates = new ProviderUpdates(io, changed, idle, updated);
  return providerUpdates;
}
