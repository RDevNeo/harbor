import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arr, at, f64, i64, optStr, parse, str } from "./json.ts";
import { dataDir, home, writePrivate } from "./paths.ts";

export const KINDS = ["Claude", "Codex", "OpenCode"] as const;
export type Kind = (typeof KINDS)[number];

export function kindOf(label: string): Kind | undefined {
  return KINDS.find((k) => k === label);
}

/** An account id Harbor still drives ("claude", "claude2", "codex", "opencode"): settings saved by older versions may
 *  name providers that were dropped (Cursor, Grok, Gemini, Meta), which read as Claude's defaults. */
export function knownAccount(id: string): boolean {
  return /^claude\+?\d*$/.test(id) || id === "codex" || id === "opencode";
}

const BIN: Record<Kind, string> = {
  Claude: "claude",
  Codex: "codex",
  OpenCode: "opencode",
};

export function bin(k: Kind): string {
  return BIN[k];
}

/** Interactive command that signs the CLI in; it runs in the built-in terminal. */
export function loginCmd(k: Kind): readonly string[] {
  if (k === "Claude") return ["/login"];
  return k === "OpenCode" ? ["auth", "login"] : ["login"];
}

export function installHint(k: Kind): string {
  switch (k) {
    case "Claude":
      return "curl -fsSL https://claude.ai/install.sh | bash";
    case "Codex":
      return "npm i -g @openai/codex";
    case "OpenCode":
      return "curl -fsSL https://opencode.ai/install | bash";
  }
}

/** npm installs say first that they need Node.js, instead of "npm: command not found". */
export function installScript(k: Kind): string {
  const hint = installHint(k);
  if (!hint.startsWith("npm ")) return hint;
  return (
    "if ! command -v npm >/dev/null 2>&1; then\n" +
    `echo '${k} installs with npm, which comes with Node.js, and Node.js isn'\\''t installed.'\n` +
    "echo 'Install Node.js (https://nodejs.org, or your distribution'\\''s nodejs and npm packages), then try again.'\n" +
    "exit 1\n" +
    "fi\n" +
    `${hint} || { echo; echo 'If npm failed with EACCES, its global folder needs root. Use a folder of your own:'; ` +
    "echo '  npm config set prefix ~/.npm-global   (then add ~/.npm-global/bin to your PATH)'; exit 1; }"
  );
}

export interface Window {
  label: string;
  percent: number;
  /** When the window resets (Unix time), if known. */
  resetsAt: number | null;
}

export interface Account {
  /** Stable id stored on chats: "claude", "claude2", "codex", "opencode" */
  id: string;
  kind: Kind;
  name: string;
  email: string;
  /** Two-letter badge shown on the provider icon. */
  badge: string;
  plan: string;
  configDir: string | null;
  bin: string | null;
  loggedIn: boolean | null;
  usage: Window[];
  /** When the usage monitor wrote `usage` (Unix time). */
  usageAt?: number | null;
  /** Turned off in Settings › Providers on this PC: Harbor never picks or offers it (`accounts-off.json`). */
  off?: boolean;
}

export function installed(a: Account): boolean {
  return a.bin !== null;
}

/** Installed and not known to be signed out: an account Harbor can run turns as, and lists as such (a profile
 *  folder that was never signed in only shows where Harbor offers the sign-in). */
export function usable(a: Account): boolean {
  return a.bin !== null && a.loggedIn !== false && a.off !== true;
}

/** usable() and known to be signed in: what background jobs (dictation, names, recaps) may run on. */
export function signedIn(a: Account): boolean {
  return a.bin !== null && a.loggedIn === true && a.off !== true;
}

/** This PC's turned-off accounts. A file, not the settings table: every process that lists accounts (the app, the
 *  hub, an MCP server) reads it, and it never syncs to other PCs. */
export function offPath(): string {
  return join(dataDir(), "accounts-off.json");
}

export function offIds(): string[] {
  const v = readJson(offPath());
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function setOff(id: string, off: boolean): void {
  const now = offIds().filter((x) => x !== id);
  if (off) now.push(id);
  mkdirSync(dataDir(), { recursive: true });
  writePrivate(offPath(), `${JSON.stringify(now.sort())}\n`);
}

/** The account a chat or a default falls back to when `id` is off or gone: the first usable one of `kind` (any kind
 *  when there's none), the main Claude account first. */
export function fallback(accounts: readonly Account[], kind?: Kind): Account | undefined {
  const ok = accounts.filter(usable);
  return ok.find((a) => kind === undefined || a.kind === kind) ?? ok[0];
}

/** A Claude account Settings › Providers can remove: an extra profile folder (~/.claudeN), never the main one. */
export function removable(a: Account): boolean {
  return a.kind === "Claude" && /^claude\+?\d+$/.test(a.id) && a.configDir !== null;
}

/** Takes an extra Claude account out of Harbor: its ~/.claudeN folder moves to Harbor's `removed-accounts` (kept, so
 *  nothing is lost; discover() no longer finds it), and it leaves the off list. Returns where it went. The folder's
 *  links into ~/.claude (projects, skills, …) move as links: what they point to stays where it is. */
export function removeAccount(a: Account): string {
  if (!removable(a) || a.configDir === null) throw new Error(`${a.name} can't be removed`);
  const dir = a.configDir;
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} isn't a folder`);
  const bin = join(dataDir(), "removed-accounts");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  let to = join(bin, `${a.id}-${Math.floor(Date.now() / 1000)}`);
  for (let i = 2; existsSync(to); i++) to = join(bin, `${a.id}-${Math.floor(Date.now() / 1000)}-${i}`);
  renameSync(dir, to);
  if (offIds().includes(a.id)) setOff(a.id, false);
  return to;
}

/** The plan as Anthropic names it since 2026-10-30: "Max 20x" is Ultra, "Max 5x" plain Max (the rate-limit tiers,
 *  default_claude_max_20x and default_claude_max_5x, kept their names). Other plans as given. */
export function planName(plan: string): string {
  const m = /max[ _-]?(\d+)x/i.exec(plan);
  if (m === null) return plan;
  return m[1] === "20" ? "Ultra" : m[1] === "5" ? "Max" : `Max ${m[1]}x`;
}

/** A Claude login's plan from its credentials: the rate-limit tier, else the subscription ("pro" is Pro); "" when
 *  neither says (a bare "max" could be either Max plan). */
export function claudePlan(login: unknown): string {
  const tier = planName(str(at(login, "rateLimitTier")));
  if (tier !== str(at(login, "rateLimitTier"))) return tier;
  const sub = str(at(login, "subscriptionType")).toLowerCase();
  if (sub === "" || sub === "max") return "";
  const named = planName(sub);
  return named !== sub ? named : sub.slice(0, 1).toUpperCase() + sub.slice(1);
}

export function binStr(a: Account): string {
  return a.bin ?? bin(a.kind);
}

/** One line for menus: "Claude · AB" or "Codex". */
export function short(a: Account): string {
  return a.kind === "Claude" ? `Claude · ${a.badge}` : a.kind;
}

/** Environment a child process of this account needs (null: removed). */
export function accountEnv(a: Account): [string, string | null][] {
  const v: [string, string | null][] = [["PATH", childPath()]];
  if (a.kind === "Claude") v.push(["CLAUDE_CONFIG_DIR", a.configDir]);
  return v;
}

export interface Model {
  id: string;
  label: string;
  /** Shown under "Legacy models" / "More models". */
  more: boolean;
}

function m(id: string, label: string, more: boolean): Model {
  return { id, label, more };
}

/** GUI launches often miss the shell's PATH additions; add the usual tool dirs. */
export function childPath(): string {
  const h = home();
  const dirs = (process.env.PATH ?? "").split(":");
  for (const extra of [".local/bin", ".local/share/mise/shims", ".cargo/bin", ".bun/bin", ".opencode/bin", ".npm-global/bin"]) {
    const p = join(h, extra);
    if (!dirs.includes(p)) dirs.push(p);
  }
  return dirs.join(":");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function which(name: string): string | null {
  for (const d of childPath().split(":")) {
    const p = join(d, name);
    if (isFile(p)) return p;
  }
  return null;
}

function readJson(p: string): unknown {
  try {
    return parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

export function badgeFrom(email: string, fallback: string): string {
  const local = email.split("@")[0] ?? "";
  const letters = [...local].filter((c) => /^[A-Za-z]$/.test(c)).slice(0, 2).join("");
  return letters.length === 2 ? letters.toUpperCase() : fallback;
}

function claudeAccount(id: string, dir: string, json: string, n: number): Account {
  const oauth = at(readJson(json), "oauthAccount");
  const email = str(at(oauth, "emailAddress"));
  const display = str(at(oauth, "displayName"));
  const name = display !== "" ? display : n === 1 ? "Claude" : `Claude ${n}`;
  const creds = readJson(join(dir, ".credentials.json"));
  const login = at(creds, "claudeAiOauth");
  return {
    id,
    kind: "Claude",
    name,
    badge: badgeFrom(email, `C${n}`),
    email,
    plan: claudePlan(login),
    configDir: n > 1 ? dir : null,
    bin: which("claude"),
    loggedIn: existsSync(join(dir, ".credentials.json")) || oauth !== null,
    usage: [],
  };
}

/** Only reads files and PATH: it never runs a CLI. A ~/.claudeN folder that was removed is simply not found: callers
 *  keep no list of their own (the hub reads again every minute and when usage is asked for). */
export function discover(): Account[] {
  const h = home();
  const out = [claudeAccount("claude", join(h, ".claude"), join(h, ".claude.json"), 1)];
  const extra: [number, string][] = [];
  let names: string[] = [];
  try {
    names = readdirSync(h);
  } catch {
    // no home folder to read: only the default Claude account
  }
  for (const name of names) {
    if (!name.startsWith(".claude")) continue;
    const rest = name.slice(7);
    if (!/^\+?\d+$/.test(rest)) continue;
    const p = join(h, name);
    if (isDir(p)) extra.push([Number(rest), p]);
  }
  extra.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [n, dir] of extra) out.push(claudeAccount(`claude${n}`, dir, join(dir, ".claude.json"), n));
  out.push({ id: "codex", kind: "Codex", name: "Codex", email: "", badge: "", plan: "", configDir: null, bin: which(bin("Codex")), loggedIn: existsSync(join(h, ".codex/auth.json")), usage: [] });
  // OpenCode can run on providers from its config alone (no `auth login`): whether it's signed in isn't known.
  out.push({ id: "opencode", kind: "OpenCode", name: "OpenCode", email: "", badge: "", plan: "", configDir: null, bin: which(bin("OpenCode")), loggedIn: null, usage: [] });
  const off = offIds();
  for (const a of out) if (off.includes(a.id)) a.off = true;
  applyUsage(out);
  return out;
}

/** Plan and usage windows (only those the provider reports: an Ultra account has no 5-hour one) from the agents-usage-monitor cache, if present. The monitor writes that file by
 *  itself; Harbor reads it at start, on Refresh and when usage is asked for. */
export function applyUsage(accounts: readonly Account[]): void {
  const p = join(home(), ".local/state/omarchy/agents-usage-monitor/usage.json");
  const j = readJson(p);
  const list = at(j, "providers");
  if (!Array.isArray(list)) return;
  let written: number | null = null;
  try {
    written = Math.floor(statSync(p).mtimeMs / 1000);
  } catch {
    // gone since the read
  }
  for (const prov of list) {
    const id = str(at(prov, "id"));
    const a = accounts.find((x) => x.id === id);
    if (!a) continue;
    const plan = planName(str(at(prov, "plan")));
    if (plan !== "") a.plan = plan;
    a.usageAt = written;
    a.usage = arr(at(prov, "windows")).map((x) => {
      const t = optStr(at(x, "resetsAt"));
      const ms = t === undefined ? NaN : Date.parse(t);
      return { label: str(at(x, "label")), percent: f64(at(x, "percent")) ?? 0, resetsAt: Number.isNaN(ms) ? null : Math.floor(ms / 1000) };
    });
    if (a.email === "") a.email = str(at(prov, "account"));
  }
}

export function claudeModels(): Model[] {
  return [
    m("claude-fable-5-1", "Fable 5.1", false),
    m("claude-opus-5-5", "Opus 5.5", false),
    m("claude-sonnet-5-5", "Sonnet 5.5", false),
    m("claude-haiku-5-5", "Haiku 5.5", true),
  ];
}

/** Codex: the newest model of each family from the newest generation is listed; the rest is legacy. */
export function codexModels(cache: unknown = readJson(join(home(), ".codex/models_cache.json"))): Model[] {
  if (cache === undefined) return [m("", "Default", false)];
  const all = arr(at(cache, "models"))
    .filter((x) => at(x, "visibility") === "list")
    .map((x) => ({ slug: str(at(x, "slug")), label: str(at(x, "display_name")), priority: i64(at(x, "priority")) ?? 99 }));
  all.sort((a, b) => a.priority - b.priority);
  const version = (slug: string): number => {
    const head = slug.replace(/^(gpt-)+/, "").split("-")[0] ?? "";
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(head) ? Number(head) : 0;
  };
  const family = (slug: string): string => slug.split("-").pop() ?? "";
  const topMajor = all.reduce((acc, x) => Math.max(acc, Math.floor(version(x.slug))), 0);
  const best = new Map<string, number>();
  for (const { slug } of all) best.set(family(slug), Math.max(best.get(family(slug)) ?? 0, version(slug)));
  return all.map(({ slug, label }) => {
    const v = version(slug);
    const main = best.get(family(slug)) === v && Math.floor(v) === topMajor;
    return { id: slug, label, more: !main };
  });
}

/** OpenCode's models ("provider/model", as `opencode run -m` takes them) from `opencode models`: kept in Harbor's data
 *  folder and refreshed off the UI thread (opencodeModels() starts it), so a list is there at once. */
export function opencodeCachePath(): string {
  return join(dataDir(), "opencode-models.json");
}

/** How long a fetched list is fresh; an older one is shown while it's fetched again. */
const OPENCODE_FRESH_MS = 10 * 60 * 1000;
let ocList: string[] | null = null;
let ocAt = 0;
let ocFetching: Promise<void> | null = null;

/** The model ids in `opencode models`' output: one "provider/model" per line, anything else skipped. */
export function parseOpencodeModels(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!/^[^\s/]+\/\S+$/.test(l) || out.includes(l)) continue;
    out.push(l);
  }
  return out;
}

/** The models named in the user's OpenCode config (`model`, `small_model`, `provider.<p>.models.<m>`): shown up front. */
export function opencodeConfigured(config: unknown = readJson(join(home(), ".config/opencode/opencode.json"))): string[] {
  const out: string[] = [];
  for (const k of ["model", "small_model"]) {
    const v = optStr(at(config, k));
    if (v !== undefined && v.includes("/")) out.push(v);
  }
  const provs = at(config, "provider");
  if (provs !== null && typeof provs === "object" && !Array.isArray(provs)) {
    for (const [p, def] of Object.entries(provs)) {
      const ms = at(def, "models");
      if (ms !== null && typeof ms === "object" && !Array.isArray(ms)) for (const id of Object.keys(ms)) out.push(`${p}/${id}`);
    }
  }
  return [...new Set(out)];
}

/** The picker's list: "Default" (OpenCode's own choice), then every model it lists; those the config names, or the
 *  first few when it names none, up front and the rest under "More models". */
export function opencodeModelList(ids: readonly string[], configured: readonly string[]): Model[] {
  const front = configured.length > 0 ? configured.filter((c) => ids.includes(c)) : ids.slice(0, 6);
  const rest = ids.filter((x) => !front.includes(x));
  return [m("", "Default", false), ...front.map((x) => m(x, x, false)), ...rest.map((x) => m(x, x, true))];
}

/** Runs `opencode models` (without blocking) and keeps its list; a failed run keeps the last one. */
export function refreshOpencodeModels(binPath: string | null = which(bin("OpenCode"))): Promise<void> {
  if (ocFetching !== null) return ocFetching;
  if (binPath === null) return Promise.resolve();
  ocFetching = (async () => {
    try {
      const p = Bun.spawn([binPath, "models"], { env: { ...process.env, PATH: childPath() }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
      const text = await new Response(p.stdout).text();
      await p.exited;
      clearTimeout(timer);
      const ids = parseOpencodeModels(text);
      if (p.exitCode === 0 && ids.length > 0) {
        ocList = ids;
        try {
          mkdirSync(dataDir(), { recursive: true });
          writeFileSync(opencodeCachePath(), `${JSON.stringify(ids)}\n`);
        } catch {
          // no data folder: the list stays in memory
        }
      }
    } catch {
      // opencode didn't run: the last list stays
    } finally {
      ocAt = Date.now();
      ocFetching = null;
    }
  })();
  return ocFetching;
}

/** OpenCode's models now: the last list (this process's, else the data folder's), refreshed in the background when stale
 *  (not under `bun test`, which has no OpenCode of its own to ask). */
export function opencodeModels(refresh = process.env.NODE_ENV !== "test"): Model[] {
  if (ocList === null) {
    const v = readJson(opencodeCachePath());
    if (Array.isArray(v)) ocList = v.filter((x): x is string => typeof x === "string");
  }
  if (refresh && Date.now() - ocAt > OPENCODE_FRESH_MS) void refreshOpencodeModels();
  return opencodeModelList(ocList ?? [], opencodeConfigured());
}

export function staticModels(k: Kind): Model[] {
  if (k === "Claude") return claudeModels();
  if (k === "OpenCode") return opencodeModels();
  return codexModels();
}

export type Choice = readonly [key: string, label: string, detail: string];

export function efforts(k: Kind): readonly Choice[] {
  switch (k) {
    case "Claude":
      return [
        ["low", "Low", ""],
        ["medium", "Medium", ""],
        ["high", "High", ""],
        ["xhigh", "Extra High", ""],
        ["max", "Max", ""],
        ["ultracode", "Ultracode", "xhigh effort plus multi-agent workflow orchestration"],
        ["ultrathink", "Ultrathink", ""],
      ];
    case "Codex":
      return [
        ["low", "Low", ""],
        ["medium", "Medium", ""],
        ["high", "High", ""],
        ["xhigh", "Extra High", ""],
        ["max", "Max", ""],
        ["ultra", "Ultra", "Maximum reasoning with automatic task delegation"],
      ];
    case "OpenCode":
      return [];
  }
}

let codexEffort: string | undefined;

/** Claude gets Harbor's own default whatever Claude Code's effortLevel says; the others their CLI's setting. */
export function defaultEffort(k: Kind): string {
  if (k === "Claude") return "medium";
  if (k !== "Codex") return "";
  if (codexEffort === undefined) {
    let text = "";
    try {
      text = readFileSync(join(home(), ".codex/config.toml"), "utf8");
    } catch {
      // no Codex config: its default effort
    }
    const line = text.split("\n").find((l) => l.startsWith("model_reasoning_effort"));
    const v = line?.slice("model_reasoning_effort".length).replace(/^[ =]+/, "").trim().replace(/^"+|"+$/g, "");
    codexEffort = efforts("Codex").find((e) => e[0] === v)?.[0] ?? "medium";
  }
  return codexEffort;
}

export function effortLabel(k: Kind, e: string): string {
  const key = e === "" ? defaultEffort(k) : e;
  return efforts(k).find((x) => x[0] === key)?.[1] ?? "Default";
}

/** Providers with a fast tier: Claude Code's fastMode, Codex's priority service tier. */
export function hasFast(k: Kind): boolean {
  return k === "Claude" || k === "Codex";
}

const FULL: Choice = ["full", "Full access", "Runs commands and edits files without asking"];
const EDITS: Choice = ["edits", "Auto-edit", "Edits files; risky commands are refused"];
const PLAN: Choice = ["plan", "Read only", "Reads and plans, changes nothing"];

/** OpenCode's headless run has no approval mode Harbor can set: it runs with full access. */
export function access(k: Kind): readonly Choice[] {
  return k === "OpenCode" ? [FULL] : [FULL, EDITS, PLAN];
}

export function accessLabel(k: Kind, a: string): string {
  return access(k).find((x) => x[0] === a)?.[1] ?? "Full access";
}

