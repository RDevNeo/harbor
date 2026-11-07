import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir, now, privateDir as privateDirAt, writePrivate as writePrivateAt } from "@harbor/store";
import { form, http } from "./http.ts";
import { type Json, isObject, parseJson, parseObject } from "./json.ts";

export interface Local {
  id: string;
  label: string;
}

export const LOCAL: readonly Local[] = [
  { id: "discord", label: "Discord" },
  { id: "robloxstudio", label: "Roblox Studio" },
  { id: "omarchy", label: "Omarchy" },
  { id: "blender", label: "Blender" },
  { id: "playwright", label: "Playwright" },
];

export type Auth =
  | { kind: "github" }
  | { kind: "convex" }
  | { kind: "oauth" }
  | { kind: "key"; header: string; get: string }
  | { kind: "google"; scope: string; help: string }
  | { kind: "discord" }
  | { kind: "whatsapp" };

export type Transport = { kind: "http"; url: string } | { kind: "stdio"; argv: readonly string[] } | { kind: "harbor"; name: string };

export interface App {
  id: string;
  label: string;
  about: string;
  auth: Auth;
  mcp: Transport;
}

export const GMAIL = "gmail";
export const DISCORD = "discord";
export const WHATSAPP = "whatsapp";

export const APPS: readonly App[] = [
  { id: "github", label: "GitHub", about: "Repos, issues, PRs; gh and git push", auth: { kind: "github" }, mcp: { kind: "http", url: "https://api.githubcopilot.com/mcp/" } },
  { id: "vercel", label: "Vercel", about: "Projects, deployments, logs, docs", auth: { kind: "oauth" }, mcp: { kind: "http", url: "https://mcp.vercel.com" } },
  { id: "linear", label: "Linear", about: "Issues, projects, cycles", auth: { kind: "oauth" }, mcp: { kind: "http", url: "https://mcp.linear.app/mcp" } },
  { id: "sentry", label: "Sentry", about: "Errors, traces, releases", auth: { kind: "oauth" }, mcp: { kind: "http", url: "https://mcp.sentry.dev/mcp" } },
  { id: "supabase", label: "Supabase", about: "Database, auth, edge functions", auth: { kind: "oauth" }, mcp: { kind: "http", url: "https://mcp.supabase.com/mcp" } },
  {
    id: "context7",
    label: "Context7",
    about: "Up-to-date library docs",
    auth: { kind: "key", header: "CONTEXT7_API_KEY", get: "https://context7.com/dashboard" },
    mcp: { kind: "http", url: "https://mcp.context7.com/mcp" },
  },
  { id: "convex", label: "Convex", about: "Deployments, data and the convex CLI", auth: { kind: "convex" }, mcp: { kind: "stdio", argv: ["npx", "-y", "convex@latest", "mcp", "start"] } },
  {
    id: GMAIL,
    label: "Gmail",
    about: "Read, send and sort your mail",
    auth: {
      kind: "google",
      scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic",
      help: "https://console.cloud.google.com/apis/credentials",
    },
    mcp: { kind: "harbor", name: GMAIL },
  },
  { id: DISCORD, label: "Discord", about: "Read and send as you", auth: { kind: "discord" }, mcp: { kind: "harbor", name: DISCORD } },
  { id: WHATSAPP, label: "WhatsApp", about: "Read and send as you", auth: { kind: "whatsapp" }, mcp: { kind: "harbor", name: WHATSAPP } },
];

export function app(id: string): App | undefined {
  return APPS.find((a) => a.id === id);
}

export function norm(s: string): string {
  return Array.from(s)
    .filter((c) => /[A-Za-z0-9]/.test(c))
    .join("")
    .toLowerCase();
}

export function localFor(name: string): Local | undefined {
  const n = norm(name);
  return LOCAL.find((l) => n.startsWith(l.id));
}

export interface Integrations {
  discord?: { signedIn(): boolean; accountName(): string | undefined; signOut(): void; login(signal: AbortSignal, update: (p: Pending) => void): Promise<void> };
  whatsapp?: { signedIn(): boolean; accountName(): string | undefined; signOut(): void; login(signal: AbortSignal, update: (p: Pending) => void): Promise<void>; code(phone: string): Promise<void> };
  profileEmail?: (token: string) => Promise<string>;
}

export const integrations: Integrations = {};

export function integrate(i: Integrations): void {
  Object.assign(integrations, i);
}

export interface Pending {
  code?: string;
  url?: string;
  qr?: string;
  note?: string;
  window?: boolean;
}

export const endpoints = {
  googleAuth: "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: "https://oauth2.googleapis.com/token",
  googleRevoke: "https://oauth2.googleapis.com/revoke",
};

export function privateDir(p: string): string {
  return privateDirAt(p);
}

export function dir(): string {
  return privateDir(join(dataDir(), "apps"));
}

export function writePrivate(p: string, data: string): void {
  writePrivateAt(p, data);
}

export function ghDir(): string {
  return privateDir(join(dir(), "github"));
}

export function ghOutDir(): string {
  const d = privateDir(join(dir(), "github-signed-out"));
  const hosts = join(d, "hosts.yml");
  if (!existsSync(hosts)) writePrivate(hosts, "github.com:\n    oauth_token: sign-in-to-github-in-harbor\n    git_protocol: https\n    user: harbor\n");
  return d;
}

export function convexHome(): string {
  return privateDir(join(dir(), "convex"));
}

export interface Cred {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  client_id: string;
  client_secret: string;
  token_endpoint: string;
  resource: string;
  account: string;
  added: number;
}

export function blankCred(over: Partial<Cred> = {}): Cred {
  return { access_token: "", refresh_token: "", expires_at: 0, client_id: "", client_secret: "", token_endpoint: "", resource: "", account: "", added: 0, ...over };
}

function readCred(text: string): Cred | undefined {
  const o = parseObject(text);
  if (!o || typeof o.access_token !== "string") return undefined;
  const s = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const n = (k: string): number => (typeof o[k] === "number" ? (o[k] as number) : 0);
  return {
    access_token: o.access_token,
    refresh_token: s("refresh_token"),
    expires_at: n("expires_at"),
    client_id: s("client_id"),
    client_secret: s("client_secret"),
    token_endpoint: s("token_endpoint"),
    resource: s("resource"),
    account: s("account"),
    added: n("added"),
  };
}

function readFile(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function credText(c: Cred): string {
  return JSON.stringify(c, null, 2);
}

export function credPath(id: string): string {
  return join(dir(), `${id}.json`);
}

export function load(id: string): Cred | undefined {
  const c = loadAny(id);
  return c && c.access_token !== "" ? c : undefined;
}

/** Also a Google client saved before its sign-in finished. */
export function loadAny(id: string): Cred | undefined {
  const t = readFile(credPath(id));
  return t === undefined ? undefined : readCred(t);
}

export function save(id: string, c: Cred): void {
  writePrivate(credPath(id), credText(c));
}

export function ghToken(): string | undefined {
  return hostsField("oauth_token:");
}

function hostsField(prefix: string): string | undefined {
  const text = readFile(join(ghDir(), "hosts.yml"));
  if (text === undefined) return undefined;
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (t.startsWith(prefix)) {
      const v = t.slice(prefix.length).trim();
      return v === "" ? undefined : v;
    }
  }
  return undefined;
}

export function convexToken(): string | undefined {
  const text = readFile(join(convexHome(), ".convex", "config.json"));
  if (text === undefined) return undefined;
  const v = parseObject(text);
  const t = v?.accessToken;
  return typeof t === "string" && t !== "" ? t : undefined;
}

export function signedIn(id: string): boolean {
  switch (app(id)?.auth.kind) {
    case "github":
      return ghToken() !== undefined;
    case "convex":
      return convexToken() !== undefined;
    case "google":
      return googleAccounts(id).length > 0;
    case "discord":
      return integrations.discord?.signedIn() ?? false;
    case "whatsapp":
      return integrations.whatsapp?.signedIn() ?? false;
    case undefined:
      return false;
    default:
      return load(id) !== undefined;
  }
}

export function githubUser(): string | undefined {
  return hostsField("user:");
}

export function account(id: string): string | undefined {
  switch (app(id)?.auth.kind) {
    case "github":
      return githubUser();
    case "google":
      return googleAccounts(id)[0];
    case "discord":
      return integrations.discord?.accountName();
    case "whatsapp":
      return integrations.whatsapp?.accountName();
    case undefined:
      return undefined;
    default: {
      const a = load(id)?.account;
      return a ? a : undefined;
    }
  }
}

export async function token(id: string): Promise<string | undefined> {
  const a = app(id);
  if (!a) return undefined;
  switch (a.auth.kind) {
    case "github":
      return ghToken();
    case "convex":
      return convexToken();
    case "key":
      return load(id)?.access_token;
    case "oauth":
      return freshToken(id, false);
    case "google": {
      const first = googleAccounts(id)[0];
      return first === undefined ? undefined : loadAccount(id, first)?.access_token;
    }
    case "discord":
      return integrations.discord?.signedIn() ? "" : undefined;
    case "whatsapp":
      return integrations.whatsapp?.signedIn() ? "" : undefined;
  }
}

export async function freshToken(id: string, force: boolean): Promise<string | undefined> {
  const c = load(id);
  if (!c) return undefined;
  if (force || (c.expires_at > 0 && now() > c.expires_at - 120)) {
    try {
      return (await refresh(id, c)).access_token;
    } catch {
      return undefined;
    }
  }
  return c.access_token;
}

export async function freshTokenFor(id: string, email: string, force: boolean): Promise<string | undefined> {
  const c = loadAccount(id, email);
  if (!c) return undefined;
  if (force || (c.expires_at > 0 && now() > c.expires_at - 120)) {
    try {
      return (await refreshTo(accountPath(id, email), c)).access_token;
    } catch {
      return undefined;
    }
  }
  return c.access_token;
}

export function saveKey(id: string, key: string): void {
  save(id, blankCred({ access_token: key.trim() }));
}

export interface Client {
  id: string;
  secret: string;
}

export type Builtin = Client | undefined;

// Harbor's own Google OAuth clients, baked into a release build (scripts/build.ts defines them from
// the build's environment, as release.yml passes its secrets): the Desktop one for the Gmail app's
// one-click sign-in, the Web one a phone gets its codes for. The environment at run time still wins.
declare const HARBOR_GOOGLE_CLIENT_ID: string | undefined;
declare const HARBOR_GOOGLE_CLIENT_SECRET: string | undefined;
declare const HARBOR_GOOGLE_WEB_CLIENT_ID: string | undefined;
declare const HARBOR_GOOGLE_WEB_CLIENT_SECRET: string | undefined;
const baked = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const BAKED_GOOGLE = {
  id: typeof HARBOR_GOOGLE_CLIENT_ID === "undefined" ? undefined : baked(HARBOR_GOOGLE_CLIENT_ID),
  secret: typeof HARBOR_GOOGLE_CLIENT_SECRET === "undefined" ? undefined : baked(HARBOR_GOOGLE_CLIENT_SECRET),
  webId: typeof HARBOR_GOOGLE_WEB_CLIENT_ID === "undefined" ? undefined : baked(HARBOR_GOOGLE_WEB_CLIENT_ID),
  webSecret: typeof HARBOR_GOOGLE_WEB_CLIENT_SECRET === "undefined" ? undefined : baked(HARBOR_GOOGLE_WEB_CLIENT_SECRET),
};

export function googleBuiltinFromEnv(env: Record<string, string | undefined> = process.env, built: Partial<typeof BAKED_GOOGLE> = BAKED_GOOGLE): Builtin {
  const id = env.HARBOR_GOOGLE_CLIENT_ID || built.id;
  const secret = env.HARBOR_GOOGLE_CLIENT_SECRET || built.secret;
  return id && secret ? { id, secret } : undefined;
}

export function googleWebFromEnv(env: Record<string, string | undefined> = process.env, built: Partial<typeof BAKED_GOOGLE> = BAKED_GOOGLE): Builtin {
  const id = env.HARBOR_GOOGLE_WEB_CLIENT_ID || built.webId;
  const secret = env.HARBOR_GOOGLE_WEB_CLIENT_SECRET || built.webSecret;
  return id && secret ? { id, secret } : undefined;
}

export function googleBuiltin(): boolean {
  return googleBuiltinFromEnv() !== undefined;
}

export function googleClient(id: string): Client {
  const c = loadAny(id);
  return ownClient({ id: c?.client_id ?? "", secret: c?.client_secret ?? "" }, googleBuiltinFromEnv());
}

/** A stored client, unless it is the built-in one (a sign-in with it stores it too). */
export function ownClient(c: Client, builtin: Builtin): Client {
  return builtin && builtin.id === c.id ? { id: "", secret: "" } : c;
}

export function pickClient(own: Client, builtin: Builtin): Client | undefined {
  if (own.id !== "") return own;
  return builtin ? { id: builtin.id, secret: builtin.secret } : undefined;
}

export function forgetGoogleClient(id: string): void {
  if (!load(id)) rmSync(credPath(id), { force: true });
}

export function saveGoogleClient(id: string, clientId: string, secret: string): void {
  const c = parseGoogleClient(clientId, secret);
  if (!c) throw new Error("Paste the client ID and secret of a Desktop app OAuth client.");
  save(id, blankCred({ client_id: c.id, client_secret: c.secret }));
}

export function validGoogleClient(clientId: string, secret: string): boolean {
  return parseGoogleClient(clientId, secret) !== undefined;
}

export function parseGoogleClient(clientId: string, secret: string): Client | undefined {
  let cid: string;
  let sec: string;
  const v = parseJson(clientId.trim());
  if (v !== undefined && isObject(v)) {
    const inner = v.installed;
    const c = isObject(inner) ? inner : v.web;
    if (!isObject(c) || typeof c.client_id !== "string") return undefined;
    cid = c.client_id;
    sec = typeof c.client_secret === "string" ? c.client_secret : secret;
  } else {
    cid = clientId.trim();
    sec = secret.trim();
  }
  return cid.endsWith(".apps.googleusercontent.com") && sec.trim() !== "" ? { id: cid, secret: sec.trim() } : undefined;
}

export function accountsDirIn(base: string, id: string): string {
  return join(base, `${id}.accounts`);
}

export function accountFile(email: string): string {
  const e = Array.from(email.trim().toLowerCase())
    .map((c) => (/[A-Za-z0-9]/.test(c) || "@._+-".includes(c) ? c : "_"))
    .join("");
  return `${e}.json`;
}

export function accountPath(id: string, email: string): string {
  return join(privateDir(accountsDirIn(dir(), id)), accountFile(email));
}

export function loadAccount(id: string, email: string): Cred | undefined {
  const t = readFile(accountPath(id, email));
  const c = t === undefined ? undefined : readCred(t);
  return c && c.access_token !== "" ? c : undefined;
}

/** Moves a single sign-in from before several accounts into `<id>.accounts/`; `<id>.json` keeps the user's own client, if any. */
export function migrateIn(base: string, id: string, builtin: Builtin): void {
  const old = join(base, `${id}.json`);
  const t = readFile(old);
  const c = t === undefined ? undefined : readCred(t);
  if (!c || c.access_token === "") return;
  if (c.account === "") c.account = "unknown";
  if (c.added === 0) c.added = now();
  const d = privateDir(accountsDirIn(base, id));
  try {
    writePrivate(join(d, accountFile(c.account)), credText(c));
  } catch {
    return;
  }
  const own = ownClient({ id: c.client_id, secret: c.client_secret }, builtin);
  if (own.id === "") rmSync(old, { force: true });
  else writePrivate(old, credText(blankCred({ client_id: own.id, client_secret: own.secret })));
}

export function accountsIn(base: string, id: string): Cred[] {
  const d = accountsDirIn(base, id);
  let names: string[] = [];
  try {
    names = readdirSync(d).filter((n) => n.endsWith(".json"));
  } catch {
    // no accounts folder yet
  }
  const v: Cred[] = [];
  for (const n of names) {
    const t = readFile(join(d, n));
    const c = t === undefined ? undefined : readCred(t);
    if (c && c.access_token !== "" && c.account !== "") v.push(c);
  }
  const def = (readFile(join(d, "default")) ?? "").trim().toLowerCase();
  const key = (c: Cred): [number, number, string] => [c.account.toLowerCase() !== def ? 1 : 0, c.added, c.account.toLowerCase()];
  return v.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  });
}

export function googleAccounts(id: string): string[] {
  const base = dir();
  migrateIn(base, id, googleBuiltinFromEnv());
  return accountsIn(base, id).map((c) => c.account);
}

export function setGoogleDefault(id: string, email: string): void {
  writePrivate(join(privateDir(accountsDirIn(dir(), id)), "default"), email.trim());
}

export function signOutAccount(id: string, email: string): void {
  const p = accountPath(id, email);
  const t = readFile(p);
  const c = t === undefined ? undefined : readCred(t);
  if (c) {
    const tok = c.refresh_token === "" ? c.access_token : c.refresh_token;
    if (tok !== "") void http("POST", endpoints.googleRevoke, "application/x-www-form-urlencoded", form([["token", tok]])).catch(() => undefined);
  }
  rmSync(p, { force: true });
  const def = join(accountsDirIn(dir(), id), "default");
  const cur = readFile(def);
  if (cur !== undefined && cur.trim().toLowerCase() === email.trim().toLowerCase()) rmSync(def, { force: true });
}

export function applyToken(c: Cred, status: number, t: Json): void {
  const o = isObject(t) ? t : {};
  const access = typeof o.access_token === "string" ? o.access_token : "";
  if (status < 200 || status >= 300 || access === "") {
    const why = typeof o.error_description === "string" ? o.error_description : typeof o.error === "string" ? o.error : "";
    throw new Error(`Sign-in failed (${status}): ${why}`);
  }
  c.access_token = access;
  if (typeof o.refresh_token === "string") c.refresh_token = o.refresh_token;
  c.expires_at = typeof o.expires_in === "number" ? now() + Math.trunc(o.expires_in) : 0;
}

export async function refresh(id: string, c: Cred): Promise<Cred> {
  return refreshTo(credPath(id), c);
}

export async function refreshTo(path: string, c: Cred): Promise<Cred> {
  if (c.refresh_token === "") throw new Error("expired");
  const body = form([
    ["grant_type", "refresh_token"],
    ["refresh_token", c.refresh_token],
    ["client_id", c.client_id],
    ["client_secret", c.client_secret],
    ["resource", c.resource],
  ]);
  const r = await http("POST", c.token_endpoint, "application/x-www-form-urlencoded", body);
  const n = { ...c };
  applyToken(n, r.status, r.body);
  writePrivate(path, credText(n));
  return n;
}

export function missingScopes(asked: string, granted: string | undefined): string[] {
  if (granted === undefined) return [];
  const g = granted.split(/\s+/).filter(Boolean);
  return asked.split(/\s+/).filter((s) => s !== "" && !g.includes(s));
}

export function offPath(): string {
  return join(dir(), "mcp-off.json");
}

function offList(): string[] {
  const t = readFile(offPath());
  const v = t === undefined ? undefined : parseJson(t);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function isOff(id: string): boolean {
  return offList().includes(id);
}

export function toggleOff(id: string): void {
  const list = offList();
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  writePrivate(offPath(), JSON.stringify(next));
}
