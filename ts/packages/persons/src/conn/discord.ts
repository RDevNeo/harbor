// One Discord account (port of Person Hub's shell/discord.cjs), running in Bun: Discord's HTTP API with
// fetch and its gateway with the global WebSocket. The account's web login lives in an Electron session
// (Person Hub's partitions, copied by the migration); a short-lived helper (../../discord-session/main.cjs,
// run with Hub's pinned Electron) reads its token and exits. The token stays in this process's memory:
// never logged, never written, never returned (state() carries no token).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { env as osEnv, proc } from "@harbor/os";
import type { ChannelUser, ConnState, ConnStatus, Conversation, LookupResult, Message, OutgoingFile, PresenceStatus, SendResult } from "../model/types.ts";
import HELPER_SOURCE from "../../discord-session/main.cjs" with { type: "text" };
import * as core from "./discord-core.ts";
import type { Connection, ConnContext } from "./types.ts";

export { discordFiles, partitionOf, partitionFolder } from "./discord-core.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A connection's Electron user-data folder: <persons dir>/discord/<conn id> (its Partitions/<name> holds the login). */
export function discordSessionDir(dir: string, id: string): string {
  if (!/^[\w-]{1,40}$/.test(id)) throw new Error("Invalid connection id");
  return join(dir, "discord", id);
}

export type SessionMode = "token" | "signin" | "signout";

/** How long the helper may take per mode. */
export const HELPER_TIMEOUT: Readonly<Record<SessionMode, number>> = { token: 90_000, signin: 15 * 60_000, signout: 90_000 };

export interface DiscordOptions {
  /** Discord's origin (a test rig's fake one); default $PERSONS_DISCORD_ORIGIN or https://discord.com. */
  origin?: string;
  /** Electron's app name in the helper (its keyring entry for cookies): Person Hub's, so copied sessions decrypt. */
  appName?: string;
  /** Path of the Electron binary; default Hub's pinned one (@harbor/mcp discordsetup, downloaded once). */
  electron?: () => Promise<string>;
  /** Replaces the helper process entirely (tests). */
  session?: (mode: SessionMode) => Promise<core.HelperResult>;
}

interface ClientHeaders {
  superProps: string | null;
  locale: string | null;
  timezone: string | null;
}

class ApiError extends Error {
  constructor(
    msg: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(msg);
  }
}

async function defaultElectron(): Promise<string> {
  const { discordsetup } = await import("@harbor/mcp");
  await discordsetup.ensureElectron(() => {});
  return discordsetup.electronBin();
}

/** The helper's script on disk (a compiled Hub carries it as text): written when missing or changed. */
function helperScript(dir: string): string {
  const d = join(dir, "discord", ".helper");
  const file = join(d, "main.cjs");
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {
    // first run
  }
  if (cur !== HELPER_SOURCE) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, HELPER_SOURCE, { mode: 0o600 });
    renameSync(tmp, file);
  }
  return file;
}

export function createDiscord(ctx: ConnContext, opts: DiscordOptions = {}): Connection {
  const id = ctx.id;
  const log = (...a: unknown[]): void => ctx.log(`discord[${id}]:`, ...a);
  const ORIGIN = (opts.origin ?? process.env.PERSONS_DISCORD_ORIGIN ?? "https://discord.com").replace(/\/$/, "");
  const customOrigin = ORIGIN !== "https://discord.com";
  const API = `${ORIGIN}/api/v9`;
  const originHost = new URL(ORIGIN).host;
  const files = core.discordFiles(id);
  const SESSION_DIR = discordSessionDir(ctx.dir, id);
  const CACHE_FILE = join(ctx.dir, files.cache);
  const CLIENT_FILE = join(SESSION_DIR, files.client); // super properties (no token)
  const FALLBACK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

  let token: string | null = null; // in memory only
  let headers: ClientHeaders = { superProps: null, locale: null, timezone: null };
  try {
    const j = JSON.parse(readFileSync(CLIENT_FILE, "utf8")) as Partial<ClientHeaders>;
    headers = { superProps: j.superProps ?? null, locale: j.locale ?? null, timezone: j.timezone ?? null };
  } catch {
    // first run
  }

  let status: ConnStatus = "starting";
  let me: core.SlimUser | null = null;
  let error: string | null = null;
  let stopped = false;
  const tracked = new Set<string>(); // discord ids of people in the app
  const presence = new Map<string, PresenceStatus>(); // READY(_SUPPLEMENTAL), member chunks, PRESENCE_UPDATE
  const friends = new Set<string>(); // Discord sends friends' presence by itself
  // Others' presence comes only for members the session subscribes to (gateway op 37), as the
  // official client does for the people in its DMs. Per gateway session: the people already looked
  // up (op 8 with user_ids + presences, once each) and the guild each one is followed in.
  const probed = new Set<string>();
  let memberSubs: Record<string, string[]> = {};
  const users = new Map<string, core.SlimUser>(); // everyone this session has seen
  const channelLast = new Map<string, string>(); // dm channel id -> last_message_id from READY
  const acks = new Map<string, string>(); // dm channel id -> last message id read (Discord read state)
  let guildIds: string[] = [];
  const convos = core.createConversations(1000);
  const pacer = core.createPacer();
  const memberBucket = core.createBucket({ capacity: 40, perMs: 60_000 });
  const searchCache = new Map<string, { at: number; users: core.SlimUser[] }>();
  const profileCache = new Map<string, { at: number; user: core.SlimUser | null }>();

  try {
    convos.load((JSON.parse(readFileSync(CACHE_FILE, "utf8")) as { conversations?: unknown }).conversations);
  } catch {
    // none yet
  }

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t: ReturnType<typeof setTimeout> | null): void => {
    if (t === null) return;
    clearTimeout(t);
    timers.delete(t);
  };

  // ---------- state ----------
  const gatewayUp = (): boolean => gw.ready;
  const state = (): ConnState => ({ status, me: me && core.withAvatar(me, 64), gateway: gatewayUp() ? "up" : "down", error });
  let lastSent = "";
  function pushState(): void {
    const s = state();
    const k = JSON.stringify(s);
    if (k === lastSent) return;
    lastSent = k;
    ctx.emit({ type: "state", state: s });
  }
  const setStatus = (s: ConnStatus, err: string | null = null): void => {
    status = s;
    error = err;
    pushState();
  };

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  async function writeCache(): Promise<void> {
    const keep: Record<string, core.StoredConversation> = {};
    const all = convos.toJSON();
    for (const [peer, c] of Object.entries(all)) if (tracked.has(peer)) keep[peer] = { channelId: c.channelId, messages: c.messages.slice(-200) };
    try {
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, conversations: keep }), { mode: 0o600 });
      await rename(tmp, CACHE_FILE);
    } catch (e) {
      log("cache write failed", errMsg(e));
    }
  }
  function saveCache(): void {
    cancel(saveTimer);
    saveTimer = later(1500, () => {
      saveTimer = null;
      void writeCache();
    });
  }

  // ---------- the session helper (Electron) ----------
  let helperChild: ChildProcess | null = null;
  let helperRun = 0;

  function killHelper(): void {
    const c = helperChild;
    helperChild = null;
    if (!c || c.exitCode !== null || c.pid === undefined) return;
    const pid = c.pid;
    try {
      c.kill();
    } catch {
      // gone
    }
    setTimeout(() => {
      if (c.exitCode === null && c.signalCode === null) proc.killTree(pid);
    }, 3000);
  }

  async function runHelper(mode: SessionMode): Promise<core.HelperResult> {
    killHelper();
    const bin = await (opts.electron ?? defaultElectron)();
    mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    const script = helperScript(ctx.dir);
    const args = [script, "--user-data", SESSION_DIR, "--partition", core.partitionOf(id), "--mode", mode, "--app-name", opts.appName ?? "Person Hub"];
    // Hidden modes never need a display: Chromium's headless platform (ignored where there's no ozone).
    if (mode !== "signin") args.push("--ozone-platform=headless", "--ozone-override-screen-size=1280,720");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
    if (customOrigin) env.PERSONS_DISCORD_ORIGIN = ORIGIN;
    const [prog = bin, ...pre] = osEnv.argvOf(bin, env);
    return await new Promise<core.HelperResult>((resolve) => {
      let settled = false;
      let child: ChildProcess;
      const settle = (r: core.HelperResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (helperChild === child) killHelper();
        resolve(r);
      };
      const timer = setTimeout(() => settle({ error: "Discord's session didn't answer in time" }), HELPER_TIMEOUT[mode]);
      try {
        // stderr ignored: Chromium's noise (the helper never writes the token there).
        child = spawn(prog, [...pre, ...args], { env, stdio: ["ignore", "pipe", "ignore"] });
      } catch (e) {
        settle({ error: `Couldn't start Electron: ${errMsg(e)}` });
        return;
      }
      helperChild = child;
      child.on("error", (e) => settle({ error: `Couldn't start Electron: ${errMsg(e)}` }));
      child.on("exit", () => {
        // the line may still be in the pipe: give readline a moment
        setTimeout(() => settle({ error: "Discord's session helper stopped" }), 200);
      });
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          const r = core.parseHelperLine(line);
          if (r) settle(r);
        });
      }
    });
  }

  const session = opts.session ?? runHelper;

  function applyClient(r: core.HelperResult): void {
    if (!r.superProps || r.superProps === headers.superProps) return;
    headers = { superProps: r.superProps, locale: r.locale ?? headers.locale, timezone: r.timezone ?? headers.timezone };
    void (async () => {
      try {
        await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
        await writeFile(CLIENT_FILE, JSON.stringify(headers), { mode: 0o600 });
      } catch {
        // optional: the next helper run brings them again
      }
    })();
  }

  let acquireRetry: ReturnType<typeof setTimeout> | null = null;
  let acquireBackoff = 60_000;

  /** Runs the helper and acts on its answer. */
  async function acquire(mode: "token" | "signin"): Promise<void> {
    cancel(acquireRetry);
    acquireRetry = null;
    const run = ++helperRun;
    let r: core.HelperResult;
    try {
      r = await session(mode);
    } catch (e) {
      r = { error: errMsg(e) };
    }
    if (run !== helperRun || stopped) return;
    if (r.token) {
      acquireBackoff = 60_000;
      applyClient(r);
      token = r.token;
      await onToken(mode === "signin" ? "sign-in" : "session");
      return;
    }
    if (r.signedOut || r.cancelled) {
      if (!token) setStatus("signed-out");
      return;
    }
    // no answer (no network, Electron missing…): say so and try again later
    log(`session ${mode} failed:`, r.error ?? "no answer");
    if (mode === "signin") {
      if (!token) setStatus("signed-out", r.error ?? null);
      return;
    }
    setStatus(token ? "connecting" : "signed-out", r.error ?? null);
    acquireRetry = later(acquireBackoff, () => {
      acquireRetry = null;
      if (!token && status !== "signing-in") void acquire("token");
    });
    acquireBackoff = Math.min(acquireBackoff * 2, 10 * 60_000);
  }

  let validating: Promise<void> | null = null;
  let validateRetry: ReturnType<typeof setTimeout> | null = null;
  function onToken(source: string): Promise<void> {
    if (validating) return validating;
    validating = (async () => {
      try {
        if (status !== "connected") setStatus("connecting");
        const u = await api<core.RawUser>("GET", "/users/@me");
        me = core.slimUser(u);
        log(`signed in (${source})`);
        setStatus("connected");
        gw.start();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return; // the 401 path signed out already
        log("validate failed", errMsg(e));
        if (token) setStatus("connecting", errMsg(e));
        cancel(validateRetry);
        validateRetry = later(15_000, () => {
          validateRetry = null;
          if (token && status !== "connected") void onToken("retry");
        });
      } finally {
        validating = null;
      }
    })();
    return validating;
  }

  /** The token is dead: forget it; `clear` also empties the session (else /login would bounce back to /app with it). */
  async function signedOut(reason: string | null, clear: boolean): Promise<void> {
    if (status === "signed-out" && !token) return;
    log("signed out");
    token = null;
    me = null;
    gw.stop();
    setStatus("signed-out", reason);
    if (clear) {
      try {
        await session("signout");
      } catch {
        // the sign-in page will ask anyway
      }
    }
  }

  /** On a 401: read the session's token again, once; a new one is used, else the account is signed out. */
  let refreshing: Promise<boolean> | null = null;
  function refreshAfter401(bad: string): Promise<boolean> {
    if (token !== bad) return Promise.resolve(token !== null);
    refreshing ??= (async () => {
      try {
        log("Discord answered 401: reading the session again");
        const run = ++helperRun;
        let r: core.HelperResult;
        try {
          r = await session("token");
        } catch (e) {
          r = { error: errMsg(e) };
        }
        if (run !== helperRun || stopped) return false;
        if (r.token && r.token !== bad) {
          applyClient(r);
          token = r.token;
          return true;
        }
        await signedOut("Discord signed this session out", r.token === bad);
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // ---------- HTTP API ----------
  const userAgent = (): string => {
    const ua = core.decodeSuperProps(headers.superProps)?.browser_user_agent;
    return typeof ua === "string" && ua !== "" ? ua : FALLBACK_UA;
  };

  function baseHeaders(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Authorization: token ?? "", Accept: "*/*", "Accept-Language": "en-US,en;q=0.9", Referer: `${ORIGIN}/channels/@me`, "User-Agent": userAgent() };
    if (json) h["Content-Type"] = "application/json";
    if (headers.superProps) h["X-Super-Properties"] = headers.superProps;
    h["X-Discord-Locale"] = headers.locale || "en-US";
    if (headers.timezone) h["X-Discord-Timezone"] = headers.timezone;
    return h;
  }

  async function api<T = unknown>(method: string, p: string, body?: unknown, { tries = 3, refresh = true }: { tries?: number; refresh?: boolean } = {}): Promise<T> {
    if (!token) throw new ApiError("Discord is not connected", 0);
    const used = token;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        const init: RequestInit = { method, headers: baseHeaders(body !== undefined), signal: AbortSignal.timeout(20_000) };
        if (body !== undefined) init.body = JSON.stringify(body);
        res = await fetch(API + p, init);
      } catch (e) {
        if (attempt < tries) {
          await sleep(1000 * attempt);
          continue;
        }
        const code = (e as { code?: unknown; name?: unknown }).code ?? (e as { name?: unknown }).name ?? "network";
        throw new ApiError(`Discord unreachable (${String(code)})`, 0);
      }
      if (res.status === 429 && attempt < tries) {
        let wait = 2000;
        try {
          wait = Math.ceil(((await res.json()) as { retry_after?: number }).retry_after ?? 0) * 1000 || wait;
        } catch {
          // keep the default
        }
        await sleep(Math.min(wait, 30_000) + 250);
        continue;
      }
      if (res.status === 204) return null as T;
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        // empty
      }
      if (res.ok) return json as T;
      if (res.status === 401 && refresh) {
        if (await refreshAfter401(used)) return api<T>(method, p, body, { tries, refresh: false });
      } else if (res.status === 401) {
        void signedOut("Discord signed this session out", false);
      }
      const j = (json ?? {}) as { captcha_key?: unknown; message?: unknown; code?: unknown };
      const msg = j.captcha_key ? "Discord asked for a captcha. Send this one from the Discord app." : typeof j.message === "string" ? j.message : `Discord answered HTTP ${res.status}`;
      throw new ApiError(msg, res.status, typeof j.code === "number" ? j.code : undefined);
    }
  }

  // ---------- gateway ----------
  const gw = createGateway({
    getToken: () => token,
    getProperties: () => core.decodeSuperProps(headers.superProps) ?? fallbackProps(),
    getUrl: async () => {
      try {
        return (await api<{ url?: string }>("GET", "/gateway"))?.url ?? "wss://gateway.discord.gg";
      } catch {
        return "wss://gateway.discord.gg";
      }
    },
    onDispatch: (t, d) => onDispatch(t, d),
    onChange: () => {
      pushState();
      schedulePoll();
    },
    onAuthFailed: () => {
      const bad = token;
      if (!bad) return;
      void refreshAfter401(bad).then((ok) => {
        if (ok) gw.start();
      });
    },
    log,
  });

  function fallbackProps(): Record<string, unknown> {
    return {
      os: "Linux",
      browser: "Chrome",
      device: "",
      system_locale: headers.locale || "en-US",
      browser_user_agent: FALLBACK_UA,
      browser_version: "142.0.0.0",
      os_version: "",
      referrer: "",
      referring_domain: "",
      referrer_current: "",
      referring_domain_current: "",
      release_channel: "stable",
      client_event_source: null,
    };
  }

  const pendingUsers = new Map<string, core.SlimUser>();
  const rememberUser = (raw: core.RawUser | null | undefined): core.SlimUser | null => {
    const u = core.slimUser(raw);
    if (!u) return null;
    const prev = users.get(u.id);
    users.set(u.id, u);
    if (tracked.has(u.id) && (!prev || prev.avatar !== u.avatar || prev.globalName !== u.globalName || prev.username !== u.username)) pendingUsers.set(u.id, u);
    return u;
  };
  let usersTimer: ReturnType<typeof setTimeout> | null = null;
  function flushUsers(): void {
    cancel(usersTimer);
    usersTimer = later(300, () => {
      usersTimer = null;
      if (!pendingUsers.size) return;
      const list = [...pendingUsers.values()].map((u) => core.withAvatar(u));
      pendingUsers.clear();
      ctx.emit({ type: "users", users: list });
    });
  }

  const withoutUnread = (m: Message): Message => {
    const { unread: _drop, ...rest } = m;
    return rest;
  };

  type Raw = Record<string, unknown>;
  const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

  function onDispatch(t: string, data: unknown): void {
    const d = (data ?? {}) as Raw;
    switch (t) {
      case "READY": {
        me = core.slimUser(d.user as core.RawUser) ?? me;
        for (const u of (d.users as core.RawUser[] | undefined) ?? []) rememberUser(u);
        for (const r of (d.relationships as { user?: core.RawUser }[] | undefined) ?? []) if (r.user) rememberUser(r.user);
        channelLast.clear();
        // read state: the last message acked per channel (here, in the official client, on the phone)
        acks.clear();
        const rs = d.read_state as { entries?: unknown } | unknown[] | undefined;
        const entries = (Array.isArray(rs) ? rs : ((rs as { entries?: unknown } | undefined)?.entries ?? [])) as { id?: unknown; last_message_id?: unknown }[];
        for (const e of Array.isArray(entries) ? entries : []) if (e?.id && e.last_message_id) acks.set(String(e.id), String(e.last_message_id));
        for (const ch of (d.private_channels as core.RawChannel[] | undefined) ?? []) {
          const peer = core.dmPeer(ch, users);
          if (!peer) continue;
          if (peer.user) rememberUser(peer.user);
          convos.setChannel(peer.id, String(ch.id));
          if (ch.last_message_id) channelLast.set(String(ch.id), String(ch.last_message_id));
        }
        guildIds = ((d.guilds as unknown[] | undefined) ?? []).map((g) => String((g as { id?: unknown })?.id ?? g)).filter(Boolean);
        // a new gateway session: presences and member subscriptions start over
        presence.clear();
        friends.clear();
        for (const f of core.friendIds(d.relationships)) friends.add(f);
        probed.clear();
        memberSubs = {};
        takeReadyPresences(d, !!d.merged_presences);
        schedulePresenceProbe(10_000);
        flushUsers();
        pushState();
        void catchUp();
        break;
      }
      // PRIORITIZED_READY_PAYLOAD (capabilities): friends' and guild presences arrive here, after READY
      case "READY_SUPPLEMENTAL":
        takeReadyPresences(d, true);
        schedulePresenceProbe(3000);
        break;
      case "MESSAGE_CREATE":
      case "MESSAGE_UPDATE": {
        const m = d as core.RawMessage;
        if (m.guild_id || !m.channel_id) return;
        if (m.author) rememberUser(m.author);
        let peer = convos.peerOf(m.channel_id);
        if (!peer && m.author?.id && String(m.author.id) !== me?.id && (m.channel_type === 1 || m.channel_type == null)) {
          peer = String(m.author.id);
          convos.setChannel(peer, m.channel_id);
        }
        if (!peer || !tracked.has(peer)) {
          flushUsers();
          return;
        }
        if (t === "MESSAGE_UPDATE") {
          const prev = convos.get(peer)?.messages.find((x) => x.id === m.id);
          if (!prev) return;
          const next: Message = { ...prev, ...(m.content !== undefined ? { content: String(m.content) } : {}), ...(m.edited_timestamp ? { edited: true } : {}) };
          if (convos.merge(peer, [next])) {
            ctx.emit({ type: "messages", peerId: peer, messages: [next] });
            saveCache();
          }
          return;
        }
        const msg = flagUnread(core.slimMessage(m, me?.id));
        channelLast.set(msg.channelId, msg.id);
        if (convos.merge(peer, [msg])) {
          ctx.emit({ type: "messages", peerId: peer, messages: [msg] });
          saveCache();
        }
        flushUsers();
        break;
      }
      case "MESSAGE_DELETE": {
        const peer = convos.remove(s(d.channel_id), s(d.id));
        if (peer) {
          ctx.emit({ type: "delete", peerId: peer, messageId: s(d.id) });
          saveCache();
        }
        break;
      }
      case "CHANNEL_CREATE": {
        const peer = core.dmPeer(d as core.RawChannel, users);
        if (peer) {
          if (peer.user) rememberUser(peer.user);
          convos.setChannel(peer.id, s(d.id));
          flushUsers();
        }
        break;
      }
      case "PRESENCE_UPDATE": {
        const uid = s((d.user as { id?: unknown } | undefined)?.id);
        const st = d.status as PresenceStatus | undefined;
        if (d.guild_id && d.guild_id !== "0" && presence.get(uid) === st) break;
        if (uid && st) {
          presence.set(uid, st);
          emitPresence([uid]);
        }
        break;
      }
      case "TYPING_START": {
        // they're typing in a DM (Discord shows it ~10 s)
        if (d.guild_id || s(d.user_id) === me?.id) break;
        const peer = convos.peerOf(s(d.channel_id)) ?? s(d.user_id);
        if (!tracked.has(peer)) break;
        ctx.emit({ type: "typing", peerId: peer, kind: "typing", until: Date.now() + 10_000 });
        break;
      }
      case "MESSAGE_ACK": // read elsewhere (the official client, the phone)
        if (d.channel_id && d.message_id) {
          const cid = s(d.channel_id);
          const mid = s(d.message_id);
          acks.set(cid, mid);
          const peer = convos.peerOf(cid);
          const c = peer !== undefined ? convos.get(peer) : undefined;
          const cleared = c ? c.messages.filter((m) => m.unread && core.cmpId(m.id, mid) <= 0).map(withoutUnread) : [];
          if (peer !== undefined && cleared.length && convos.merge(peer, cleared)) {
            ctx.emit({ type: "messages", peerId: peer, messages: cleared });
            saveCache();
          }
        }
        break;
      case "USER_UPDATE":
        if (s(d.id) === me?.id) {
          me = core.slimUser(d as core.RawUser);
          pushState();
        }
        break;
      case "RELATIONSHIP_ADD":
        if (d.user) {
          rememberUser(d.user as core.RawUser);
          flushUsers();
        }
        if (d.type === 1 && d.id) friends.add(s(d.id));
        break;
      case "RELATIONSHIP_REMOVE":
        if (d.id) friends.delete(s(d.id));
        break;
      case "GUILD_CREATE":
        if (d.id && !guildIds.includes(s(d.id))) guildIds.push(s(d.id));
        break;
      case "GUILD_DELETE":
        guildIds = guildIds.filter((g) => g !== s(d.id));
        break;
      case "GUILD_MEMBERS_CHUNK": {
        const nonce = s(d.nonce);
        const members = (d.members as { user?: core.RawUser }[] | undefined) ?? [];
        const probe = probeWaits.get(nonce);
        if (probe) {
          const st = core.chunkPresences(d);
          for (const [uid, x] of st) {
            const gs = probe.guildsOf.get(uid) ?? [];
            gs.push(s(d.guild_id));
            probe.guildsOf.set(uid, gs);
            presence.set(uid, x);
          }
          for (const m of members) if (m.user) rememberUser(m.user);
          emitPresence([...st.keys()]);
          flushUsers();
          probe.chunks++;
          if (probe.chunks >= probe.expected) probe.done();
          break;
        }
        const waiting = memberWaits.get(nonce);
        for (const m of members) {
          if (!m.user) continue;
          const u = rememberUser(m.user);
          if (u && waiting) waiting.found.set(u.id, u);
        }
        if (waiting) {
          waiting.chunks++;
          if (waiting.chunks >= waiting.expected) waiting.done();
        }
        flushUsers();
        break;
      }
    }
  }

  /** READY / READY_SUPPLEMENTAL presences; `complete`: friends missing from them are offline. */
  function takeReadyPresences(d: Raw, complete: boolean): void {
    const got = core.readyPresences(d as Parameters<typeof core.readyPresences>[0]);
    for (const [uid, st] of got) presence.set(uid, st);
    if (complete) for (const f of friends) if (!got.has(f) && !presence.has(f)) presence.set(f, "offline");
    emitPresence([...tracked]);
  }

  /**
   * Presence of the tracked people who aren't friends: once per gateway session, one Request Guild
   * Members (op 8: user_ids + presences, up to 100 ids, 25 guilds per request) tells which servers
   * they share with the account and their status now; then one op 37 subscribes to those members
   * (one guild each, bounded), so their PRESENCE_UPDATEs arrive like in the official client.
   * Debounced, ≥ 30 s apart, and only for people not looked up yet in this session.
   */
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let probeAt = 0;
  let probing = false;
  interface ProbeWait {
    guildsOf: Map<string, string[]>;
    chunks: number;
    expected: number;
    done: () => void;
  }
  const probeWaits = new Map<string, ProbeWait>();
  function schedulePresenceProbe(delay: number): void {
    cancel(probeTimer);
    probeTimer = later(Math.max(delay, probeAt + 30_000 - Date.now()), () => {
      probeTimer = null;
      void probePresences();
    });
  }
  async function probePresences(): Promise<void> {
    if (probing || !gatewayUp() || !guildIds.length || status !== "connected") return;
    const want = [...tracked].filter((x) => x !== me?.id && !friends.has(x) && !probed.has(x)).slice(0, 200);
    if (!want.length) return;
    probing = true;
    probeAt = Date.now();
    try {
      for (const x of want) probed.add(x);
      const guildsOf = new Map<string, string[]>();
      const guilds = guildIds.slice(0, 200);
      outer: for (const ids of core.chunk(want, 100)) {
        for (const gids of core.chunk(guilds, 25)) {
          if (!gatewayUp() || stopped) return;
          if (!memberBucket.take(1)) {
            await sleep(15_000);
            if (!memberBucket.take(1)) break outer;
          }
          await new Promise<void>((resolve) => {
            const nonce = `pr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
            const w: ProbeWait = {
              guildsOf,
              chunks: 0,
              expected: gids.length,
              done: () => {
                clearTimeout(t);
                probeWaits.delete(nonce);
                resolve();
              },
            };
            const t = setTimeout(w.done, 6000);
            probeWaits.set(nonce, w);
            gw.send({ op: 8, d: { guild_id: gids, user_ids: ids, limit: ids.length, presences: true, nonce } });
          });
          await sleep(1500);
        }
      }
      const next = core.planMemberSubscriptions(guildsOf, memberSubs);
      const changed = Object.keys(next).filter((g) => (next[g]?.length ?? 0) !== (memberSubs[g]?.length ?? 0));
      memberSubs = next;
      if (changed.length && gatewayUp()) {
        gw.send({ op: 37, d: { subscriptions: Object.fromEntries(changed.map((g) => [g, { members: next[g] }])) } });
        log(`presence: following ${Object.values(next).reduce((n, l) => n + l.length, 0)} people in ${Object.keys(next).length} servers`);
      }
    } catch (e) {
      log("presence lookup failed", errMsg(e));
    } finally {
      probing = false;
    }
  }

  function emitPresence(ids: string[]): void {
    const out: Record<string, PresenceStatus> = {};
    for (const x of ids) {
      const st = presence.get(x);
      if (tracked.has(x) && st !== undefined) out[x] = st;
    }
    if (Object.keys(out).length) ctx.emit({ type: "presence", presence: out });
  }

  /** After a (re)connect: fetch conversations of tracked people that changed while we were away. */
  let catching = false;
  async function catchUp(): Promise<void> {
    if (catching) return;
    catching = true;
    try {
      for (const peer of [...tracked]) {
        if (stopped) break;
        const cid = convos.channelOf(peer);
        if (!cid || !token) continue;
        const last = channelLast.get(cid);
        const have = convos.lastId(peer);
        if (!last || (have && core.cmpId(have, last) >= 0)) continue;
        try {
          await fetchMessages(peer, cid, have ? { after: have } : {});
        } catch (e) {
          log("catch-up failed", errMsg(e));
        }
        await sleep(900);
      }
    } finally {
      catching = false;
    }
  }

  /** Their message newer than the channel's ack is unread (as Discord shows it). */
  function flagUnread(m: Message): Message {
    if (m.fromMe) return m;
    const ack = acks.get(m.channelId);
    return !ack || core.cmpId(m.id, ack) > 0 ? { ...m, unread: true } : m;
  }

  async function fetchMessages(peer: string, cid: string, { before, after, limit = 50 }: { before?: string; after?: string; limit?: number } = {}): Promise<Message[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set("before", before);
    if (after) q.set("after", after);
    const list = await api<core.RawMessage[]>("GET", `/channels/${cid}/messages?${q}`);
    const msgs = (Array.isArray(list) ? list : []).map((m) => {
      if (m.author) rememberUser(m.author);
      return flagUnread(core.slimMessage(m, me?.id));
    });
    flushUsers();
    if (convos.merge(peer, msgs)) {
      ctx.emit({ type: "messages", peerId: peer, messages: msgs });
      saveCache();
    } else convos.setChannel(peer, cid);
    return msgs;
  }

  // Polling fallback: while the gateway is down, look at tracked DMs every ~30 s (a few per tick).
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollCursor = 0;
  function schedulePoll(): void {
    if (gatewayUp() || !token || stopped) {
      cancel(pollTimer);
      pollTimer = null;
      return;
    }
    if (pollTimer) return;
    pollTimer = later(30_000, () => {
      void (async () => {
        pollTimer = null;
        if (gatewayUp() || !token) return;
        const peers = [...tracked].filter((p) => convos.channelOf(p));
        const batch = peers.length <= 15 ? peers : Array.from({ length: 15 }, (_, i) => peers[(pollCursor + i) % peers.length] as string);
        pollCursor = peers.length ? (pollCursor + batch.length) % peers.length : 0;
        for (const peer of batch) {
          if (gatewayUp() || !token || stopped) break;
          const have = convos.lastId(peer);
          const cid = convos.channelOf(peer);
          if (!cid) continue;
          try {
            await fetchMessages(peer, cid, have ? { after: have, limit: 20 } : { limit: 20 });
          } catch {
            // next tick
          }
          await sleep(700);
        }
        schedulePoll();
      })();
    });
  }

  // ---------- member search (gateway op 8, like the client's quick switcher) ----------
  interface MemberWait {
    found: Map<string, core.SlimUser>;
    chunks: number;
    expected: number;
    done: () => void;
  }
  const memberWaits = new Map<string, MemberWait>();
  async function searchMembers(query: string): Promise<core.SlimUser[]> {
    const q = core.normalizeQuery(query);
    const hit = searchCache.get(q);
    if (hit && Date.now() - hit.at < 120_000) return hit.users;
    if (!gatewayUp() || !guildIds.length || q.length < 2) return [];
    const batches: string[][] = [];
    for (let i = 0; i < Math.min(guildIds.length, 100); i += 25) batches.push(guildIds.slice(i, i + 25));
    if (!memberBucket.take(batches.length)) return hit?.users ?? [];
    const found = new Map<string, core.SlimUser>();
    await Promise.all(
      batches.map(
        (ids, i) =>
          new Promise<void>((resolve) => {
            const nonce = `ch${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`;
            const w: MemberWait = {
              found,
              chunks: 0,
              expected: ids.length,
              done: () => {
                clearTimeout(t);
                memberWaits.delete(nonce);
                resolve();
              },
            };
            const t = setTimeout(w.done, 3500);
            memberWaits.set(nonce, w);
            gw.send({ op: 8, d: { guild_id: ids, query: q, limit: 10, presences: false, nonce } });
          }),
      ),
    );
    const list = [...found.values()];
    searchCache.set(q, { at: Date.now(), users: list });
    return list;
  }

  async function profile(uid: string, { fresh = false }: { fresh?: boolean } = {}): Promise<core.SlimUser | null> {
    const c = profileCache.get(uid);
    if (c && !fresh && Date.now() - c.at < 10 * 60_000) return c.user;
    let u: core.RawUser | null | undefined = null;
    try {
      const p = await api<{ user?: core.RawUser } | null>("GET", `/users/${uid}/profile?with_mutual_guilds=false&with_mutual_friends=false&with_mutual_friends_count=false`);
      u = p?.user;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 0 || e.status === 401)) throw e;
    }
    if (!u) {
      try {
        u = await api<core.RawUser>("GET", `/users/${uid}`);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.code === 10013)) {
          profileCache.set(uid, { at: Date.now(), user: null });
          return null;
        }
        if (!users.has(uid)) throw e;
      }
    }
    const slim = u ? rememberUser(u) : (users.get(uid) ?? null);
    profileCache.set(uid, { at: Date.now(), user: slim });
    flushUsers();
    return slim;
  }

  // ---------- what the app calls ----------
  const needConnected = (): void => {
    if (status !== "connected" || !token) throw new Error("Connect Discord first");
  };

  async function ensureChannel(peer: string): Promise<string> {
    let cid = convos.channelOf(peer);
    if (cid) return cid;
    const ch = await api<{ id: string }>("POST", "/users/@me/channels", { recipients: [peer] });
    cid = String(ch.id);
    convos.setChannel(peer, cid);
    return cid;
  }

  function forget(): void {
    token = null;
    me = null;
    gw.stop();
    convos.clear();
    users.clear();
    profileCache.clear();
    searchCache.clear();
  }

  let started = false;
  const conn: Connection = {
    id,
    kind: ctx.kind,
    section: ctx.section,
    state,

    /** Reads the session's token in the background (the helper may take a while); never shows a window. */
    async start() {
      if (started || stopped) return;
      started = true;
      pushState();
      void acquire("token");
      // Nothing settled after a while (no network?): report what we know.
      later(30_000, () => {
        if (status === "starting") setStatus(token ? "connecting" : "signed-out");
      });
    },

    /** Opens Discord's sign-in window (the helper, shown); returns at once with status signing-in. */
    async connect() {
      if (status === "connected" || token) return state();
      killHelper();
      setStatus("signing-in");
      void acquire("signin");
      return state();
    },

    async reconnect() {
      return conn.connect();
    },

    async disconnect() {
      helperRun++;
      killHelper();
      try {
        if (token) await api("POST", "/auth/logout", { provider: null, voip_provider: null }, { tries: 1, refresh: false });
      } catch {
        // forget it locally anyway
      }
      forget();
      cancel(saveTimer);
      saveTimer = null;
      await rm(CACHE_FILE, { force: true }).catch(() => {});
      setStatus("signed-out");
      const run = ++helperRun;
      try {
        const r = await session("signout");
        if (r.error) log("sign-out cleanup failed:", r.error);
      } catch (e) {
        log("sign-out cleanup failed:", errMsg(e));
      }
      if (run === helperRun) setStatus("signed-out");
      return state();
    },

    async track(peers) {
      tracked.clear();
      for (const x of Array.isArray(peers) ? peers : []) if (core.isSnowflake(String(x))) tracked.add(String(x));
      const out: Record<string, Conversation> = {};
      for (const x of tracked) {
        const c = convos.get(x);
        if (c) out[x] = { channelId: c.channelId, messages: c.messages.slice(-200) };
      }
      const known: ChannelUser[] = [];
      for (const x of tracked) {
        const u = users.get(x);
        if (u) known.push(core.withAvatar(u));
      }
      if (known.length) later(0, () => ctx.emit({ type: "users", users: known }));
      later(0, () => emitPresence([...tracked]));
      if (status === "connected") {
        void catchUp();
        if (gatewayUp() && [...tracked].some((x) => !probed.has(x) && !friends.has(x))) schedulePresenceProbe(5000);
      }
      return out;
    },

    async lookup(query): Promise<LookupResult> {
      needConnected();
      const q = String(query ?? "").trim();
      if (!q) return { matches: [] };
      if (core.isSnowflake(q)) {
        const u = await profile(q);
        return { matches: u ? [core.withAvatar(u)] : [], notFound: !u };
      }
      const local = core.rankUsers(
        [...users.values()].filter((u) => u.id !== me?.id),
        q,
        8,
      );
      const exact = local.some((u) => u.username.toLowerCase() === core.normalizeQuery(q));
      if (exact) return { matches: local.map((u) => core.withAvatar(u)) };
      const members = await searchMembers(q);
      const all = core.rankUsers(
        [...local, ...members].filter((u) => u.id !== me?.id),
        q,
        10,
      );
      return { matches: all.map((u) => core.withAvatar(u)), searchedServers: gatewayUp() && guildIds.length > 0 };
    },

    async user(uid) {
      needConnected();
      if (!core.isSnowflake(String(uid))) throw new Error("Invalid id");
      const u = await profile(String(uid), { fresh: true });
      return u ? core.withAvatar(u) : null;
    },

    /** Read here: ack the DM up to its newest message, as the client does when it's opened. */
    async markRead(peerId) {
      needConnected();
      const peer = String(peerId);
      const cid = convos.channelOf(peer);
      const c = convos.get(peer);
      const last = c?.messages.at(-1)?.id;
      if (!cid || !c || !last || acks.get(cid) === last) return { ok: true };
      acks.set(cid, last);
      const cleared = c.messages.filter((m) => m.unread).map(withoutUnread);
      if (cleared.length && convos.merge(peer, cleared)) {
        ctx.emit({ type: "messages", peerId: peer, messages: cleared });
        saveCache();
      }
      try {
        await api("POST", `/channels/${cid}/messages/${last}/ack`, { token: null, last_viewed: Math.floor((Date.now() - 1420070400000) / 86_400_000) }, { tries: 1 });
      } catch (e) {
        log("ack failed", errMsg(e));
      }
      return { ok: true };
    },

    /** Mark as unread from `messageId`: ack the message before it (manual, as the client's "Mark Unread"). */
    async markUnread(peerId, messageId) {
      needConnected();
      const peer = String(peerId);
      const mid = String(messageId);
      const cid = convos.channelOf(peer);
      const c = convos.get(peer);
      if (!cid || !c || !core.isSnowflake(mid)) return { ok: false };
      const i = c.messages.findIndex((m) => m.id === mid);
      const prev = i > 0 ? (c.messages[i - 1] as Message).id : (BigInt(mid) - 1n).toString();
      acks.set(cid, prev);
      const flagged = c.messages.filter((m) => !m.fromMe && core.cmpId(m.id, mid) >= 0).map((m) => ({ ...m, unread: true }));
      if (flagged.length && convos.merge(peer, flagged)) {
        ctx.emit({ type: "messages", peerId: peer, messages: flagged });
        saveCache();
      }
      try {
        await api("POST", `/channels/${cid}/messages/${prev}/ack`, { manual: true, mention_count: 0 }, { tries: 1 });
      } catch (e) {
        log("unread ack failed", errMsg(e));
      }
      return { ok: true };
    },

    /** I'm typing: the client's POST /typing (only in an existing DM; it lasts ~10 s on their side). */
    async typing(peer, on) {
      if (on === false || status !== "connected" || !token) return { ok: true };
      const cid = convos.channelOf(String(peer));
      if (!cid) return { ok: false };
      try {
        await api("POST", `/channels/${cid}/typing`, undefined, { tries: 1 });
      } catch {
        // not important
      }
      return { ok: true };
    },

    async watch() {
      return { ok: true };
    },

    async history(peerId, before) {
      needConnected();
      const peer = String(peerId);
      if (!core.isSnowflake(peer)) throw new Error("Invalid id");
      // Only DMs that exist: opening a DM channel just to read would add it to the user's DM list.
      const cid = convos.channelOf(peer);
      if (cid) await fetchMessages(peer, cid, before ? { before: String(before) } : {});
      const c = convos.get(peer);
      return { channelId: c?.channelId || null, messages: c?.messages ?? [] };
    },

    async send(peerId, content, attachments?: OutgoingFile[], replyTo?: string): Promise<SendResult> {
      needConnected();
      const peer = String(peerId);
      const text = String(content ?? "");
      if (!core.isSnowflake(peer)) return { ok: false, error: "Invalid Discord id" };
      let ups: core.Upload[];
      try {
        ups = core.checkUploads(attachments);
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
      const voice = ups.length === 1 && !!ups[0]?.voice;
      if (!text.trim() && !ups.length) return { ok: false, error: "Empty message" };
      if (text.length > 2000) return { ok: false, error: "Discord messages are at most 2000 characters" };
      const wait = pacer.reserve();
      if (wait) await sleep(wait);
      try {
        const cid = await ensureChannel(peer);
        const body: Record<string, unknown> = { mobile_network_type: "unknown", content: voice ? "" : text, nonce: core.nowSnowflake(), tts: false, flags: voice ? 8192 : 0 };
        // a reply, as the client sends it (the replied-to message's author is pinged, as in Discord)
        if (replyTo && core.isSnowflake(String(replyTo))) body.message_reference = { channel_id: cid, message_id: String(replyTo) };
        if (ups.length) {
          // Discord's upload flow (as the web client does it): ask for upload slots, PUT the bytes
          // to the signed URLs, then post the message pointing at the uploaded files.
          const slots = await api<{ attachments?: { upload_url: string; upload_filename: string }[] }>("POST", `/channels/${cid}/attachments`, {
            files: ups.map((f, i) => ({ filename: f.name, file_size: f.data.byteLength, id: String(i), is_clip: false })),
          });
          const list = slots?.attachments ?? [];
          if (list.length !== ups.length) throw new Error("Discord didn’t accept the files");
          for (let i = 0; i < ups.length; i++) {
            const up = ups[i] as core.Upload;
            const slot = list[i] as { upload_url: string };
            const res = await fetch(slot.upload_url, { method: "PUT", headers: { "Content-Type": up.type }, body: up.data, signal: AbortSignal.timeout(120_000) });
            if (!res.ok) throw new Error(`Upload of ${up.name} failed (HTTP ${res.status})`);
          }
          Object.assign(body, {
            channel_id: cid,
            type: 0,
            sticker_ids: [],
            attachments: ups.map((f, i) => ({
              id: String(i),
              filename: f.name,
              uploaded_filename: (list[i] as { upload_filename: string }).upload_filename,
              ...(f.voice ? { duration_secs: f.voice.duration, waveform: f.voice.waveform } : {}),
            })),
          });
        }
        const m = await api<core.RawMessage>("POST", `/channels/${cid}/messages`, body, { tries: 2 });
        const slim = core.slimMessage(m, me?.id);
        channelLast.set(cid, slim.id);
        if (convos.merge(peer, [slim])) saveCache();
        ctx.emit({ type: "messages", peerId: peer, messages: [slim] });
        return { ok: true, message: slim };
      } catch (e) {
        const code = e instanceof ApiError ? e.code : undefined;
        return { ok: false, error: (code !== undefined ? core.SEND_ERRORS[code] : undefined) ?? errMsg(e) };
      }
    },

    /** Downloads an attachment from Discord's CDN into <persons dir>/files (once); returns the path. */
    async fetchAttachment(url, name) {
      if (!core.isAttachmentUrl(url, customOrigin ? originHost : null)) throw new Error("Not a Discord attachment");
      const dir = join(ctx.dir, "files");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, core.attachmentFileName(url, name));
      if (!existsSync(file)) {
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, new Uint8Array(await res.arrayBuffer()), { mode: 0o600 });
        await rename(tmp, file);
      }
      return file;
    },

    async stop() {
      stopped = true;
      helperRun++;
      killHelper();
      gw.stop();
      const pendingSave = saveTimer !== null;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      saveTimer = null;
      if (pendingSave) await writeCache();
    },
  };
  return conn;
}

// ---------- gateway ----------

interface GatewayOpts {
  getToken: () => string | null;
  getProperties: () => Record<string, unknown>;
  getUrl: () => Promise<string>;
  onDispatch: (t: string, d: unknown) => void;
  onChange: () => void;
  onAuthFailed: () => void;
  log: (...a: unknown[]) => void;
}

export interface Gateway {
  readonly ready: boolean;
  start(): void;
  stop(): void;
  send(obj: unknown): void;
}

/** Discord gateway client (JSON, no compression) with heartbeats, resume and backoff. */
export function createGateway({ getToken, getProperties, getUrl, onDispatch, onChange, onAuthFailed, log }: GatewayOpts): Gateway {
  let ws: WebSocket | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  let acked = true;
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let running = false;
  let backoff = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let ready = false;

  const setReady = (r: boolean): void => {
    if (ready !== r) {
      ready = r;
      onChange();
    }
  };
  const stopBeat = (): void => {
    if (hb !== null) clearInterval(hb);
    hb = null;
  };

  async function open(): Promise<void> {
    if (!running || ws) return;
    if (!getToken()) return;
    const base = (sessionId && resumeUrl) || (await getUrl());
    if (!running || ws) return;
    const url = `${base.replace(/\/$/, "")}/?encoding=json&v=9`;
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      log("gateway open failed", errMsg(e));
      retry();
      return;
    }
    ws = sock;
    const beat = (): void => {
      if (ws !== sock || sock.readyState !== WebSocket.OPEN) return;
      if (!acked) {
        sock.close(4000, "zombie"); // no ack since the last beat
        return;
      }
      acked = false;
      sock.send(JSON.stringify({ op: 1, d: seq }));
    };
    sock.onmessage = (ev: MessageEvent) => {
      let msg: { op?: number; s?: number | null; t?: string; d?: unknown };
      try {
        const raw = ev.data;
        msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8")) as typeof msg;
      } catch {
        return;
      }
      if (ws !== sock) return;
      if (msg.s != null) seq = msg.s;
      switch (msg.op) {
        case 10: {
          // hello
          stopBeat();
          const every = (msg.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval || 41250;
          acked = true;
          setTimeout(beat, Math.round(every * Math.random()));
          hb = setInterval(beat, every);
          const tk = getToken();
          if (sessionId && seq != null) sock.send(JSON.stringify({ op: 6, d: { token: tk, session_id: sessionId, seq } }));
          else
            sock.send(
              JSON.stringify({
                op: 2,
                d: { token: tk, capabilities: 16381, properties: getProperties(), presence: { status: "unknown", since: 0, activities: [], afk: false }, compress: false, client_state: { guild_versions: {} } },
              }),
            );
          break;
        }
        case 11:
          acked = true;
          break;
        case 1:
          beat();
          break;
        case 7:
          sock.close(4000, "reconnect"); // the server asks us to reconnect + resume
          break;
        case 9: // invalid session
          if (!msg.d) {
            sessionId = null;
            seq = null;
          }
          setTimeout(() => sock.close(4000, "invalid session"), 1000 + Math.random() * 3000);
          break;
        case 0: {
          const d = msg.d as { session_id?: string; resume_gateway_url?: string } | undefined;
          if (msg.t === "READY") {
            sessionId = d?.session_id ?? null;
            resumeUrl = d?.resume_gateway_url || null;
            backoff = 1000;
            setReady(true);
          }
          if (msg.t === "RESUMED") {
            backoff = 1000;
            setReady(true);
          }
          try {
            onDispatch(String(msg.t), msg.d);
          } catch (e) {
            log("dispatch failed", msg.t, errMsg(e));
          }
          break;
        }
      }
    };
    sock.onclose = (ev: CloseEvent) => {
      if (ws !== sock) return;
      ws = null;
      stopBeat();
      setReady(false);
      if (!running) return;
      if (ev.code === 4004) {
        running = false;
        onAuthFailed();
        return;
      }
      if ([4007, 4009].includes(ev.code)) {
        sessionId = null;
        seq = null;
      }
      if ([4010, 4011, 4012, 4013, 4014].includes(ev.code)) {
        sessionId = null;
        seq = null;
        log("gateway closed", ev.code);
      }
      retry();
    };
    sock.onerror = () => {
      // onclose follows
    };
  }

  function retry(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    const wait = backoff + Math.round(Math.random() * 1000);
    backoff = Math.min(backoff * 2, 60_000);
    reconnectTimer = setTimeout(() => void open(), wait);
  }

  return {
    get ready() {
      return ready;
    },
    start() {
      if (running) return;
      running = true;
      backoff = 1000;
      void open();
    },
    stop() {
      running = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopBeat();
      sessionId = null;
      seq = null;
      resumeUrl = null;
      const sock = ws;
      ws = null;
      try {
        sock?.close(1000);
      } catch {
        // already closed
      }
      setReady(false);
    },
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
  };
}
