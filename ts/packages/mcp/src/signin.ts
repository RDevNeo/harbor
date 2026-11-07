import { rmSync } from "node:fs";
import { join } from "node:path";
import { home, now, single } from "@harbor/store";
import {
  type Client,
  type Cred,
  type Pending,
  accountPath,
  app,
  applyToken,
  blankCred,
  convexHome,
  convexToken,
  credPath,
  endpoints,
  ghDir,
  googleAccounts,
  googleBuiltinFromEnv,
  googleClient,
  googleWebFromEnv,
  integrations,
  loadAny,
  missingScopes,
  ownClient,
  pickClient,
  save,
  signOutAccount,
  signedIn,
  writePrivate,
} from "./apps.ts";
import { b64url, dec, form, enc, getJson, http, random, sha256 } from "./http.ts";
import { type Json, isObject } from "./json.ts";
import { providers } from "@harbor/agents";
import { openUrl } from "./sys.ts";

interface Flow {
  pending: Pending;
  abort: AbortController;
  child: { kill(): void } | undefined;
}

const FLOWS = new Map<string, Flow>();
const ERRORS = new Map<string, string>();

export function pending(id: string): Pending | undefined {
  const f = FLOWS.get(id);
  return f ? { ...f.pending } : undefined;
}

export function error(id: string): string | undefined {
  return ERRORS.get(id);
}

export function dismiss(id: string): void {
  ERRORS.delete(id);
}

export function cancel(id: string): void {
  const f = FLOWS.get(id);
  if (!f) return;
  FLOWS.delete(id);
  f.abort.abort();
  f.child?.kill();
}

export function signOut(id: string): void {
  cancel(id);
  const a = app(id);
  switch (a?.auth.kind) {
    case "github":
      rmSync(join(ghDir(), "hosts.yml"), { force: true });
      break;
    case "convex":
      rmSync(join(convexHome(), ".convex", "config.json"), { force: true });
      break;
    case "google": {
      for (const e of googleAccounts(id)) signOutAccount(id, e);
      const c = loadAny(id);
      if (c) {
        const own = ownClient({ id: c.client_id, secret: c.client_secret }, googleBuiltinFromEnv());
        if (own.id === "") rmSync(credPath(id), { force: true });
        else save(id, blankCred({ client_id: own.id, client_secret: own.secret }));
      }
      break;
    }
    case "discord":
      integrations.discord?.signOut();
      break;
    case "whatsapp":
      integrations.whatsapp?.signOut();
      break;
    default:
      rmSync(credPath(id), { force: true });
  }
}

export function signIn(id: string, changed: () => void = () => undefined): void {
  const a = app(id);
  if (!a || FLOWS.has(id)) return;
  const flow: Flow = { pending: {}, abort: new AbortController(), child: undefined };
  FLOWS.set(id, flow);
  ERRORS.delete(id);
  const update = (p: Pending): void => {
    if (FLOWS.get(id) === flow) flow.pending = p;
    changed();
  };
  const run = async (): Promise<void> => {
    switch (a.auth.kind) {
      case "github":
        return deviceLogin(id, flow, ghLoginCmd(), update);
      case "convex":
        return deviceLogin(id, flow, convexLoginCmd(), update);
      case "oauth":
        if (a.mcp.kind === "http") return oauthLogin(id, a.mcp.url, flow.abort.signal, update);
        throw new Error("This app signs in with a key.");
      case "google":
        return googleLogin(id, a.auth.scope, flow.abort.signal, update);
      case "discord": {
        const d = integrations.discord;
        if (!d) throw new Error("Discord isn't available here.");
        return d.login(flow.abort.signal, update);
      }
      case "whatsapp": {
        const w = integrations.whatsapp;
        if (!w) throw new Error("WhatsApp isn't available here.");
        return w.login(flow.abort.signal, update);
      }
      default:
        throw new Error("This app signs in with a key.");
    }
  };
  void run()
    .then(
      () => undefined,
      (e: unknown) => {
        if (!flow.abort.signal.aborted) ERRORS.set(id, e instanceof Error ? e.message : String(e));
      },
    )
    .finally(() => {
      if (!flow.abort.signal.aborted) FLOWS.delete(id);
      changed();
    });
}

/** WhatsApp's link by number: a code for the user to type on their phone, into the running link's card. */
export function whatsappCode(id: string, phone: string, changed: () => void = () => undefined): void {
  const w = integrations.whatsapp;
  if (!w) return;
  ERRORS.delete(id);
  void w
    .code(phone)
    .catch((e: unknown) => {
      ERRORS.set(id, e instanceof Error ? e.message : String(e));
    })
    .finally(changed);
}

interface Cmd {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
}

function ghLoginCmd(): Cmd {
  const d = ghDir();
  return {
    argv: [providers.which("gh") ?? "gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key", "--insecure-storage", "--scopes", "workflow"],
    env: { ...process.env, GH_CONFIG_DIR: d, GIT_CONFIG_GLOBAL: join(d, "gitconfig"), GH_BROWSER: "true", GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
  };
}

function convexLoginCmd(): Cmd {
  const h = convexHome();
  return {
    argv: ["npx", "-y", "convex@latest", "login", "--no-open", "--device-name", "Harbor", "--login-flow", "poll"],
    cwd: h,
    env: { ...process.env, HOME: h, npm_config_cache: join(home(), ".npm"), CONVEX_OVERRIDE_ACCESS_TOKEN: undefined, CONVEX_DEPLOY_KEY: undefined },
  };
}

async function eachLine(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf("\n");
    while (i >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  }
  if (buf !== "") onLine(buf);
}

async function deviceLogin(id: string, flow: Flow, cmd: Cmd, update: (p: Pending) => void): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...cmd.env, PATH: providers.childPath() })) if (v !== undefined) env[k] = v;
  const opts: { env: Record<string, string>; stdin: "ignore"; stdout: "pipe"; stderr: "pipe"; cwd?: string } = { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" };
  if (cmd.cwd !== undefined) opts.cwd = cmd.cwd;
  const child = Bun.spawn(cmd.argv, opts);
  flow.child = child;
  if (flow.abort.signal.aborted) child.kill();
  const p: Pending = {};
  const tail: string[] = [];
  const onLine = (line: string): void => {
    for (const raw of line.split(/\s+/)) {
      const w = raw.replace(/^[()[\]<>,;'"]+|[()[\]<>,;'"]+$/g, "").replace(/\.+$/, "");
      if (w.startsWith("https://") && p.url === undefined) {
        p.url = w;
        openUrl(w);
        update({ ...p });
      } else if (p.code === undefined && isCode(w)) {
        p.code = w;
        update({ ...p });
      }
    }
    if (line.trim() !== "") tail.push(line.trim());
  };
  await Promise.all([eachLine(child.stdout, onLine), eachLine(child.stderr, onLine)]);
  const code = await child.exited;
  flow.child = undefined;
  if (code === 0 && signedIn(id)) return;
  const hit = [...tail].reverse().find((l) => l.includes("rror") || l.includes("failed") || l.includes("expired")) ?? tail[tail.length - 1];
  throw new Error(hit ?? "Sign-in was cancelled.");
}

export function isCode(word: string): boolean {
  const w = word.replace(/^[()]+|[()]+$/g, "");
  return w.length === 9 && w[4] === "-" && Array.from(w).every((c, i) => i === 4 || /[A-Z0-9]/.test(c));
}

function originAndPath(url: string): [string, string] {
  const i = url.indexOf("://");
  const rest = i >= 0 ? url.slice(i + 3) : url;
  const scheme = i >= 0 ? url.slice(0, i) : "https";
  const j = rest.indexOf("/");
  const host = j >= 0 ? rest.slice(0, j) : rest;
  const path = j >= 0 ? rest.slice(j) : "";
  return [`${scheme}://${host}`, path.replace(/\/+$/, "")];
}

export function wellKnown(url: string, suffix: string): [string, string] {
  const [o, p] = originAndPath(url);
  return [`${o}/.well-known/${suffix}${p}`, `${o}/.well-known/${suffix}`];
}

function text(v: Json | undefined): string {
  return typeof v === "string" ? v : "";
}

async function firstJson(urls: string[]): Promise<Record<string, Json> | undefined> {
  for (const u of urls) {
    const v = await getJson(u);
    if (v) return v;
  }
  return undefined;
}

export async function oauthLogin(id: string, url: string, signal: AbortSignal, update: (p: Pending) => void): Promise<void> {
  const rm = (await firstJson(wellKnown(url, "oauth-protected-resource"))) ?? {};
  const servers = rm.authorization_servers;
  const first = Array.isArray(servers) ? servers[0] : undefined;
  const issuer = typeof first === "string" ? first : originAndPath(url)[0];
  const resource = typeof rm.resource === "string" ? rm.resource : url;
  const scopes = rm.scopes_supported;
  const scope = Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string").join(" ") : "";
  const meta = await firstJson([...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")]);
  if (!meta) throw new Error("The service has no OAuth metadata.");
  const authorize = text(meta.authorization_endpoint);
  const tokenEp = text(meta.token_endpoint);
  const register = text(meta.registration_endpoint);
  if (authorize === "" || tokenEp === "" || register === "") throw new Error("The service doesn't allow new apps to register.");
  const cb = listenCallback();
  try {
    const redirect = `${cb.base}callback`;
    const methods = meta.token_endpoint_auth_methods_supported;
    const publicClient = !Array.isArray(methods) || methods.includes("none");
    const reg = {
      client_name: "Harbor",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: publicClient ? "none" : "client_secret_post",
      scope,
    };
    const r = await http("POST", register, "application/json", JSON.stringify(reg));
    const clientId = isObject(r.body) ? text(r.body.client_id) : "";
    if (r.status < 200 || r.status >= 300 || clientId === "") {
      const b = isObject(r.body) ? r.body : {};
      throw new Error(`Registering Harbor failed (${r.status}): ${text(b.error_description) || text(b.error)}`);
    }
    const clientSecret = isObject(r.body) ? text(r.body.client_secret) : "";
    const verifier = b64url(random(32));
    const state = b64url(random(16));
    const q = form([
      ["response_type", "code"],
      ["client_id", clientId],
      ["redirect_uri", redirect],
      ["code_challenge", b64url(sha256(verifier))],
      ["code_challenge_method", "S256"],
      ["state", state],
      ["scope", scope],
      ["resource", resource],
    ]);
    const authUrl = `${authorize}${authorize.includes("?") ? "&" : "?"}${q}`;
    openUrl(authUrl);
    update({ url: authUrl });
    const code = await cb.wait("/callback", state, signal);
    const body = form([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", redirect],
      ["client_id", clientId],
      ["client_secret", clientSecret],
      ["code_verifier", verifier],
      ["resource", resource],
    ]);
    const t = await http("POST", tokenEp, "application/x-www-form-urlencoded", body);
    const c = blankCred({ client_id: clientId, client_secret: clientSecret, token_endpoint: tokenEp, resource });
    applyToken(c, t.status, t.body);
    save(id, c);
  } finally {
    cb.close();
  }
}

async function googleLogin(id: string, scope: string, signal: AbortSignal, update: (p: Pending) => void): Promise<void> {
  const client = googleDesktopClient(id);
  if (!client) throw new Error("Add your OAuth client first.");
  const cb = listenCallback();
  try {
    const redirect = cb.base;
    const verifier = b64url(random(32));
    const state = b64url(random(16));
    const authUrl = googleAuthUrl(client.id, redirect, scope, verifier, state);
    openUrl(authUrl);
    update({ url: authUrl });
    const code = await cb.wait("/", state, signal);
    await googleSaveCode(id, scope, client, code, redirect, verifier);
  } finally {
    cb.close();
  }
}

export function googleDesktopClient(id: string): Client | undefined {
  return pickClient(googleClient(id), googleBuiltinFromEnv());
}

export function googleWebClientId(): string | undefined {
  return googleWebFromEnv()?.id;
}

/**
 * A Google authorization code exchanged with `client` for tokens, checked and saved as one more
 * account (the same address replaces its older sign-in). `redirect` is "" for a phone's server code.
 */
export async function googleSaveCode(id: string, scope: string, client: Client, code: string, redirect: string, verifier: string): Promise<string> {
  const body = `${form([
    ["grant_type", "authorization_code"],
    ["code", code],
    ["client_id", client.id],
    ["client_secret", client.secret],
    ["code_verifier", verifier],
  ])}&redirect_uri=${enc(redirect)}`;
  const r = await http("POST", endpoints.googleToken, "application/x-www-form-urlencoded", body);
  const c: Cred = blankCred({ client_id: client.id, client_secret: client.secret, token_endpoint: endpoints.googleToken });
  applyToken(c, r.status, r.body);
  const granted = isObject(r.body) && typeof r.body.scope === "string" ? r.body.scope : undefined;
  if (missingScopes(scope, granted).some((s) => s.endsWith("gmail.modify"))) throw new Error("Google didn't grant access to the mail: sign in again and tick every box.");
  if (c.refresh_token === "") throw new Error("Google sent no refresh token: remove Harbor at myaccount.google.com/permissions and sign in again.");
  const profile = integrations.profileEmail;
  if (!profile) throw new Error("Gmail isn't available here.");
  c.account = await profile(c.access_token);
  c.added = now();
  writePrivate(accountPath(id, c.account), JSON.stringify(c, null, 2));
  return c.account;
}

interface PhoneFlow {
  verifier: string;
  redirect: string;
  client: Client;
  at: number;
}

const PHONE_FLOWS = new Map<string, PhoneFlow>();
const PHONE_TTL = 900_000;

export function phoneRedirectOk(r: string): boolean {
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/$/.exec(r);
  if (!m) return false;
  const n = Number(m[1]);
  return n > 0 && n <= 65535;
}

export function googleAuthUrl(clientId: string, redirect: string, scope: string, verifier: string, state: string): string {
  const q = form([
    ["response_type", "code"],
    ["client_id", clientId],
    ["redirect_uri", redirect],
    ["scope", scope],
    ["code_challenge", b64url(sha256(verifier))],
    ["code_challenge_method", "S256"],
    ["state", state],
    ["access_type", "offline"],
    ["prompt", "select_account consent"],
  ]);
  return `${endpoints.googleAuth}?${q}`;
}

function googleScope(id: string): string {
  const a = app(id)?.auth;
  if (a?.kind !== "google") throw new Error("not a Google app");
  return a.scope;
}

export function googlePhoneStart(id: string, redirect: string): [string, string] {
  const scope = googleScope(id);
  if (!phoneRedirectOk(redirect)) throw new Error("redirect_uri must be http://127.0.0.1:<port>/");
  const client = googleDesktopClient(id);
  if (!client) throw new Error("This PC's Harbor has no Google client: sign in on the PC first.");
  const verifier = b64url(random(32));
  const state = b64url(random(16));
  const url = googleAuthUrl(client.id, redirect, scope, verifier, state);
  const t = Date.now();
  for (const [k, f] of PHONE_FLOWS) if (t - f.at >= PHONE_TTL) PHONE_FLOWS.delete(k);
  PHONE_FLOWS.set(state, { verifier, redirect, client, at: t });
  return [url, state];
}

export async function googlePhoneFinish(id: string, state: string, code: string): Promise<string> {
  const scope = googleScope(id);
  const f = PHONE_FLOWS.get(state);
  PHONE_FLOWS.delete(state);
  if (!f || Date.now() - f.at >= PHONE_TTL) throw new Error("That sign-in expired: start again.");
  return googleSaveCode(id, scope, f.client, code, f.redirect, f.verifier);
}

export async function googlePhoneCode(id: string, code: string): Promise<string> {
  const scope = googleScope(id);
  const web = googleWebFromEnv();
  if (!web) throw new Error("This PC's Harbor can't take a code from the phone's account sheet.");
  return googleSaveCode(id, scope, web, code, "", "");
}

export interface Callback {
  base: string;
  wait(want: string, state: string, signal: AbortSignal): Promise<string>;
  close(): void;
}

export function callbackPage(ok: boolean, error: string): string {
  const esc = (t: string): string => t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const title = ok ? "You're signed in" : "Sign-in didn't finish";
  const line = ok ? "Harbor is back in front. You can close this tab." : error === "" ? "Go back to Harbor and try again." : `${esc(error)}. Go back to Harbor and try again.`;
  const mark = ok ? "&#10003;" : "!";
  const mk = ok ? "#0070f3" : "#e5484d";
  const close = ok ? 600 : 600000;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harbor</title>
<style>
:root{--bg:#fafafa;--card:#fff;--fg:#171717;--sub:#737373;--border:#e5e5e5;--mark:${mk};--markfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#171717;--fg:#ededed;--sub:#a1a1a1;--border:#2e2e2e;--markfg:#0a0a0a}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.5 Geist,"Geist Sans",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:32px 36px;max-width:380px;width:calc(100% - 32px);text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.mark{width:40px;height:40px;border-radius:999px;background:var(--mark);color:var(--markfg);display:inline-flex;align-items:center;justify-content:center;font-size:20px;font-weight:600}
.brand{font-weight:600;letter-spacing:-.01em;color:var(--sub);margin:14px 0 2px}
h1{font-size:20px;letter-spacing:-.02em;margin:0 0 6px}p{margin:0;color:var(--sub)}
</style>
<div class="card"><div class="mark">${mark}</div><div class="brand">Harbor</div><h1>${title}</h1><p>${line}</p></div>
<script>setTimeout(function(){window.close()},${close})</script>
</html>`;
}

interface Waiter {
  want: string;
  state: string;
  resolve(code: string): void;
  reject(e: Error): void;
}

export function listenCallback(): Callback {
  let waiter: Waiter | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const w = waiter;
      if (url.search === "" || !w || url.pathname !== w.want) return new Response(null, { status: 404, headers: { Connection: "close" } });
      const params = new Map<string, string>();
      for (const kv of url.search.slice(1).split("&")) {
        const i = kv.indexOf("=");
        if (i > 0) params.set(dec(kv.slice(0, i)), dec(kv.slice(i + 1)));
      }
      const ok = params.get("state") === w.state && params.has("code");
      const err = params.get("error_description") ?? params.get("error") ?? "";
      void single.focusRunning().catch(() => false);
      waiter = undefined;
      if (ok) w.resolve(params.get("code") ?? "");
      else w.reject(new Error(`Sign-in failed: ${err === "" ? "state mismatch" : err}`));
      return new Response(callbackPage(ok, err), { headers: { "Content-Type": "text/html; charset=utf-8", Connection: "close" } });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}/`,
    wait(want, state, signal) {
      return new Promise<string>((resolve, reject) => {
        const done = (f: () => void): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          waiter = undefined;
          f();
        };
        const onAbort = (): void => done(() => reject(new Error("Sign-in was cancelled.")));
        const timer = setTimeout(() => done(() => reject(new Error("Sign-in timed out."))), 600_000);
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort);
        waiter = { want, state, resolve: (c) => done(() => resolve(c)), reject: (e) => done(() => reject(e)) };
      });
    },
    close() {
      void server.stop(true);
    },
  };
}
