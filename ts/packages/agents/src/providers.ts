import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { arr, at, f64, i64, optStr, parse, str } from "./json.ts";
import { home } from "./paths.ts";

export const KINDS = ["Claude", "Codex", "Cursor", "Grok", "Gemini", "Meta", "OpenCode"] as const;
export type Kind = (typeof KINDS)[number];

export function kindOf(label: string): Kind | undefined {
  return KINDS.find((k) => k === label);
}

const BIN: Record<Kind, string> = {
  Claude: "claude",
  Codex: "codex",
  Cursor: "cursor-agent",
  Grok: "grok",
  Gemini: "gemini",
  Meta: "muse",
  OpenCode: "opencode",
};

export function bin(k: Kind): string {
  return BIN[k];
}

/** Interactive command that signs the CLI in; it runs in the built-in terminal. */
export function loginCmd(k: Kind): readonly string[] {
  switch (k) {
    case "Claude":
      return ["/login"];
    case "Gemini":
      return [];
    case "OpenCode":
      return ["auth", "login"];
    default:
      return ["login"];
  }
}

export function installHint(k: Kind): string {
  switch (k) {
    case "Claude":
      return "curl -fsSL https://claude.ai/install.sh | bash";
    case "Codex":
      return "npm i -g @openai/codex";
    case "Cursor":
      return "curl https://cursor.com/install -fsS | bash";
    case "Grok":
      return "npm i -g @xai-official/grok";
    case "Gemini":
      return "npm i -g @google/gemini-cli";
    case "Meta":
      return "curl -fsSL https://dev.meta.ai/install.sh | bash";
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
  /** Stable id stored on chats: "claude", "claude2", "codex", "cursor", … */
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
}

export function installed(a: Account): boolean {
  return a.bin !== null;
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
  return {
    id,
    kind: "Claude",
    name,
    badge: badgeFrom(email, `C${n}`),
    email,
    plan: "",
    configDir: n > 1 ? dir : null,
    bin: which("claude"),
    loggedIn: existsSync(join(dir, ".credentials.json")) || oauth !== null,
    usage: [],
  };
}

/** Only reads files and PATH: it never runs a CLI. */
export function discover(): Account[] {
  const h = home();
  const out = [claudeAccount("claude", join(h, ".claude"), join(h, ".claude.json"), 1)];
  const extra: [number, string][] = [];
  let names: string[] = [];
  try {
    names = readdirSync(h);
  } catch {}
  for (const name of names) {
    if (!name.startsWith(".claude")) continue;
    const rest = name.slice(7);
    if (!/^\+?\d+$/.test(rest)) continue;
    const p = join(h, name);
    if (isDir(p)) extra.push([Number(rest), p]);
  }
  extra.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [n, dir] of extra) out.push(claudeAccount(`claude${n}`, dir, join(dir, ".claude.json"), n));
  for (const kind of KINDS.slice(1)) {
    let loggedIn: boolean | null = null;
    if (kind === "Codex") loggedIn = existsSync(join(h, ".codex/auth.json"));
    if (kind === "Meta") loggedIn = existsSync(join(h, ".config/muse/auth.json"));
    if (kind === "Gemini") loggedIn = existsSync(join(h, ".gemini/oauth_creds.json")) || process.env.GEMINI_API_KEY !== undefined;
    if (kind === "Grok") loggedIn = existsSync(join(h, ".grok/auth.json")) || process.env.XAI_API_KEY !== undefined;
    out.push({ id: kind.toLowerCase(), kind, name: kind, email: "", badge: "", plan: "", configDir: null, bin: which(bin(kind)), loggedIn, usage: [] });
  }
  applyUsage(out);
  return out;
}

/** Plan and 5-hour/weekly windows from the agents-usage-monitor cache, if present. */
function applyUsage(accounts: Account[]): void {
  const j = readJson(join(home(), ".local/state/omarchy/agents-usage-monitor/usage.json"));
  const list = at(j, "providers");
  if (!Array.isArray(list)) return;
  for (const prov of list) {
    const id = str(at(prov, "id"));
    const a = accounts.find((x) => x.id === id);
    if (!a) continue;
    a.plan = str(at(prov, "plan"));
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

/** Cursor: parsed from `cursor-agent models` (run off the UI thread). */
export function cursorModels(cursorBin: string): Model[] {
  let text = "";
  try {
    const r = Bun.spawnSync([cursorBin, "models"], { env: { ...process.env, PATH: childPath() }, stdout: "pipe", stderr: "ignore" });
    text = r.stdout.toString();
  } catch {}
  return parseCursorModels(text);
}

export function parseCursorModels(text: string): Model[] {
  const v: Model[] = [];
  for (const l of text.split("\n")) {
    const i = l.indexOf(" - ");
    if (i < 0) continue;
    const id = l.slice(0, i).trim();
    if (id.includes(" ")) continue;
    const label = l.slice(i + 3).replaceAll("(current, default)", "").replaceAll("(current)", "").replaceAll("(default)", "");
    v.push(m(id, label.trim(), false));
  }
  v.forEach((x, i) => (x.more = i >= 4));
  if (v.length === 0) v.push(m("auto", "Auto", false));
  return v;
}

export function staticModels(k: Kind): Model[] {
  if (k === "Claude") return claudeModels();
  if (k === "Codex") return codexModels();
  if (k === "Cursor") return [m("auto", "Auto", false)];
  return [m("", "Default", false)];
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
    case "Meta":
      return [
        ["minimal", "Minimal", ""],
        ["low", "Low", ""],
        ["medium", "Medium", ""],
        ["high", "High", ""],
        ["max", "Max", ""],
      ];
    default:
      return [];
  }
}

let codexEffort: string | undefined;

/** Claude gets Harbor's own default whatever Claude Code's effortLevel says; the others their CLI's setting. */
export function defaultEffort(k: Kind): string {
  if (k === "Claude") return "medium";
  if (k === "Meta") return "high";
  if (k !== "Codex") return "";
  if (codexEffort === undefined) {
    let text = "";
    try {
      text = readFileSync(join(home(), ".codex/config.toml"), "utf8");
    } catch {}
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

export function access(k: Kind): readonly Choice[] {
  switch (k) {
    case "Claude":
    case "Codex":
    case "Grok":
    case "Gemini":
      return [FULL, EDITS, PLAN];
    case "Cursor":
    case "Meta":
      return [FULL, ["ask", "Default", "The CLI's own approval rules"]];
    case "OpenCode":
      return [FULL];
  }
}

export function accessLabel(k: Kind, a: string): string {
  return access(k).find((x) => x[0] === a)?.[1] ?? "Full access";
}

