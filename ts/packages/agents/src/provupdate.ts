// Each installed CLI's `--version` against npm's latest; Cursor and Meta publish no version to
// compare.
import { at, optStr } from "./json.ts";
import { type Account, childPath, type Kind, KINDS } from "./providers.ts";

const CHECK_EVERY_MS = 6 * 3600 * 1000;
/** The first check waits a little, so starting Harbor stays quick. */
const FIRST_CHECK_MS = 45_000;

export interface Pending {
  kind: Kind;
  current: string;
  latest: string;
}

export interface Status {
  /** Providers with a newer version out, in KINDS order. */
  items: Pending[];
  /** Checking or updating. */
  busy: boolean;
  updating: boolean;
  /** The last update's failure, per provider. */
  error: string | null;
  /** "Codex and Claude are up to date" for a moment after an update: the text and when. */
  done: [string, number] | null;
}

let state: Status = { items: [], busy: false, updating: false, error: null, done: null };
let lastCheck: number | null = null;
let started: number | null = null;
const listeners = new Set<() => void>();

export function status(): Status {
  return { ...state, items: [...state.items] };
}

/** Called whenever the status changes (the UI repaints). */
export function onChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function update(f: (s: Status) => void): void {
  f(state);
  for (const l of listeners) l();
}

/** Closing the pop-up after an update forgets how it went. */
export function clearOutcome(): void {
  update((s) => {
    s.error = null;
    s.done = null;
  });
}

/** The npm package a CLI's version is looked up in. */
export function npmPackage(k: Kind): string | null {
  switch (k) {
    case "Claude":
      return "@anthropic-ai/claude-code";
    case "Codex":
      return "@openai/codex";
    case "Gemini":
      return "@google/gemini-cli";
    case "Grok":
      return "@xai-official/grok";
    case "OpenCode":
      return "opencode-ai";
    default:
      return null;
  }
}

/** Its logo in the phone's assets (assets/logos). */
export function logoFile(k: Kind): string {
  const files: Record<Kind, string> = {
    Claude: "p-claude-color.rgba",
    Codex: "p-openai.a8",
    Cursor: "p-cursor.a8",
    Grok: "p-grok.a8",
    Gemini: "p-gemini-color.rgba",
    Meta: "p-meta-color.rgba",
    OpenCode: "p-opencode.a8",
  };
  return files[k];
}

export function updateCmd(k: Kind, bin: string): string[] {
  if (k === "Claude") return [bin, "update"];
  if (k === "OpenCode") return [bin, "upgrade"];
  return ["npm", "i", "-g", `${npmPackage(k) ?? ""}@latest`];
}

/** The first x.y.z in `claude --version` ("2.0.14 (Claude Code)"), `codex --version` ("codex-cli 0.46.0"), … */
export function parseVersion(out: string): string | null {
  for (const raw of out.split(/[\s(),]/)) {
    const w = raw.replace(/^v+/, "");
    const core = w.split(/[-+]/)[0] ?? "";
    const parts = core.split(".");
    if (parts.length >= 3 && parts.every((p) => /^\d+$/.test(p))) return w;
  }
  return null;
}

/** (major, minor, patch, is_release), as update.rs compares versions. */
function parseSemver(v: string): [number, number, number, number] | null {
  const t = v.trim().replace(/^v+/, "");
  const dash = t.indexOf("-");
  const core = dash < 0 ? t : t.slice(0, dash);
  const it = core.split(".");
  const num = (x: string | undefined): number | null => (x !== undefined && /^\d+$/.test(x) ? Number(x) : null);
  const a = num(it[0]);
  const b = num(it[1]);
  if (a === null || b === null) return null;
  return [a, b, num(it[2]) ?? 0, dash < 0 ? 1 : 0];
}

export function newer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  return false;
}

async function run(argv: string[], timeoutMs: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let p;
  try {
    p = Bun.spawn(argv, { env: { ...process.env, PATH: childPath() }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { ok: false, error: `${argv[0]}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(timer);
  if (timedOut) return { ok: false, error: "timed out" };
  const text = out + err;
  if (p.exitCode === 0) return { ok: true, text };
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return { ok: false, error: lines[lines.length - 1] ?? "failed" };
}

export async function latest(pkg: string): Promise<string | null> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    return optStr(at(await r.json(), "version")) ?? null;
  } catch {
    return null;
  }
}

/** The installed CLIs worth checking: one per kind (Claude's accounts share a binary). */
export function installed(accounts: readonly Account[]): [Kind, string][] {
  const out: [Kind, string][] = [];
  for (const a of accounts) if (a.bin !== null && npmPackage(a.kind) !== null && !out.some(([k]) => k === a.kind)) out.push([a.kind, a.bin]);
  return out;
}

async function find(bins: [Kind, string][], lookup: (pkg: string) => Promise<string | null> = latest): Promise<Pending[]> {
  const found: Pending[] = [];
  for (const [kind, bin] of bins) {
    const r = await run([bin, "--version"], 20_000);
    const current = r.ok ? parseVersion(r.text) : null;
    if (current === null) continue;
    const pkg = npmPackage(kind);
    const l = pkg === null ? null : await lookup(pkg);
    if (l !== null && newer(l, current)) found.push({ kind, current, latest: l });
  }
  return found.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

/** Called now and then: checks soon after start and every few hours. */
export function tick(accounts: readonly Account[]): void {
  started ??= Date.now();
  const due = lastCheck === null ? Date.now() - started >= FIRST_CHECK_MS : Date.now() - lastCheck >= CHECK_EVERY_MS;
  if (due && !state.busy) void check(installed(accounts));
}

export async function check(bins: [Kind, string][], lookup?: (pkg: string) => Promise<string | null>): Promise<void> {
  lastCheck = Date.now();
  update((s) => (s.busy = true));
  const found = await find(bins, lookup);
  update((s) => {
    s.items = found;
    s.busy = false;
  });
}

/** "Codex and Claude", "Codex, Gemini and Claude". */
export function names(items: readonly Pending[]): string {
  const n = items.map((p) => p.kind);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** What a dismissal remembers: the versions on offer, so the next ones show again. */
export function key(items: readonly Pending[]): string {
  return items.map((p) => `${p.kind.toLowerCase()}=${p.latest}`).join(",");
}

/** The Update button: updates every pending provider, one after the other, then looks again. False when there is nothing to update or it's busy. */
export function updateAll(accounts: readonly Account[], lookup?: (pkg: string) => Promise<string | null>): Promise<void> | false {
  const st = state;
  if (st.busy || st.items.length === 0) return false;
  const bins = installed(accounts);
  const todo = bins.filter(([k]) => st.items.some((p) => p.kind === k));
  update((s) => {
    s.busy = true;
    s.updating = true;
    s.error = null;
    s.done = null;
  });
  return (async () => {
    const failed: string[] = [];
    const ok: Kind[] = [];
    for (const [kind, bin] of todo) {
      const r = await run(updateCmd(kind, bin), 600_000);
      if (r.ok) ok.push(kind);
      else failed.push(`${kind}: ${r.error}`);
      for (const l of listeners) l();
    }
    const found = await find(bins, lookup);
    lastCheck = Date.now();
    update((s) => {
      const updated = ok.filter((k) => !found.some((p) => p.kind === k)).map((kind) => ({ kind, current: "", latest: "" }));
      if (updated.length > 0) s.done = [`${names(updated)} ${updated.length === 1 ? "is" : "are"} up to date`, Date.now()];
      s.items = found;
      s.error = failed.length > 0 ? failed.join("; ") : null;
      s.busy = false;
      s.updating = false;
    });
  })();
}
