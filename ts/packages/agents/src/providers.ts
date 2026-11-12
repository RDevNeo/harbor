import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { arr, at, f64, i64, optStr, parse, str } from "./json.ts";
import { dataDir, home, writePrivate } from "./paths.ts";
import * as claudecreds from "./claudecreds.ts";
import { env as osEnv } from "@harbor/os";

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

/** The provider a chat is held to, if any: a lead may switch to any (a started one continues in a fresh session with the
 *  conversation so far) unless it started on another device, which only Claude runs on; a started subagent stays on its
 *  own. */
export function lockedKind(c: { role: string; started: boolean; device: string; account: string }, kindOf: (account: string) => Kind | undefined): Kind | undefined {
  if (c.role === "lead") return c.started && c.device !== "" ? "Claude" : undefined;
  return c.started ? kindOf(c.account) : undefined;
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
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const extra of [".local/bin", ".local/share/mise/shims", ".cargo/bin", ".bun/bin", ".opencode/bin", ".npm-global/bin"]) {
    const p = join(h, extra);
    if (!dirs.includes(p)) dirs.push(p);
  }
  for (const p of osEnv.systemToolDirs()) if (!dirs.includes(p)) dirs.push(p);
  return dirs.join(delimiter);
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
  for (const d of childPath().split(delimiter)) {
    const p = osEnv.execSuffixes().map((x) => join(d, name + x)).find(isFile);
    if (p !== undefined) {
      // A GUI can inherit a versioned mise PATH. Stable shims let future turns pick up updates.
      if ((name === "claude" || name === "codex") && p.includes("/mise/installs/")) {
        const shim = p.slice(0, p.indexOf("/mise/installs/")) + `/mise/shims/${name}`;
        if (isFile(shim)) return shim;
      }
      return p;
    }
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

/** Read display identity from the saved ID token, never from the usage cache (which can outlive a login).
 * This is only for grouping local sign-ins, not for authenticating or authorizing requests. */
export function codexEmail(auth: unknown): string {
  const token = str(at(at(auth, "tokens"), "id_token"));
  try {
    const payload = token.split(".")[1];
    if (!payload) return "";
    const email = str(at(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), "email"));
    return email.includes("@") ? email.trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

function claudeAccount(id: string, dir: string, json: string, n: number): Account {
  const oauth = at(readJson(json), "oauthAccount");
  const email = str(at(oauth, "emailAddress"));
  const display = str(at(oauth, "displayName"));
  const name = display !== "" ? display : n === 1 ? "Claude" : `Claude ${n}`;
  const profile = n > 1 ? dir : null;
  const text = claudecreds.read(profile);
  let login: unknown = null;
  try {
    login = text === null ? null : at(JSON.parse(text), "claudeAiOauth");
  } catch {
    // a broken file: no plan to show
  }
  return {
    id,
    kind: "Claude",
    name,
    badge: badgeFrom(email, `C${n}`),
    email,
    plan: claudePlan(login),
    configDir: n > 1 ? dir : null,
    bin: which("claude"),
    loggedIn: text !== null || oauth !== null,
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
  out.push({ id: "codex", kind: "Codex", name: "Codex", email: codexEmail(readJson(join(h, ".codex/auth.json"))), badge: "", plan: "", configDir: null, bin: which(bin("Codex")), loggedIn: existsSync(join(h, ".codex/auth.json")), usage: [] });
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
    if (a.email === "" && a.kind !== "Codex") a.email = str(at(prov, "account"));
  }
}

/** A model the Claude CLI knows: its id, family ("opus") and name ("Opus 5.5"). */
export interface ClaudeKnown {
  id: string;
  family: string;
  label: string;
}

/** The families the picker lists, in Claude Code's /model order (Ctrl+1… follow it). */
const CLAUDE_FAMILIES = ["opus", "fable", "sonnet", "haiku"];

/** Used when the CLI can't be read: the list as of Claude Code 2.1.322. */
const CLAUDE_FALLBACK: ClaudeKnown[] = [
  { id: "claude-opus-5-5", family: "opus", label: "Opus 5.5" },
  { id: "claude-fable-5-2", family: "fable", label: "Fable 5.2" },
  { id: "claude-fable-5-1", family: "fable", label: "Fable 5.1" },
  { id: "claude-sonnet-5-5", family: "sonnet", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", family: "haiku", label: "Haiku 5.5" },
];

/** The model table inside Claude Code's bundle: `{id:"claude-fable-5-2",family:"fable",display_name:"Fable 5.2",…}`. */
const CLAUDE_ENTRY = /^\{id:"(claude-[a-z0-9-]{1,40})",family:"([a-z]{1,20})",display_name:"([^"\\]{1,40})"/;
const CLAUDE_MARK = '{id:"claude-';

/** The models in a piece of the CLI's bundle (each once). */
export function parseClaudeModels(text: string): ClaudeKnown[] {
  const out: ClaudeKnown[] = [];
  for (let i = text.indexOf(CLAUDE_MARK); i >= 0; i = text.indexOf(CLAUDE_MARK, i + 1)) {
    const hit = CLAUDE_ENTRY.exec(text.slice(i, i + 160));
    if (hit === null || out.some((x) => x.id === hit[1])) continue;
    out.push({ id: hit[1] ?? "", family: hit[2] ?? "", label: hit[3] ?? "" });
  }
  return out;
}

/** [generation, minor] from an id: "claude-opus-5-5" → [5, 5], "claude-opus-4-0" / "claude-opus-5" → [4, 0] / [5, 0]. */
function claudeVersion(id: string): [number, number] {
  const n = (id.match(/\d+/g) ?? []).map(Number).filter((x) => x < 1000);
  return [n[0] ?? 0, n[1] ?? 0];
}

/** Without Claude Code's served menu: the newest of each family from the newest generation up front (opus, fable, sonnet, haiku), then
 *  under "More models" the newest generation's older ones and the generation before's newest of each family. */
export function claudeModelList(known: readonly ClaudeKnown[]): Model[] {
  const ours = known.filter((k) => CLAUDE_FAMILIES.includes(k.family));
  if (ours.length === 0) return claudeModelList(CLAUDE_FALLBACK);
  const ver = (k: ClaudeKnown): number => claudeVersion(k.id)[0] * 1000 + claudeVersion(k.id)[1];
  const top = Math.max(...ours.map((k) => claudeVersion(k.id)[0]));
  const newest = (gen: number): ClaudeKnown[] =>
    CLAUDE_FAMILIES.flatMap((f) => {
      const of = ours.filter((k) => k.family === f && claudeVersion(k.id)[0] === gen).sort((a, b) => ver(b) - ver(a));
      return of.length > 0 ? [of[0] as ClaudeKnown] : [];
    });
  const main = newest(top);
  const order = (a: ClaudeKnown, b: ClaudeKnown): number => ver(b) - ver(a) || CLAUDE_FAMILIES.indexOf(a.family) - CLAUDE_FAMILIES.indexOf(b.family);
  const older = ours.filter((k) => claudeVersion(k.id)[0] === top && !main.includes(k)).sort(order);
  const before = newest(Math.max(...ours.map((k) => claudeVersion(k.id)[0]).filter((g) => g < top), -1)).sort(order);
  return [...main.map((k) => m(k.id, k.label, false)), ...[...older, ...before].map((k) => m(k.id, k.label, true))];
}

/** The Claude CLI's models, kept per CLI version (its resolved path, size and time) in Harbor's data folder. */
export function claudeCachePath(): string {
  return join(dataDir(), "claude-models.json");
}

let clKnown: ClaudeKnown[] | null = null;
let clKey = "";
let clCheckedAt = 0;
let clScanning: Promise<void> | null = null;

/** Which CLI is installed now, as a cache key ("" when there is none). */
function claudeCliKey(binPath: string | null): string {
  if (binPath === null) return "";
  try {
    const real = realpathSync(binPath);
    const st = statSync(real);
    return `${real}|${st.size}|${Math.floor(st.mtimeMs)}`;
  } catch {
    return "";
  }
}

/** Reads the CLI's bundle in pieces (it is hundreds of MB: never whole) for its model table; keeps what it finds. */
export function scanClaudeModels(binPath: string | null = which("claude")): Promise<void> {
  if (clScanning !== null) return clScanning;
  const key = claudeCliKey(binPath);
  clScanning = (async () => {
    try {
      if (binPath === null || key === "") return;
      const real = key.split("|")[0] ?? "";
      const found: ClaudeKnown[] = [];
      // Searched as bytes, and only the few hits decoded: a piece of the next chunk is kept so none is cut.
      const mark = Buffer.from(CLAUDE_MARK, "latin1");
      let carry = Buffer.alloc(0);
      for await (const chunk of Bun.file(real).stream()) {
        const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let i = buf.indexOf(mark);
        let keep = Math.max(0, buf.length - 160);
        for (; i >= 0; i = buf.indexOf(mark, i + 1)) {
          if (i + 160 > buf.length) {
            keep = Math.min(keep, i);
            break;
          }
          for (const k of parseClaudeModels(buf.toString("latin1", i, i + 160))) if (!found.some((x) => x.id === k.id)) found.push(k);
        }
        carry = Buffer.from(buf.subarray(keep));
      }
      if (found.length === 0) return;
      clKnown = found;
      clKey = key;
      try {
        mkdirSync(dataDir(), { recursive: true });
        writeFileSync(claudeCachePath(), `${JSON.stringify({ key, models: found })}\n`);
      } catch {
        // no data folder: the list stays in memory
      }
    } catch {
      // unreadable CLI: the last list (or the built-in one) stays
    } finally {
      clCheckedAt = Date.now();
      clScanning = null;
    }
  })();
  return clScanning;
}

/** Claude Code's own /model menu, as it keeps it per account (`<config>/cache/model-catalog/<org>-cc.json`, fetched
 *  by the CLI): its models in its order, "main" up front and the rest (its "More models") after. Null: none readable. */
export function parseClaudeCatalog(doc: unknown): Model[] | null {
  const list = arr(at(at(at(doc, "catalog"), "config"), "models"));
  const out: Model[] = [];
  for (const x of list) {
    const id = str(at(x, "id"));
    const label = str(at(x, "name"));
    if (!/^claude-[a-z0-9-]+$/.test(id) || label === "" || out.some((o) => o.id === id)) continue;
    out.push(m(id, label, str(at(x, "section")) !== "main"));
  }
  return out.some((o) => !o.more) ? [...out.filter((o) => !o.more), ...out.filter((o) => o.more)] : null;
}

/** Every Claude config folder's catalog files (~/.claude, ~/.claudeN), newest fetch first. */
function claudeCatalogs(): { path: string; at: number }[] {
  const h = home();
  const dirs = [join(h, ".claude")];
  try {
    for (const n of readdirSync(h)) if (/^\.claude\+?\d+$/.test(n)) dirs.push(join(h, n));
  } catch {
    // no home folder
  }
  const out: { path: string; at: number }[] = [];
  for (const d of dirs) {
    const dir = join(d, "cache/model-catalog");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith("-cc.json")) continue;
      try {
        out.push({ path: join(dir, n), at: statSync(join(dir, n)).mtimeMs });
      } catch {
        // gone since the listing
      }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

let clMenu: Model[] | null = null;
let clMenuKey = "";

/** The newest readable /model menu any account's CLI fetched (read again only when the files change). */
export function claudeMenu(): Model[] | null {
  const files = claudeCatalogs();
  const key = files.map((f) => `${f.path}|${f.at}`).join(";");
  if (key === clMenuKey) return clMenu;
  clMenuKey = key;
  clMenu = null;
  let best = -1;
  for (const f of files) {
    const doc = readJson(f.path);
    const fetched = f64(at(doc, "fetchedAt")) ?? f.at;
    const list = fetched > best ? parseClaudeCatalog(doc) : null;
    if (list !== null) [clMenu, best] = [list, fetched];
  }
  return clMenu;
}

/** Claude's models as Claude Code shows them in /model: its served menu when it has fetched one, else the models its
 *  bundle knows (read again in the background when the CLI changes), else a built-in list. Checked once a minute. */
export function claudeModels(refresh = process.env.NODE_ENV !== "test"): Model[] {
  if (refresh && Date.now() - clCheckedAt > 60_000 && clScanning === null) {
    clCheckedAt = Date.now();
    claudeMenu();
    const bin = which("claude");
    const key = claudeCliKey(bin);
    if (key !== "" && key !== clKey) {
      const c = readJson(claudeCachePath());
      const list = at(c, "models");
      if (str(at(c, "key")) === key && Array.isArray(list)) {
        clKnown = list.map((x) => ({ id: str(at(x, "id")), family: str(at(x, "family")), label: str(at(x, "label")) })).filter((x) => x.id !== "" && x.label !== "");
        clKey = key;
      } else void scanClaudeModels(bin);
    }
  }
  return (refresh ? clMenu : null) ?? claudeModelList(clKnown ?? CLAUDE_FALLBACK);
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
  if (binPath === null) {
    // Not installed: looked for again when the list is next stale.
    ocAt = Date.now();
    return Promise.resolve();
  }
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

