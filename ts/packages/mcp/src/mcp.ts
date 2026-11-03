import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { home, now } from "@harbor/store";
import {
  APPS,
  type Auth,
  LOCAL,
  type Local,
  app,
  convexToken,
  ghDir,
  ghOutDir,
  ghToken,
  isOff,
  loadAccount,
  localFor,
  load,
  privateDir,
  refresh,
  refreshTo,
  accountPath,
  googleAccounts,
  signedIn,
  token,
  writePrivate,
  dir,
} from "./apps.ts";
import { type Json, isObject, parseObject } from "./json.ts";
import { providers } from "@harbor/agents";
import { urlEncode } from "@harbor/net";
import { selfExe } from "./sys.ts";

export * from "./apps.ts";
export * from "./http.ts";
export { openUrl, setOpener } from "./sys.ts";
export {
  callbackPage,
  cancel,
  dismiss,
  error,
  googleAuthUrl,
  googleDesktopClient,
  googlePhoneCode,
  googlePhoneFinish,
  googlePhoneStart,
  googleSaveCode,
  googleWebClientId,
  isCode,
  listenCallback,
  oauthLogin,
  pending,
  phoneRedirectOk,
  signIn,
  signOut,
  wellKnown,
} from "./signin.ts";

export type EnvVar = [string, string | undefined];

export interface LocalDef {
  local: Local;
  def: [string, Json] | undefined;
}

let localsCache: { at: number; defs: LocalDef[] } | undefined;

export function locals(): LocalDef[] {
  if (localsCache && Date.now() - localsCache.at < 5000) return localsCache.defs;
  const h = home();
  const files = [join(h, ".claude.json")];
  let extra: string[] = [];
  try {
    extra = readdirSync(h)
      .filter((n) => /^\.claude\d+$/.test(n))
      .sort()
      .map((n) => join(h, n, ".claude.json"));
  } catch {
    // no readable home folder
  }
  files.push(...extra);
  const servers: [string, Json][] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const j = parseObject(text);
    const m = j?.mcpServers;
    if (isObject(m)) servers.push(...Object.entries(m));
  }
  const defs = LOCAL.map((l): LocalDef => {
    const found = servers.find(([n]) => localFor(n)?.id === l.id);
    if (found) return { local: l, def: found };
    if (l.id === "playwright") return { local: l, def: ["playwright", { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] }] };
    return { local: l, def: undefined };
  });
  localsCache = { at: Date.now(), defs };
  return defs;
}

export function resetLocalsCache(): void {
  localsCache = undefined;
}

export function tokenVar(id: string): string {
  return `HARBOR_TOKEN_${id.toUpperCase()}`;
}

/** A local server that a signed-in app of the same name replaces, so agents never get both sets of tools. */
function shadowed(local: string): boolean {
  return app(local) !== undefined && signedIn(local);
}

let refresher: ReturnType<typeof setInterval> | undefined;

function keepFresh(): void {
  if (refresher) return;
  const pass = async (): Promise<void> => {
    const soon = (c: { expires_at: number }): boolean => c.expires_at > 0 && c.expires_at - now() < 15 * 60;
    for (const a of APPS) {
      try {
        if (a.auth.kind === "oauth") {
          const c = load(a.id);
          if (c && soon(c)) await refresh(a.id, c);
        } else if (a.auth.kind === "google") {
          for (const e of googleAccounts(a.id)) {
            const c = loadAccount(a.id, e);
            if (c && soon(c)) await refreshTo(accountPath(a.id, e), c);
          }
        }
      } catch {
        // the next pass tries again
      }
    }
  };
  refresher = setInterval(() => void pass(), 300_000);
  refresher.unref();
}

/**
 * Environment for an agent process and everything it starts: credentials come only from Harbor's
 * store. Not a sandbox, but gh, git, the Convex and Supabase CLIs no longer find the user's sign-ins.
 */
export async function agentEnv(): Promise<EnvVar[]> {
  keepFresh();
  return agentEnvNow();
}

export async function agentEnvNow(): Promise<EnvVar[]> {
  return agentEnvAs(true);
}

/** `signedIn` false: as if nothing were signed in (a chat commanded from another PC). */
export async function agentEnvAs(signedInHere: boolean): Promise<EnvVar[]> {
  const v: EnvVar[] = [];
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS", "CONVEX_DEPLOY_KEY", "VERCEL_TOKEN"]) v.push([k, undefined]);
  const set = (k: string, val: string): void => {
    v.push([k, val]);
  };
  const gh = signedInHere && ghToken() !== undefined;
  set("GH_CONFIG_DIR", gh ? ghDir() : ghOutDir());
  set("GIT_TERMINAL_PROMPT", "0");
  const helper = gh
    ? `!'${providers.which("gh") ?? "gh"}' auth git-credential`
    : "!f() { test \"$1\" = get && echo 'Harbor: GitHub is not signed in. Sign in under Settings > Integrations > Apps.' >&2; }; f";
  const git: [string, string][] = [
    ["credential.helper", ""],
    ["credential.https://github.com.helper", ""],
    ["credential.https://gist.github.com.helper", ""],
    ["credential.https://github.com.helper", helper],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  set("GIT_CONFIG_COUNT", String(git.length));
  git.forEach(([k, val], i) => {
    set(`GIT_CONFIG_KEY_${i}`, k);
    set(`GIT_CONFIG_VALUE_${i}`, val);
  });
  set("CONVEX_OVERRIDE_ACCESS_TOKEN", (signedInHere ? convexToken() : undefined) ?? "sign-in-to-convex-in-harbor");
  set("SUPABASE_ACCESS_TOKEN", (signedInHere ? await token("supabase") : undefined) ?? "sign-in-to-supabase-in-harbor");
  for (const a of APPS) {
    if (!signedInHere || a.mcp.kind !== "http") continue;
    const t = await token(a.id);
    if (t !== undefined) set(tokenVar(a.id), t);
  }
  return v;
}

function mcpServer(a: (typeof APPS)[number], tok: string): Json {
  const t = a.mcp;
  const au: Auth = a.auth;
  switch (t.kind) {
    case "http":
      return au.kind === "key" ? { type: "http", url: t.url, headers: { [au.header]: tok } } : { type: "http", url: t.url, headers: { Authorization: `Bearer ${tok}` } };
    case "stdio":
      return { type: "stdio", command: t.argv[0] ?? "", args: t.argv.slice(1), env: { CONVEX_OVERRIDE_ACCESS_TOKEN: tok } };
    case "harbor":
      return { type: "stdio", command: selfExe(), args: ["app", t.name] };
  }
}

export async function claudeServers(extra?: [string, Json]): Promise<Record<string, Json>> {
  const m: Record<string, Json> = {};
  for (const { local, def } of locals()) {
    if (def && !isOff(local.id) && !shadowed(local.id)) m[def[0]] = def[1];
  }
  for (const a of APPS) {
    const tok = await token(a.id);
    if (tok === undefined) continue;
    m[a.id] = mcpServer(a, tok);
  }
  if (extra) m[extra[0]] = extra[1];
  return m;
}

/** A local turn's grant on the bridge: stdio servers moved there start only when a tool is called (bridge.ts, lazy.ts). */
export interface Lazy {
  /** The grant's servers, filled here. */
  servers: Record<string, Json>;
  /** `http://127.0.0.1:<port>/<token>/`: a server's URL is this and its name. */
  base: string;
}

/**
 * Which entries go through the bridge: stdio servers whose entry needs nothing of Claude's own (no `${VAR}` it would
 * expand). With the apps off (a chat commanded from another PC) only Harbor's team server: the bridge starts servers
 * with this PC's sign-ins, which such a turn must not get.
 */
function lazyable(v: Json, apps: boolean): boolean {
  if (!isObject(v) || typeof v.command !== "string" || (v.type !== undefined && v.type !== "stdio")) return false;
  if (JSON.stringify(v).includes("${")) return false;
  if (apps) return true;
  const env = v.env;
  const args = Array.isArray(v.args) ? v.args : [];
  return isObject(env) && typeof env.HARBOR_SOCK === "string" && args.includes("mcp") && args.includes("--chat");
}

/**
 * Claude Code's `--mcp-config` file for a turn (with `--strict-mcp-config`): the local servers that are
 * on, the signed-in apps and `extra` (Harbor's team server). Written 0600, since it holds tokens.
 */
export async function claudeConfig(chatId: number, extra: [string, Json][], apps: boolean, lazy?: Lazy | null): Promise<string> {
  const m = await claudeServers();
  for (const [k, v] of extra) m[k] = v;
  if (!apps) {
    for (const k of Object.keys(m)) if (app(k) !== undefined && signedIn(k)) delete m[k];
  }
  // Harbor's own apps learn their chat: Discord shows a captcha its call hits in this chat.
  for (const [k, v] of Object.entries(m)) {
    if (app(k)?.mcp.kind === "harbor" && typeof v === "object" && v !== null && !Array.isArray(v)) m[k] = { ...v, env: { HARBOR_CHAT_ID: String(chatId) } };
  }
  if (lazy) {
    for (const [k, v] of Object.entries(m)) {
      if (!lazyable(v, apps)) continue;
      lazy.servers[k] = v;
      m[k] = { type: "http", url: `${lazy.base}${urlEncode(k)}` };
    }
  }
  const p = join(privateDir(join(dir(), "run")), `claude-${chatId}.json`);
  try {
    writePrivate(p, JSON.stringify({ mcpServers: m }));
  } catch {
    // the turn starts without the file and says so
  }
  return p;
}

/** A local Codex turn's grant on the bridge (as `Lazy`): Codex's config goes on its command line, so its URLs carry no token; Codex sends it from the environment variable `tokenVar`. */
export interface CodexLazy extends Lazy {
  tokenVar: string;
}

/** A TOML key: bare when it can be. */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/** A value as inline TOML (JSON strings are TOML basic strings), or null for one TOML can't hold. */
function tomlValue(v: unknown): string | null {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (Array.isArray(v)) {
    const items = v.map(tomlValue);
    return items.includes(null) ? null : `[${items.join(",")}]`;
  }
  if (isObject(v)) {
    const items = Object.entries(v).map(([k, x]) => [k, tomlValue(x)] as const);
    return items.some(([, x]) => x === null) ? null : `{${items.map(([k, x]) => `${tomlKey(k)}=${x}`).join(",")}}`;
  }
  return null;
}

/** The user's Codex servers: names as written, and the parsed entries (null when the file doesn't parse). */
function codexServers(): { names: string[]; defs: Record<string, Json> | null } {
  const codexHome = process.env.CODEX_HOME ?? join(home(), ".codex");
  let text = "";
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    // no codex config: nothing to turn off
  }
  try {
    const m = (Bun.TOML.parse(text) as { mcp_servers?: unknown }).mcp_servers;
    const defs = isObject(m) ? m : {};
    return { names: Object.keys(defs), defs };
  } catch {
    // read the section names alone
  }
  const names: string[] = [];
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (!t.startsWith("[mcp_servers.")) continue;
    const rest = t.slice("[mcp_servers.".length);
    let key: string;
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      key = end < 0 ? "" : rest.slice(1, end);
    } else {
      key = rest.split(/[.\]]/)[0] ?? "";
    }
    if (key !== "" && !names.includes(key)) names.push(key);
  }
  return { names, defs: null };
}

/** What a Codex stdio entry may hold besides its command line to be served by the bridge instead: settings that mean the same for a URL entry, copied over. */
const CODEX_KEEP = new Set(["tools", "enabled_tools", "disabled_tools", "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec", "default_tools_approval_mode", "default_tools_enabled", "supports_parallel_tool_calls", "required"]);
const CODEX_STDIO = new Set(["command", "args", "env", "enabled", "type"]);

/** A user's Codex stdio entry as the bridge's server, and what its URL entry keeps; null when the bridge can't run it as Codex would (its own folder, variables from Codex's environment, settings not known here). */
function codexLazyable(v: Json | undefined): { def: Json; keep: Record<string, Json> } | null {
  if (!isObject(v) || typeof v.command !== "string") return null;
  const args = v.args ?? [];
  const env = v.env ?? {};
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
  if (!isObject(env) || !Object.values(env).every((x) => typeof x === "string")) return null;
  const keep: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) {
    if (CODEX_STDIO.has(k)) continue;
    if (!CODEX_KEEP.has(k)) return null;
    keep[k] = x;
  }
  const def: Record<string, Json> = { type: "stdio", command: v.command, args };
  if (Object.keys(env).length > 0) def.env = env;
  return { def, keep };
}

/**
 * The name the bridge's entry takes in place of a user's server, since an override can't turn a stdio entry into a URL
 * one (Codex refuses both in one entry, and `-c` can't remove a key): the one with the same tool namespace (Codex makes
 * `Roblox Studio` `mcp__Roblox_Studio`), else the first letter's case flipped. Null when none is free.
 */
function codexTwin(name: string, taken: ReadonlySet<string>): string | null {
  const same = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const c = name.charAt(0);
  const flipped = c.toLowerCase() !== c.toUpperCase() ? `${c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()}${name.slice(1)}` : null;
  return [same !== name ? same : null, flipped].find((n): n is string => n !== null && /^[A-Za-z0-9_-]+$/.test(n) && !taken.has(n)) ?? null;
}

/**
 * Codex's `-c` overrides for a turn: the user's servers that are off (or that a signed-in app replaces) turned off,
 * the signed-in apps and `extra` (the team server) added. All in one `mcp_servers={…}`: Codex splits a dotted key at
 * every dot (`mcp_servers."Roblox Studio".enabled` names no server), and a later `mcp_servers=` replaces an earlier one.
 * With `lazy`, stdio servers go on the turn's bridge grant and start only when a tool is called, as for Claude.
 */
export async function codexArgs(chatId = 0, extra: [string, Json][] = [], lazy?: CodexLazy | null): Promise<string[]> {
  const user = codexServers();
  const m: Record<string, Json> = {};
  const signed: [(typeof APPS)[number], string][] = [];
  for (const a of APPS) {
    const tok = await token(a.id);
    if (tok !== undefined) signed.push([a, tok]);
  }
  const taken = new Set([...user.names, ...signed.map(([a]) => a.id), ...extra.map(([k]) => k)]);
  const userStdio = (k: string): boolean => user.names.includes(k) && !(isObject(user.defs?.[k]) && typeof (user.defs?.[k] as Record<string, Json>).url === "string");
  const url = (name: string, keep: Record<string, Json> = {}): Json => (lazy ? { ...keep, url: `${lazy.base}${urlEncode(name)}`, bearer_token_env_var: lazy.tokenVar, enabled: true } : {});
  for (const k of user.names) {
    const l = localFor(k);
    if (!(l && !isOff(l.id) && !shadowed(l.id))) {
      m[k] = { enabled: false };
      continue;
    }
    const lz = lazy ? codexLazyable(user.defs?.[k]) : null;
    const twin = lz ? codexTwin(k, taken) : null;
    if (!lazy || !lz || twin === null || tomlValue(lz.keep) === null) continue;
    taken.add(twin);
    lazy.servers[twin] = lz.def;
    m[k] = { enabled: false };
    m[twin] = url(twin, lz.keep);
  }
  const stdio = (k: string, v: Json): void => {
    // The bridge serves it unless the user's own entry of that name is a stdio one (a URL can't go on it).
    if (lazy && !userStdio(k) && isObject(v) && typeof v.command === "string") {
      lazy.servers[k] = v;
      m[k] = url(k);
      return;
    }
    if (!isObject(v)) return;
    const e: Record<string, Json> = { command: v.command ?? "", args: v.args ?? [] };
    if (isObject(v.env) && Object.keys(v.env).length > 0) e.env = v.env;
    if (Array.isArray(v.env_vars)) e.env_vars = v.env_vars;
    m[k] = { ...e, enabled: true };
  };
  for (const [a, tok] of signed) {
    const id = a.id;
    const t = a.mcp;
    switch (t.kind) {
      case "http":
        m[id] = a.auth.kind === "key" ? { url: t.url, env_http_headers: { [a.auth.header]: tokenVar(id) }, enabled: true } : { url: t.url, bearer_token_env_var: tokenVar(id), enabled: true };
        break;
      case "stdio":
        // On the bridge with its token (the grant is the turn's own, kept owner-only); on Codex's command line only the variable's name.
        if (lazy && !userStdio(id)) stdio(id, mcpServer(a, tok));
        else m[id] = { command: t.argv[0] ?? "", args: [...t.argv.slice(1)], env_vars: ["CONVEX_OVERRIDE_ACCESS_TOKEN"], enabled: true };
        break;
      case "harbor":
        // Harbor's own apps learn their chat, as in Claude's turns (Discord shows a captcha its call hits in this chat).
        stdio(id, { type: "stdio", command: selfExe(), args: ["app", t.name], ...(lazy ? { env: { HARBOR_CHAT_ID: String(chatId) } } : {}) });
        break;
    }
  }
  for (const [k, v] of extra) stdio(k, v);
  const all = tomlValue(m);
  return Object.keys(m).length === 0 || all === null ? [] : ["-c", `mcp_servers=${all}`];
}
