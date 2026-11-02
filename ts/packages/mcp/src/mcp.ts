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

/**
 * Claude Code's `--mcp-config` file for a turn (with `--strict-mcp-config`): the local servers that are
 * on, the signed-in apps and `extra` (Harbor's team server). Written 0600, since it holds tokens.
 */
export async function claudeConfig(chatId: number, extra: [string, Json][], apps: boolean): Promise<string> {
  const m = await claudeServers();
  for (const [k, v] of extra) m[k] = v;
  if (!apps) {
    for (const k of Object.keys(m)) if (app(k) !== undefined && signedIn(k)) delete m[k];
  }
  const p = join(privateDir(join(dir(), "run")), `claude-${chatId}.json`);
  try {
    writePrivate(p, JSON.stringify({ mcpServers: m }));
  } catch {
    // the turn starts without the file and says so
  }
  return p;
}

const quote = (s: string): string => JSON.stringify(s);

export async function codexArgs(): Promise<string[]> {
  const codexHome = process.env.CODEX_HOME ?? join(home(), ".codex");
  let text = "";
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    // no codex config: nothing to turn off
  }
  const keys: string[] = [];
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (!t.startsWith("[mcp_servers.")) continue;
    const rest = t.slice("[mcp_servers.".length);
    let key: string;
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      key = end < 0 ? "" : `"${rest.slice(1, end)}"`;
    } else {
      key = rest.split(/[.\]]/)[0] ?? "";
    }
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  const v: string[] = [];
  const c = (s: string): void => {
    v.push("-c", s);
  };
  for (const k of keys) {
    const l = localFor(k.replace(/^"+|"+$/g, ""));
    if (!(l && !isOff(l.id) && !shadowed(l.id))) c(`mcp_servers.${k}.enabled=false`);
  }
  for (const a of APPS) {
    if ((await token(a.id)) === undefined) continue;
    const id = a.id;
    const t = a.mcp;
    switch (t.kind) {
      case "http":
        c(`mcp_servers.${id}.url=${quote(t.url)}`);
        if (a.auth.kind === "key") c(`mcp_servers.${id}.env_http_headers={${a.auth.header}=${quote(tokenVar(id))}}`);
        else c(`mcp_servers.${id}.bearer_token_env_var=${quote(tokenVar(id))}`);
        break;
      case "stdio":
        c(`mcp_servers.${id}.command=${quote(t.argv[0] ?? "")}`);
        c(`mcp_servers.${id}.args=[${t.argv.slice(1).map(quote).join(",")}]`);
        c(`mcp_servers.${id}.env_vars=["CONVEX_OVERRIDE_ACCESS_TOKEN"]`);
        break;
      case "harbor":
        c(`mcp_servers.${id}.command=${quote(selfExe())}`);
        c(`mcp_servers.${id}.args=["app",${quote(t.name)}]`);
        break;
    }
    c(`mcp_servers.${id}.enabled=true`);
  }
  return v;
}
