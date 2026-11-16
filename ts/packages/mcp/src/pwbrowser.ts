// The browser for Harbor's built-in Playwright MCP server when the PC has neither Google Chrome nor Microsoft Edge
// (@harbor/os browsers: then the entry says `--browser chromium`): Playwright's own Chromium, downloaded into
// Playwright's cache by Playwright's installer, from the same `@playwright/mcp@latest` the server runs, so its
// version is the one the server wants. Like noderuntime.ts: in the background a little after Harbor starts, once
// Node is there; never on the main thread; a failure is logged, shown in the Playwright chip's tip and tried again
// on the next start. Linux: a plain install (`--with-deps` needs root, which Harbor doesn't ask for); when the
// installed Chromium can't start for missing system libraries, the tip says which and how to add them.
import { spawn } from "node:child_process";
import { noderuntime, providers } from "@harbor/agents";
import { browsers, env as osEnv } from "@harbor/os";


/** The package Harbor's Playwright entry runs; the installer comes from the same one. */
export const PACKAGE = "@playwright/mcp@latest";

export type Status = { kind: "idle" } | { kind: "installing" } | { kind: "ready" } | { kind: "failed"; error: string } | { kind: "libs"; missing: string[] };

let status: Status = { kind: "idle" };
let inflight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export function current(): Status {
  return status;
}

/** Called on every change of `current()` (mcp.ts redraws the Playwright chip). */
export function onChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function set(s: Status): void {
  status = s;
  for (const f of listeners) {
    try {
      f();
    } catch {
      // a listener's own problem
    }
  }
}

/** The install under way, if any (the bridge lets the Playwright server wait for it a while). */
export function pending(): Promise<boolean> | null {
  return inflight;
}

/** What runs a command line and gives its exit code and output (tests hand in their own). */
export type Run = (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<{ code: number; out: string }>;

export interface Options {
  /** Whether Harbor's Playwright entry is the one with `--browser chromium` (else nothing to do). */
  needed: () => boolean;
  run?: Run;
  /** The Chromium programs to try after the install (Linux: @harbor/os browsers.playwrightChromiums). */
  installed?: () => string[];
}

/**
 * Installs Playwright's Chromium when `needed()`: true once it's there (or not needed), false on a failure
 * (current() says why). One install at a time; Playwright's installer skips what's already in its cache.
 */
export function ensure(o: Options): Promise<boolean> {
  if (!o.needed()) return Promise.resolve(true);
  if (inflight) return inflight;
  const run = o.run ?? runCmd;
  set({ kind: "installing" });
  const started = Date.now();
  inflight = (async (): Promise<boolean> => {
    // Harbor's own Node when the PC has none (null: the user's is on PATH, or it couldn't be installed).
    await providers.ensureNode();
    // shell.ts imports mcp.ts, which imports this file: loaded when needed, not at the top.
    const env = await (await import("./shell.ts")).agentProcessEnv();
    const npx = noderuntime.onPath("npx", env.PATH ?? env.Path ?? "");
    if (npx === null) {
      // No Node: the chip already says why (noderuntime's tip); next start tries again.
      set({ kind: "idle" });
      return false;
    }
    const r = await run([...osEnv.argvOf(npx, env), "-y", "--package", PACKAGE, "playwright", "install", "chromium"], env, 20 * 60_000);
    if (r.code !== 0) throw new Error(`playwright install chromium exited ${r.code}: ${lastLines(r.out)}`);
    const missing = new Set<string>();
    for (const exe of (o.installed ?? (() => browsers.playwrightChromiums(browsers.playwrightCache())))()) {
      const c = await run([exe, "--version"], env, 60_000);
      if (c.code !== 0) for (const m of c.out.matchAll(/error while loading shared libraries: ([^\s:]+)/g)) missing.add(m[1] as string);
    }
    if (missing.size > 0) {
      console.error(`harbor: Playwright's Chromium is installed but can't start: missing ${[...missing].join(", ")}`);
      set({ kind: "libs", missing: [...missing] });
      return false;
    }
    console.error(`harbor: Playwright's Chromium ready for the built-in Playwright server in ${Math.round((Date.now() - started) / 1000)} s`);
    set({ kind: "ready" });
    return true;
  })()
    .catch((e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`harbor: installing Playwright's Chromium failed: ${error}`);
      set({ kind: "failed", error });
      return false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** ensure() in the background `delayMs` after Harbor starts (after Node's own). Never throws, never waits. Not under `bun test`. */
export function startBackground(needed: () => boolean, delayMs = 20_000): void {
  if (process.env.NODE_ENV === "test" || process.env.HARBOR_NODE === "0") return;
  const t = setTimeout(() => void ensure({ needed }), delayMs);
  (t as { unref?: () => void }).unref?.();
}

function lastLines(s: string): string {
  return s.trim().split(/\r?\n/).slice(-3).join(" ").slice(-300);
}

const runCmd: Run = (argv, env, timeoutMs) =>
  new Promise((res) => {
    const [prog, ...args] = argv;
    if (prog === undefined) return res({ code: -1, out: "nothing to run" });
    let out = "";
    const keep = (b: Buffer): void => {
      out = (out + b.toString()).slice(-8000);
    };
    const child = spawn(prog, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const kill = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (e) => {
      clearTimeout(kill);
      res({ code: -1, out: e.message });
    });
    child.once("close", (code) => {
      clearTimeout(kill);
      res({ code: code ?? -1, out });
    });
  });

/** Tests: forget what this process saw. */
export function resetForTests(): void {
  status = { kind: "idle" };
  inflight = null;
}

/** For the Playwright chip: why its browser isn't ready, or null. */
export function tip(): string | null {
  switch (status.kind) {
    case "installing":
      return "Installing a browser for it\u{2026}";
    case "failed":
      return `Couldn't install its browser: ${status.error.slice(0, 160)} \u{b7} tried again on the next start`;
    case "libs":
      return `Its browser can't start: missing system libraries (${status.missing.slice(0, 4).join(", ")}) \u{b7} add them with: sudo npx playwright install-deps chromium`;
    default:
      return null;
  }
}
