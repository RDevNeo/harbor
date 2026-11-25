// A Gmail connection (Creators), ported from Person Hub's shell/gmail.cjs: Google's desktop OAuth
// with PKCE and a loopback redirect, offline access (refresh token), the Gmail REST API for threads,
// messages, attachments and sending with In-Reply-To/References, the history API for new mail, and
// Google contacts (People API) / Gravatar for a person's name and photo.
// Files in ctx.dir (Person Hub's names, so the migrated ones keep working): google-client.json (the
// OAuth client; Hub's own Google desktop client when it's missing), gmail-account[-<id>].json (the
// refresh token, 0600; Electron-sealed ones can't be opened here, so those sign in again),
// gmail-cache[-<id>].json, attachments under files/<id>/. Access tokens stay in memory. Never log a
// token, a header or a message body.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivate } from "@harbor/store";
import type { ChannelUser, ConnState, ConnStatus, Conversation, LookupResult, OutgoingFile, SendResult } from "../model/types.ts";
import * as core from "./gmail-core.ts";
import type { Email } from "./gmail-core.ts";
import type { ConnContext, Connection } from "./types.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
// contacts: names and photos for the "add by email" lookup; sessions from before keep working without
// them (the UI offers a reconnect)
const CONTACTS = ["https://www.googleapis.com/auth/contacts.other.readonly", "https://www.googleapis.com/auth/contacts.readonly"];
const SCOPE = ["https://www.googleapis.com/auth/gmail.modify", "openid", "email", ...CONTACTS].join(" ");
const PEOPLE = "https://people.googleapis.com/v1";
const POLL_MS = 45_000;
const KEEP = 200;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
const statusOf = (e: unknown): number => (e instanceof ApiError ? e.status : -1);

export interface GoogleClient {
  id: string;
  secret: string;
}

export interface GmailOptions {
  fetch?: typeof fetch;
  /** Hub's Google desktop client (when google-client.json is missing). */
  hubClient?: () => Promise<GoogleClient | undefined>;
}

/** Hub's own Google desktop client, as Hub's Gmail sign-in picks it (Settings' client, else the built-in one). */
async function hubGoogleClient(): Promise<GoogleClient | undefined> {
  const { apps } = await import("@harbor/mcp");
  return apps.pickClient(apps.googleClient("gmail"), apps.googleBuiltinFromEnv());
}

async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export function createGmail(ctx: ConnContext, opts: GmailOptions = {}): Connection {
  const { id } = ctx;
  const http = opts.fetch ?? fetch;
  const log = (...a: unknown[]): void => ctx.log(`gmail[${id}]:`, ...a);
  const sfx = core.fileSuffix(id);
  const CLIENT_FILE = join(ctx.dir, "google-client.json");
  const ACCOUNT_FILE = join(ctx.dir, `gmail-account${sfx}.json`);
  const CACHE_FILE = join(ctx.dir, `gmail-cache${sfx}.json`);
  const FILES = join(ctx.dir, "files", core.safeFileName(id, "gmail"));

  let status: ConnStatus = "starting";
  let me: string | null = null;
  let error: string | null = null;
  let refresh: string | null = null;
  let access: string | null = null;
  let accessExp = 0;
  let historyId: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let flow: { abort: AbortController } | null = null;
  let scopes = "";
  let stopped = false;
  const hasContacts = (): boolean => CONTACTS.some((c) => scopes.includes(c));
  const tracked = new Set<string>();
  const convos = new Map<string, Email[]>();
  try {
    const c = obj(JSON.parse(readFileSync(CACHE_FILE, "utf8")));
    for (const [k, v] of Object.entries(obj(c.conversations))) {
      const m = obj(v).messages;
      if (Array.isArray(m)) convos.set(k, (m as Email[]).slice(-KEEP));
    }
  } catch {
    // none yet
  }

  async function client(): Promise<GoogleClient | undefined> {
    try {
      const c = obj(JSON.parse(await readFile(CLIENT_FILE, "utf8")));
      if (typeof c.client_id === "string" && c.client_id && typeof c.client_secret === "string" && c.client_secret) return { id: c.client_id, secret: c.client_secret };
    } catch {
      // missing: Hub's own
    }
    try {
      return await (opts.hubClient ?? hubGoogleClient)();
    } catch (e) {
      log("no Google client:", msg(e));
      return undefined;
    }
  }

  const state = (): ConnState => ({
    status,
    me: me ? { id: me, username: me, globalName: me, avatar: null, avatarUrl: "" } : null,
    gateway: status === "connected" ? "up" : "down",
    error,
    contacts: hasContacts(),
    upgrading: !!flow && status === "connected",
  });
  let lastState = "";
  const pushState = (): void => {
    const s = state();
    const k = JSON.stringify(s);
    if (k !== lastState) {
      lastState = k;
      ctx.emit({ type: "state", state: s });
    }
  };
  const setStatus = (s: ConnStatus, err: string | null = null): void => {
    status = s;
    error = err;
    pushState();
  };

  // ---------- token storage ----------
  function saveAccount(): void {
    if (!me || !refresh) return;
    writePrivate(ACCOUNT_FILE, core.accountJson(me, refresh, historyId, scopes));
  }
  async function loadAccount(): Promise<boolean> {
    let j: unknown;
    try {
      j = JSON.parse(await readFile(ACCOUNT_FILE, "utf8"));
    } catch {
      return false;
    }
    const a = core.readAccount(j);
    if (a.kind === "sealed") {
      log("the saved session is sealed by Person Hub's Electron: sign in again");
      error = `Sign in to Gmail again (${a.me}): this session can't be read here`;
      return false;
    }
    if (a.kind !== "ok") return false;
    refresh = a.refresh;
    me = a.me;
    historyId = a.historyId;
    scopes = a.scopes;
    return true;
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  async function writeCache(): Promise<void> {
    const conversations: Record<string, Conversation> = {};
    for (const [k, v] of convos) if (tracked.has(k)) conversations[k] = { channelId: null, messages: v.slice(-KEEP) };
    try {
      await writeAtomic(CACHE_FILE, JSON.stringify({ version: 1, conversations }));
    } catch (e) {
      log("cache write failed", msg(e));
    }
  }
  function saveCache(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void writeCache();
    }, 1500);
  }

  // ---------- OAuth ----------
  async function tokenRequest(params: Record<string, string>): Promise<Json> {
    const res = await http(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30_000) });
    const j = obj(await res.json().catch(() => ({})));
    if (!res.ok) {
      const code = typeof j.error === "string" ? j.error : undefined;
      throw new ApiError(String(j.error_description || code || `Google answered HTTP ${res.status}`), res.status, code);
    }
    return j;
  }
  async function accessToken(): Promise<string> {
    if (access && Date.now() < accessExp - 60_000) return access;
    const c = await client();
    if (!c || !refresh) throw new ApiError("Connect Gmail first", 0);
    try {
      const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh, client_id: c.id, client_secret: c.secret });
      access = String(j.access_token ?? "");
      accessExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
      return access;
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_grant") await forget("Google signed this session out: connect Gmail again");
      else if (e instanceof ApiError && (e.code === "unauthorized_client" || e.code === "invalid_client")) {
        // a session made with another OAuth client (google-client.json missing): sign in again with Hub's
        stopPolling();
        refresh = null;
        access = null;
        setStatus("signed-out", "Sign in to Gmail again");
      }
      throw e;
    }
  }

  // ---------- quota (15,000 units/min per user): metered, a 429 pauses calls ----------
  let meter = { calls: 0, units: 0 };
  let coolUntil = 0;
  let coolStep = 0;
  const meterTimer = setInterval(() => {
    if (meter.calls) log(`quota: ${meter.calls} calls/min, ≈${meter.units} units/min (limit 15000)`);
    meter = { calls: 0, units: 0 };
  }, 60_000);
  meterTimer.unref?.();
  const cooling = (): number => Math.max(0, coolUntil - Date.now());
  function cool(res: Response): void {
    coolStep = Math.min(coolStep + 1, 6);
    const ms = core.coolMs(res.headers.get("retry-after"), coolStep);
    coolUntil = Math.max(coolUntil, Date.now() + ms);
    log(`quota: 429 from Gmail, pausing ${Math.round(ms / 1000)} s`);
  }

  interface ApiOpts {
    base?: string;
    type?: string;
    priority?: boolean;
  }
  async function api(method: string, p: string, body?: unknown, { base = API, type = "application/json", priority = false }: ApiOpts = {}): Promise<Json> {
    for (let attempt = 1; ; attempt++) {
      // during a cooldown: a send waits for it (up to 2 min), anything else gives up for now
      if (cooling()) {
        if (!priority || cooling() > 120_000) throw new ApiError(`Gmail is rate-limiting: try again in ${Math.ceil(cooling() / 1000)} s`, 429);
        await sleep(cooling());
      }
      const tok = await accessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${tok}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = type;
      meter.calls++;
      meter.units += core.costOf(p);
      let res: Response;
      try {
        const init: RequestInit = { method, headers, signal: AbortSignal.timeout(120_000) };
        if (body !== undefined) init.body = type === "application/json" ? JSON.stringify(body) : (body as Uint8Array);
        res = await http(base + p, init);
      } catch (e) {
        if (attempt < 3) {
          await sleep(1000 * attempt);
          continue;
        }
        const cause = obj(obj(e).cause).code;
        throw new ApiError(`Gmail unreachable (${typeof cause === "string" ? cause : e instanceof Error ? e.name : "error"})`, 0);
      }
      if (res.status === 401 && attempt < 2) {
        access = null;
        continue;
      }
      // 429, or 403 with a rate-limit reason (Gmail uses both)
      const limited = res.status === 429 || (res.status === 403 && /rateLimit|quota/i.test(await res.clone().text().catch(() => "")));
      if (limited) {
        cool(res);
        if (priority && attempt < 2) continue; // one automatic retry, after the cooldown
        const j = obj(await res.json().catch(() => null));
        const m = obj(j.error).message;
        throw new ApiError(typeof m === "string" && m ? `Gmail is rate-limiting: ${m.slice(0, 120)}` : "Gmail is rate-limiting: try again soon", 429);
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1500 * attempt);
        continue;
      }
      if (res.ok) coolStep = 0;
      const j = await res.json().catch(() => null);
      if (res.ok) return obj(j);
      const m = obj(obj(j).error).message;
      throw new ApiError(typeof m === "string" && m ? m : `Gmail answered HTTP ${res.status}`, res.status);
    }
  }

  /**
   * Google sign-in in the user's browser, back to a one-time page on 127.0.0.1. `upgrade`: already
   * connected; the current session stays until the new one (same account, more scopes) is in.
   */
  async function signIn({ upgrade = false } = {}): Promise<void> {
    const c = await client();
    if (!c) throw new Error("There's no Google client: add one in Hub's Settings (Gmail), or copy google-client.json from Person Hub");
    const verifier = core.b64url(randomBytes(32));
    const st = core.b64url(randomBytes(16));
    const abort = new AbortController();
    flow = { abort };
    let done: ((code: string) => void) | undefined;
    let fail: ((e: Error) => void) | undefined;
    const got = new Promise<string>((ok, no) => {
      done = ok;
      fail = no;
    });
    got.catch(() => {});
    const page = (title: string): Response =>
      new Response(
        `<!doctype html><meta charset="utf-8"><title>Hub</title><body style="font-family:system-ui;background:#0a0a0a;color:#eee;display:grid;place-items:center;height:90vh"><div><h2>${title}</h2><p>You can close this tab and go back to Hub.</p></div>`,
        { headers: { "content-type": "text/html; charset=utf-8", Connection: "close" } },
      );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== "/" || u.searchParams.get("state") !== st) return new Response(null, { status: 404 });
        const err = u.searchParams.get("error");
        if (err) fail?.(new Error(err === "access_denied" ? "Google sign-in was cancelled" : `Google: ${err}`));
        else done?.(u.searchParams.get("code") ?? "");
        return page(err ? "Gmail was not connected" : "Gmail connected");
      },
    });
    const redirect = `http://127.0.0.1:${server.port}/`;
    const timer = setTimeout(() => fail?.(new Error("Sign-in timed out")), 10 * 60_000);
    abort.signal.addEventListener("abort", () => fail?.(new Error("Sign-in cancelled")));
    try {
      const q: Record<string, string> = {
        response_type: "code",
        client_id: c.id,
        redirect_uri: redirect,
        scope: SCOPE,
        code_challenge: core.b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        state: st,
        access_type: "offline",
        prompt: "select_account consent",
        include_granted_scopes: "true",
      };
      if (upgrade && me) q.login_hint = me;
      ctx.openExternal(`${AUTH}?${new URLSearchParams(q)}`);
      const code = await got;
      const j = await tokenRequest({ grant_type: "authorization_code", code, client_id: c.id, client_secret: c.secret, code_verifier: verifier, redirect_uri: redirect });
      if (!String(j.scope ?? "").includes("gmail.modify")) throw new Error("Google didn’t grant access to the mail: connect again and tick every box");
      if (typeof j.refresh_token !== "string" || !j.refresh_token) throw new Error("Google sent no refresh token: remove the app at myaccount.google.com/permissions and connect again");
      if (upgrade) {
        // same mailbox only: check it with the new token before replacing the current one
        const r = await http(`${API}/profile`, { headers: { Authorization: `Bearer ${String(j.access_token ?? "")}` } });
        const prof = obj(await r.json().catch(() => ({})));
        if (String(prof.emailAddress ?? "").toLowerCase() !== me) throw new Error(`Pick the same Google account (${me})`);
      }
      refresh = j.refresh_token;
      access = String(j.access_token ?? "");
      accessExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
      scopes = String(j.scope ?? "");
      if (!upgrade) {
        const prof = await api("GET", "/profile");
        me = String(prof.emailAddress).toLowerCase();
        historyId = String(prof.historyId);
      }
      saveAccount();
      log("signed in");
    } finally {
      clearTimeout(timer);
      flow = null;
      void server.stop(true);
    }
  }

  async function forget(reason?: string): Promise<void> {
    stopPolling();
    clearTimeout(retryTimer);
    refresh = null;
    access = null;
    me = null;
    historyId = null;
    await rm(ACCOUNT_FILE, { force: true }).catch(() => {});
    setStatus("signed-out", reason ?? null);
  }

  // ---------- conversations ----------
  function merge(email: string, msgs: Email[]): boolean {
    const next = core.mergeMessages(convos.get(email) ?? [], msgs, KEEP);
    if (!next) return false;
    convos.set(email, next);
    saveCache();
    return true;
  }
  const emitMessages = (email: string, messages: Email[]): void => ctx.emit({ type: "messages", peerId: email, messages });

  async function fullMessage(mid: string): Promise<Email> {
    return core.slimEmail(await api("GET", `/messages/${encodeURIComponent(mid)}?format=full`), me);
  }

  /** Thread id → its historyId when last fetched: unchanged threads aren't fetched again. */
  const threadSeen = new Map<string, string>();
  const loadedAt = new Map<string, number>();
  async function loadThreads(email: string, older?: string): Promise<number> {
    const q = `{from:${email} to:${email} cc:${email}}${older ? ` before:${Math.floor(Date.parse(older) / 1000)}` : ""}`;
    const list = await api("GET", `/threads?maxResults=15&q=${encodeURIComponent(q)}`);
    const threads = arr(list.threads)
      .map(obj)
      .filter((t) => threadSeen.get(String(t.id)) !== String(t.historyId));
    const msgs: Email[] = [];
    for (let i = 0; i < threads.length; i += 4) {
      const chunk = await Promise.all(
        threads.slice(i, i + 4).map((t) =>
          api("GET", `/threads/${encodeURIComponent(String(t.id))}?format=full`).then(
            (r) => {
              threadSeen.set(String(t.id), String(t.historyId));
              return r;
            },
            () => null,
          ),
        ),
      );
      for (const t of chunk)
        for (const mv of arr(t?.messages)) {
          if (arr(obj(mv).labelIds).some((l) => l === "DRAFT" || l === "SPAM" || l === "TRASH")) continue;
          const s = core.slimEmail(mv, me);
          if (core.involves(s, email)) msgs.push(s);
        }
    }
    if (msgs.length && merge(email, msgs)) emitMessages(email, convos.get(email) ?? []);
    return msgs.length;
  }

  // ---------- polling (history API) ----------
  function stopPolling(): void {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  function schedulePoll(ms = POLL_MS): void {
    stopPolling();
    if (stopped) return;
    pollTimer = setTimeout(() => void poll(), ms);
  }
  async function poll(): Promise<void> {
    if (status !== "connected") return;
    if (cooling()) {
      schedulePoll(cooling() + 1000);
      return;
    }
    try {
      if (!historyId) {
        historyId = String((await api("GET", "/profile")).historyId);
        saveAccount();
      }
      let page: string | null = null;
      const added = new Set<string>();
      do {
        const r: Json = await api("GET", `/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded&maxResults=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
        for (const h of arr(r.history))
          for (const x of arr(obj(h).messagesAdded)) {
            const m = obj(obj(x).message);
            if (!arr(m.labelIds).some((l) => l === "DRAFT" || l === "SPAM")) added.add(String(m.id));
          }
        if (r.historyId) historyId = String(r.historyId);
        page = typeof r.nextPageToken === "string" ? r.nextPageToken : null;
      } while (page);
      const have = new Set([...convos.values()].flatMap((l) => l.map((m) => m.id)));
      for (const mid of added) {
        if (have.has(mid)) continue; // ours (just sent) or already loaded
        const m = await fullMessage(mid).catch(() => null);
        if (!m) continue;
        for (const email of tracked) if (core.involves(m, email) && merge(email, [m])) emitMessages(email, [m]);
      }
      saveAccount();
      pushState();
    } catch (e) {
      if (statusOf(e) === 404) historyId = null; // too old: start again from now
      else log("poll failed", msg(e));
    }
    schedulePoll();
  }

  async function goOnline(): Promise<void> {
    setStatus("connecting");
    try {
      await accessToken();
      setStatus("connected");
      schedulePoll(2000);
    } catch (e) {
      if (status !== "signed-out") {
        setStatus("connecting", msg(e));
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (refresh && status !== "connected" && !stopped) void goOnline();
        }, 60_000);
      }
    }
  }

  // ---------- people: name + photo for an email ----------
  const lookups = new Map<string, { at: number; result: LookupResult }>();
  let warmed = false;
  async function people(p: string): Promise<Json> {
    const res = await http(PEOPLE + p, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15_000) });
    const j = obj(await res.json().catch(() => ({})));
    if (!res.ok) {
      const e = obj(j.error);
      throw new ApiError(`${res.status} ${String(e.status ?? "")} ${String(e.message ?? "").slice(0, 300)}`.trim(), res.status);
    }
    return j;
  }
  const MASK = "names,emailAddresses,photos,metadata";
  const realPhoto = (per: Json): string | undefined => {
    const p = arr(per.photos)
      .map(obj)
      .find((x) => typeof x.url === "string" && x.url && !x.default);
    return p ? String(p.url) : undefined;
  };
  /** "Other contacts" carry only Google's letter tile: their linked Google profile has the real photo. */
  async function profilePhoto(per: Json, notes: string[]): Promise<string | undefined> {
    const ids = [
      ...new Set(
        arr(obj(per.metadata).sources)
          .map(obj)
          .filter((x) => x.type === "PROFILE" && x.id)
          .map((x) => String(x.id)),
      ),
    ];
    for (const pid of ids) {
      try {
        const url = realPhoto(await people(`/people/${encodeURIComponent(pid)}?personFields=photos`));
        notes.push(`profile: ${url ? "photo" : "no photo"}`);
        if (url) return url;
      } catch (e) {
        notes.push(`profile: error ${msg(e)}`);
      }
    }
    if (!ids.length) notes.push("profile: none linked");
    return undefined;
  }
  const warm = (): Promise<unknown> => Promise.allSettled([people(`/otherContacts:search?query=&readMask=${MASK}`), people(`/people:searchContacts?query=&readMask=${MASK}`)]);
  /** Their contact (saved, or "other contacts": people you've emailed) name and photo; `notes` says what each search answered. */
  async function fromContacts(email: string, notes: string[]): Promise<{ name?: string; photo?: string } | null> {
    if (!hasContacts()) {
      notes.push("contacts: not granted");
      return null;
    }
    if (!warmed) {
      // Google's search cache needs a warm-up first
      warmed = true;
      await warm();
      await sleep(1500);
    }
    const searches: [string, string][] = [
      ["contacts", `/people:searchContacts?query=${encodeURIComponent(email)}&readMask=${MASK}&pageSize=10`],
      ["other", `/otherContacts:search?query=${encodeURIComponent(email)}&readMask=${MASK}&pageSize=10`],
    ];
    for (const [label, p] of searches) {
      try {
        const rs = arr((await people(p)).results).map(obj);
        let hit: { name?: string; photo?: string; photos: number } | null = null;
        for (const r of rs) {
          const per = obj(r.person);
          if (!arr(per.emailAddresses).some((e) => String(obj(e).value ?? "").toLowerCase() === email)) continue;
          const photo = realPhoto(per) ?? (await profilePhoto(per, notes));
          const n = arr(per.names)
            .map(obj)
            .find((x) => typeof x.displayName === "string" && x.displayName);
          hit = { photos: arr(per.photos).length };
          if (n) hit.name = String(n.displayName);
          if (photo) hit.photo = core.sizedPhoto(photo);
          break;
        }
        notes.push(`${label}: ${rs.length} result(s)${hit ? `, match (name ${hit.name ? "yes" : "no"}, photos ${hit.photos}, real photo ${hit.photo ? "yes" : "no"})` : ""}`);
        if (hit && (hit.photo || hit.name)) return hit;
      } catch (e) {
        notes.push(`${label}: error ${msg(e)}`);
        log("people search failed", msg(e));
      }
    }
    return null;
  }
  /** Their display name in a From / To header of the mail exchanged with them. */
  async function fromMail(email: string): Promise<string | undefined> {
    try {
      const list = await api("GET", `/messages?maxResults=3&q=${encodeURIComponent(`from:${email} OR to:${email}`)}`);
      for (const m of arr(list.messages).map(obj)) {
        const full = await api("GET", `/messages/${encodeURIComponent(String(m.id))}?format=metadata&metadataHeaders=From&metadataHeaders=To`);
        for (const h of arr(obj(full.payload).headers).map(obj)) {
          for (const part of String(h.value).split(",")) {
            const mm = /^\s*"?([^"<]+?)"?\s*<([^>]+)>/.exec(part);
            if (mm && (mm[2] ?? "").trim().toLowerCase() === email && (mm[1] ?? "").trim()) return (mm[1] ?? "").trim();
          }
        }
      }
    } catch (e) {
      log("name from mail failed", msg(e));
    }
    return undefined;
  }
  async function gravatar(email: string): Promise<string | undefined> {
    const url = `https://www.gravatar.com/avatar/${createHash("md5").update(email).digest("hex")}?s=128&d=404`;
    try {
      const r = await http(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      return r.ok ? url : undefined;
    } catch {
      return undefined;
    }
  }

  const needConnected = (): void => {
    if (status !== "connected") throw new Error("Connect Gmail first");
  };

  // ---------- attachments ----------
  async function fetchAttachment(url: string, name: string): Promise<string> {
    const a = core.parseAtt(url);
    const file = join(FILES, core.attFileName(a, name));
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {
      // fetch it
    }
    const j = await api("GET", `/messages/${encodeURIComponent(a.mid)}/attachments/${encodeURIComponent(a.aid)}`);
    await mkdir(FILES, { recursive: true, mode: 0o700 });
    await writeAtomic(file, core.unb64url(j.data));
    return file;
  }

  return {
    id: ctx.id,
    kind: ctx.kind,
    section: ctx.section,
    state,
    async start() {
      stopped = false;
      if (await loadAccount()) void goOnline();
      else setStatus("signed-out", error);
    },
    async connect() {
      if (status === "connected" || flow) return state();
      setStatus("signing-in");
      signIn().then(
        () => goOnline(),
        (e: unknown) => {
          log("sign-in failed", msg(e));
          setStatus("signed-out", msg(e));
        },
      );
      return state();
    },
    async disconnect() {
      flow?.abort.abort();
      const tok = refresh;
      if (tok) http(`${REVOKE}?token=${encodeURIComponent(tok)}`, { method: "POST" }).catch(() => {});
      convos.clear();
      clearTimeout(saveTimer);
      await rm(CACHE_FILE, { force: true }).catch(() => {});
      await rm(FILES, { recursive: true, force: true }).catch(() => {});
      await forget();
      return state();
    },
    /** Sign in again for contact photos, keeping the session until it succeeds. */
    async reconnect() {
      if (status !== "connected" || flow) return state();
      signIn({ upgrade: true }).then(
        () => {
          lookups.clear();
          pushState();
        },
        (e: unknown) => {
          log("reconnect failed", msg(e));
          error = msg(e);
          pushState();
        },
      );
      pushState();
      return state();
    },
    async track(peers) {
      tracked.clear();
      for (const e of peers) if (core.isEmail(String(e))) tracked.add(String(e).trim().toLowerCase());
      const out: Record<string, Conversation> = {};
      for (const e of tracked) {
        const m = convos.get(e);
        if (m) out[e] = { channelId: null, messages: m };
      }
      return out;
    },
    /** An email address → their Google name and photo (contacts, then their emails, then Gravatar). */
    async lookup(q) {
      const email = String(q ?? "").trim().toLowerCase();
      if (!core.isEmail(email)) return { matches: [] };
      needConnected();
      const hit = lookups.get(email);
      if (hit && Date.now() - hit.at < 30 * 60_000) return hit.result;
      const notes: string[] = [];
      const c = await fromContacts(email, notes);
      const name = c?.name ?? (await fromMail(email));
      const photo = c?.photo ?? (await gravatar(email));
      if (!c?.photo) notes.push(`gravatar: ${photo ? "yes" : "none"}`);
      const user: ChannelUser = { id: email, username: email, globalName: name ?? null, avatar: null, avatarUrl: photo ?? "" };
      const result: LookupResult = { matches: [user], contacts: hasContacts(), searched: hasContacts() && !notes.some((n) => n.includes("error")), notes };
      lookups.set(email, { at: photo ? Date.now() : Date.now() - 28 * 60_000, result }); // misses: retried after 2 min
      return result;
    },
    async user() {
      return null;
    },
    async history(peer, before) {
      needConnected();
      const email = String(peer).trim().toLowerCase();
      if (!core.isEmail(email)) throw new Error("Invalid email");
      // the newest page: at most once a minute per person (polling brings new mail in between)
      if (before) await loadThreads(email, (convos.get(email) ?? [])[0]?.timestamp);
      else if (Date.now() - (loadedAt.get(email) ?? 0) > 60_000) {
        loadedAt.set(email, Date.now());
        await loadThreads(email);
      }
      return { channelId: null, messages: convos.get(email) ?? [] };
    },
    /** One email: a reply in `replyTo`'s thread, else in the latest thread, else a new one (needs a subject). */
    async send(peer: string, text: string, files?: OutgoingFile[], replyTo?: string, subject?: string): Promise<SendResult> {
      needConnected();
      const email = String(peer).trim().toLowerCase();
      if (!core.isEmail(email)) return { ok: false, error: "Invalid email address" };
      const ups = (files ?? []).filter((f) => f.data instanceof Uint8Array && f.data.byteLength);
      if (ups.reduce((n, f) => n + f.data.byteLength, 0) > 24 * 1024 * 1024) return { ok: false, error: "Attachments are over Gmail’s 25 MB limit" };
      if (!String(text ?? "").trim() && !ups.length) return { ok: false, error: "Empty email" };
      const conv = convos.get(email) ?? [];
      const parent = replyTo ? conv.find((m) => m.id === String(replyTo)) : subject ? undefined : conv.at(-1);
      const subj = parent ? core.reSubject(parent.subject) : String(subject ?? "").trim();
      if (!subj) return { ok: false, error: "Add a subject" };
      try {
        const raw = core.buildMime(
          {
            to: email,
            subject: subj,
            text: String(text ?? ""),
            files: ups.map((f) => ({ name: core.safeFileName(f.name, "attachment"), type: core.isMime(f.type) ? f.type : "application/octet-stream", data: f.data })),
            inReplyTo: parent?.messageIdHeader ?? "",
            references: parent ? [parent.references, parent.messageIdHeader].filter(Boolean).join(" ") : "",
          },
          `ph-${randomBytes(12).toString("hex")}`,
        );
        const b = `ph-${randomBytes(12).toString("hex")}`;
        const meta = parent?.threadId ? { threadId: parent.threadId } : {};
        const body = Buffer.concat([
          Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`),
          Buffer.from(raw),
          Buffer.from(`\r\n--${b}--\r\n`),
        ]);
        const sent = await api("POST", "/messages/send?uploadType=multipart", body, { base: UPLOAD, type: `multipart/related; boundary=${b}`, priority: true });
        const m = await fullMessage(String(sent.id));
        merge(email, [m]);
        emitMessages(email, [m]);
        return { ok: true, message: m };
      } catch (e) {
        return { ok: false, error: msg(e) };
      }
    },
    fetchAttachment,
    /** Read in Hub: their unread emails lose Gmail's UNREAD label. */
    async markRead(peer) {
      needConnected();
      const email = String(peer).toLowerCase();
      const conv = convos.get(email) ?? [];
      const ids = conv.filter((m) => m.unread && !m.fromMe).map((m) => m.id);
      if (!ids.length) return { ok: true };
      await api("POST", "/messages/batchModify", { ids, removeLabelIds: ["UNREAD"] });
      const cleared = conv.filter((m) => ids.includes(m.id)).map((m) => ({ ...m, unread: false }));
      if (merge(email, cleared)) emitMessages(email, cleared);
      return { ok: true };
    },
    /** Mark as unread from `messageId`: their emails from there on get Gmail's UNREAD label back. */
    async markUnread(peer, messageId) {
      needConnected();
      const email = String(peer).toLowerCase();
      const conv = convos.get(email) ?? [];
      const from = conv.find((m) => m.id === String(messageId));
      if (!from) return { ok: false };
      const list = conv.filter((m) => !m.fromMe && m.timestamp >= from.timestamp);
      if (!list.length) return { ok: true };
      await api("POST", "/messages/batchModify", { ids: list.map((m) => m.id), addLabelIds: ["UNREAD"] });
      const flagged = list.map((m) => ({ ...m, unread: true }));
      if (merge(email, flagged)) emitMessages(email, flagged);
      return { ok: true };
    },
    async typing() {
      return { ok: true };
    },
    async watch() {
      return { ok: true };
    },
    async stop() {
      stopped = true;
      stopPolling();
      clearTimeout(retryTimer);
      clearInterval(meterTimer);
      flow?.abort.abort();
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        await writeCache();
      }
    },
  };
}
