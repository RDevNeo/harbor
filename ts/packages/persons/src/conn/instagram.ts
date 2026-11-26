// Instagram direct messages for Persons (the Personal section): one account, signed in with a session pasted from a
// browser's cookies (sessionid + ds_user_id), talking to Instagram's app API the way the Android app does (as Collector's
// Instagram source, but its own session: Collector's is SpokPay's account). Gentle by design: one call at a time with a
// gap between calls, the inbox read every POLL_MS while connected (live enough for a personal chat), history and sends
// only when asked. Sends happen only from the composer. The session stays in <persons>/instagram-<id>.json (0600) and
// is never logged.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivate } from "@harbor/store";
import { mergeMessages } from "../model/conversation.ts";
import type { ChannelUser, ConnState, ConnStatus, Conversation, LookupResult, Message, SendResult } from "../model/types.ts";
import * as core from "./instagram-core.ts";
import type { ConnContext, Connection } from "./types.ts";

export interface InstagramOptions {
  fetch?: typeof fetch;
  /** Least ms between two calls (tests: 0). */
  gapMs?: number;
  pollMs?: number;
}

const GAP_MS = 2500;
const POLL_MS = 30_000;
const BACKOFF_MS = 120_000;
const KEEP = 500;

type Session = { cookie: string; account: string | null; userId: string; device: string; savedAt: number };
type Api = { status: number; body: unknown };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function createInstagram(ctx: ConnContext, opts: InstagramOptions = {}): Connection {
  const { id } = ctx;
  const http = opts.fetch ?? fetch;
  const gap = opts.gapMs ?? GAP_MS;
  const pollEvery = opts.pollMs ?? POLL_MS;
  const log = (...a: unknown[]): void => ctx.log(`instagram[${id}]:`, ...a);
  const SESSION_FILE = join(ctx.dir, `instagram-${id}.json`);
  const CACHE_FILE = join(ctx.dir, `instagram-cache-${id}.json`);
  const FILES = join(ctx.dir, "files", `instagram-${id}`);

  let session: Session | null = null;
  let status: ConnStatus = "starting";
  let error: string | null = null;
  let me: ChannelUser | null = null;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let nextAt = 0;
  let pausedUntil = 0;
  const tracked = new Set<string>();
  /** user id → thread id; thread id → the cursor of its older page. */
  const threadOf = new Map<string, string>();
  const cursors = new Map<string, { cursor: string | null; hasOlder: boolean }>();
  const convos = new Map<string, Conversation>();
  /** The newest item id seen per user (polls emit only what changed). */
  const newest = new Map<string, string>();

  try {
    const c = obj(JSON.parse(readFileSync(CACHE_FILE, "utf8")));
    for (const [k, v] of Object.entries(obj(c.conversations))) {
      const conv = obj(v);
      if (Array.isArray(conv.messages)) convos.set(k, { channelId: typeof conv.channelId === "string" ? conv.channelId : null, messages: (conv.messages as Message[]).slice(-KEEP) });
      if (typeof conv.channelId === "string") threadOf.set(k, conv.channelId);
    }
  } catch {
    // none yet
  }

  const state = (): ConnState => ({ status, me, gateway: status === "connected" ? "up" : "down", error });
  let lastState = "";
  const pushState = (): void => {
    const s = state();
    const k = JSON.stringify(s);
    if (k === lastState) return;
    lastState = k;
    ctx.emit({ type: "state", state: s });
  };
  const setStatus = (s: ConnStatus, err: string | null = null): void => {
    status = s;
    error = err;
    pushState();
  };

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveCache = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      const conversations: Record<string, Conversation> = {};
      for (const [k, v] of convos) if (tracked.has(k)) conversations[k] = { channelId: v.channelId, messages: v.messages.slice(-KEEP) };
      try {
        writePrivate(CACHE_FILE, JSON.stringify({ version: 1, conversations }));
      } catch (e) {
        log("cache write failed", msg(e));
      }
    }, 1500);
  };

  function loadSession(): Session | null {
    try {
      const s = obj(JSON.parse(readFileSync(SESSION_FILE, "utf8")));
      const cookie = typeof s.cookie === "string" ? s.cookie : "";
      const auth = core.igAuth(cookie);
      if (!auth) return null;
      return { cookie, account: typeof s.account === "string" ? s.account : null, userId: auth.userId, device: typeof s.device === "string" ? s.device : randomUUID(), savedAt: typeof s.savedAt === "number" ? s.savedAt : Date.now() };
    } catch {
      return null;
    }
  }

  /** One app-API call, one at a time with a gap; 429 pauses every call for a while. */
  async function api(path: string, form?: Record<string, string>, s: Session | null = session): Promise<Api> {
    if (!s) throw new Error("Instagram isn't signed in");
    if (Date.now() < pausedUntil) throw new Error("Instagram asked to slow down: trying again in a minute or two");
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    const r = await http(core.IG_API + path, {
      method: form ? "POST" : "GET",
      headers: core.igHeaders(s.cookie, s.device, form ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (r.status === 429) pausedUntil = Date.now() + BACKOFF_MS;
    if (s === session && core.signedOut(r.status, body)) {
      log("signed out by Instagram", r.status);
      setStatus("signed-out", "Instagram signed this session out: paste a fresh one");
      stopPoll();
    }
    return { status: r.status, body };
  }

  const okBody = (r: Api): Record<string, unknown> | null => (r.status === 200 && obj(r.body).status !== "fail" ? obj(r.body) : null);

  function absorb(t: core.IgThread, emit: boolean): void {
    threadOf.set(t.peer, t.id);
    if (!cursors.has(t.id)) cursors.set(t.id, { cursor: t.oldestCursor, hasOlder: t.hasOlder });
    if (!tracked.has(t.peer)) return;
    const msgs = core.withTicks(t.messages, t.peerSeenAt);
    convos.set(t.peer, mergeMessages(convos.get(t.peer), msgs, t.id, KEEP));
    const top = convos.get(t.peer)?.messages.at(-1);
    const changed = !!top && newest.get(t.peer) !== `${top.id}:${top.status ?? ""}`;
    if (top) newest.set(t.peer, `${top.id}:${top.status ?? ""}`);
    if (emit && changed && msgs.length) {
      ctx.emit({ type: "messages", peerId: t.peer, messages: msgs });
      saveCache();
    }
  }

  async function poll(): Promise<void> {
    if (stopped || status !== "connected" || !session) return;
    try {
      const r = await api("/direct_v2/inbox/?visual_message_return_type=unseen&thread_message_limit=10&persistentBadging=true&limit=20");
      const b = okBody(r);
      if (b) for (const t of core.igInbox(b, session.userId).threads) absorb(t, true);
      else if (status === "connected") log("inbox read refused", r.status);
    } catch (e) {
      log("inbox read failed", msg(e));
    }
  }
  function stopPoll(): void {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  function schedule(ms = pollEvery): void {
    stopPoll();
    if (stopped || status !== "connected") return;
    pollTimer = setTimeout(() => void poll().finally(() => schedule()), ms);
  }

  /** The thread with a user: known from the inbox, else asked for (null when they never talked). */
  async function threadWith(peer: string): Promise<string | null> {
    const known = threadOf.get(peer);
    if (known) return known;
    const r = await api(`/direct_v2/threads/get_by_participants/?recipient_users=${encodeURIComponent(JSON.stringify([Number(peer)]))}&limit=20`);
    const t = core.igThread(obj(okBody(r)).thread, session?.userId ?? "");
    if (!t) return null;
    absorb(t, false);
    return t.id;
  }

  async function signIn(s: Session): Promise<ConnState> {
    setStatus("connecting");
    let r: Api;
    try {
      r = await api("/accounts/current_user/?edit=true", undefined, s);
    } catch (e) {
      setStatus(session ? "connected" : "signed-out", `Couldn't reach Instagram: ${msg(e)}`);
      return state();
    }
    const u = core.igUser(obj(okBody(r)).user);
    if (!u) {
      setStatus("signed-out", core.signedOut(r.status, r.body) ? "Instagram didn't accept that session (signed out or expired): copy fresh cookies" : `Instagram refused the session (HTTP ${r.status})`);
      return state();
    }
    session = { ...s, account: u.username, userId: u.id };
    me = { ...u, globalName: u.globalName || u.username };
    setStatus("connected");
    schedule(500);
    return state();
  }

  const conn: Connection = {
    id: ctx.id,
    kind: ctx.kind,
    section: ctx.section,
    ...(ctx.also ? { also: ctx.also } : {}),
    state,

    async start() {
      const s = loadSession();
      if (!s) {
        setStatus("signed-out", "Paste your Instagram session to connect");
        return;
      }
      session = s;
      me = s.account ? { id: s.userId, username: s.account, globalName: s.account, avatar: null, avatarUrl: "" } : null;
      await signIn(s);
    },

    async connect() {
      if (!session) {
        setStatus("signed-out", "Paste your Instagram session to connect");
        return state();
      }
      return signIn(session);
    },

    async setSession(raw) {
      const cookie = core.normCookie(raw);
      const auth = cookie ? core.igAuth(cookie) : null;
      if (!cookie || !auth) throw new Error("That has no session: paste sessionid=…; ds_user_id=… from instagram.com's cookies");
      const next: Session = { cookie, account: null, userId: auth.userId, device: session?.device ?? randomUUID(), savedAt: Date.now() };
      const st = await signIn(next);
      if (st.status !== "connected") throw new Error(st.error ?? "Instagram didn't accept that session");
      writePrivate(SESSION_FILE, JSON.stringify({ cookie, account: session?.account ?? null, device: next.device, savedAt: next.savedAt }));
      log("session saved");
      return st;
    },

    async disconnect() {
      stopPoll();
      session = null;
      me = null;
      try {
        rmSync(SESSION_FILE, { force: true });
      } catch {
        // gone already
      }
      setStatus("signed-out", "Paste your Instagram session to connect");
      return state();
    },

    async track(peers) {
      tracked.clear();
      for (const p of peers) tracked.add(p);
      const out: Record<string, Conversation> = {};
      for (const p of peers) {
        const c = convos.get(p);
        if (c) out[p] = c;
      }
      if (status === "connected") schedule(1000);
      return out;
    },

    async lookup(query) {
      if (status !== "connected") return { matches: [], notes: ["Instagram isn’t connected"] } satisfies LookupResult;
      const name = query.trim().replace(/^@+/, "");
      if (!name) return { matches: [] };
      const r = await api(`/users/${encodeURIComponent(name)}/usernameinfo/`);
      const u = core.igUser(obj(okBody(r)).user);
      return u ? { matches: [u] } : { matches: [], notFound: true };
    },

    async user(uid) {
      if (status !== "connected") return null;
      const r = await api(`/users/${encodeURIComponent(uid)}/info/`);
      return core.igUser(obj(okBody(r)).user);
    },

    async history(peer, before) {
      if (status !== "connected") return convos.get(peer) ?? { channelId: null, messages: [] };
      const tid = await threadWith(peer);
      if (!tid) return { channelId: null, messages: [] };
      const cur = cursors.get(tid);
      if (before && cur && !cur.hasOlder) return { channelId: tid, messages: [] };
      const q = before && cur?.cursor ? `&cursor=${encodeURIComponent(cur.cursor)}&direction=older` : "";
      const r = await api(`/direct_v2/threads/${encodeURIComponent(tid)}/?visual_message_return_type=unseen&limit=20${q}`);
      const t = core.igThread(obj(okBody(r)).thread, session?.userId ?? "");
      if (!t) return { channelId: tid, messages: [] };
      cursors.set(tid, { cursor: t.oldestCursor, hasOlder: t.hasOlder });
      const msgs = core.withTicks(t.messages, t.peerSeenAt);
      if (tracked.has(peer)) {
        convos.set(peer, mergeMessages(convos.get(peer), msgs, tid, KEEP));
        saveCache();
      }
      return { channelId: tid, messages: msgs };
    },

    async send(peer, text, files): Promise<SendResult> {
      if (status !== "connected" || !session) return { ok: false, error: "Instagram isn’t connected" };
      if (files?.length) return { ok: false, error: "Pictures and files can't be sent to Instagram from here yet: send the text alone" };
      if (!text.trim()) return { ok: false, error: "Nothing to send" };
      const tid = threadOf.get(peer);
      const token = randomUUID();
      const form: Record<string, string> = { action: "send_item", client_context: token, mutation_token: token, offline_threading_id: token, _uuid: session.device, text };
      if (tid) form.thread_ids = `[${tid}]`;
      else form.recipient_users = `[[${peer}]]`;
      let r: Api;
      try {
        r = await api("/direct_v2/threads/broadcast/text/", form);
      } catch (e) {
        return { ok: false, error: msg(e) };
      }
      const b = okBody(r);
      const p = obj(b?.payload);
      if (!b || !p.item_id) return { ok: false, error: typeof obj(r.body).message === "string" ? String(obj(r.body).message) : `Instagram didn't send it (HTTP ${r.status})` };
      const thread = typeof p.thread_id === "string" ? p.thread_id : tid ?? null;
      if (thread) threadOf.set(peer, thread);
      const m: Message = { id: String(p.item_id), channelId: thread ?? "", authorId: session.userId, fromMe: true, content: text, timestamp: core.itemTime(p.timestamp ?? Date.now() * 1000), status: "sent" };
      if (tracked.has(peer)) {
        convos.set(peer, mergeMessages(convos.get(peer), [m], thread, KEEP));
        saveCache();
      }
      return { ok: true, message: m };
    },

    async markRead(peer) {
      const tid = threadOf.get(peer);
      const last = convos.get(peer)?.messages.filter((m) => !m.fromMe).at(-1);
      if (!tid || !last || !session || status !== "connected") return;
      await api(`/direct_v2/threads/${encodeURIComponent(tid)}/items/${encodeURIComponent(last.id)}/seen/`, { action: "mark_seen", thread_id: tid, _uuid: session.device });
    },

    async fetchAttachment(url, name) {
      const u = new URL(url);
      if (u.protocol !== "https:" || !/(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/.test(u.hostname)) throw new Error("Not an Instagram file");
      await mkdir(FILES, { recursive: true, mode: 0o700 });
      const safe = name.replace(/[^\w.-]+/g, "_").slice(-60) || "file";
      const file = join(FILES, `${createHash("sha256").update(u.pathname).digest("hex").slice(0, 16)}-${safe}`);
      if (!existsSync(file)) {
        const res = await http(url, { headers: { "User-Agent": core.IG_UA }, signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, new Uint8Array(await res.arrayBuffer()), { mode: 0o600 });
        await rename(tmp, file);
      }
      return file;
    },

    async stop() {
      stopped = true;
      stopPoll();
      if (saveTimer) {
        clearTimeout(saveTimer);
        const conversations: Record<string, Conversation> = {};
        for (const [k, v] of convos) if (tracked.has(k)) conversations[k] = { channelId: v.channelId, messages: v.messages.slice(-KEEP) };
        try {
          writePrivate(CACHE_FILE, JSON.stringify({ version: 1, conversations }));
        } catch {
          // best effort when quitting
        }
      }
    },
  };
  return conn;
}
