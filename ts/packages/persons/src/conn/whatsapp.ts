// A WhatsApp connection, ported from Person Hub's shell/whatsapp.cjs: Hub's Baileys engine
// (whatsapp/engine.mjs, run as a child process, see whatsapp-engine.ts) as a linked device of the
// user's account, linked by QR code ("Linked devices" on the phone). Person Hub's folder layout, so a
// migrated folder keeps the device linked: <dir>/whatsapp-<id>/{auth (the engine's keys, 0700),
// chats.json (the direct chats with the people in the app, last 200 messages each, raw media keys),
// media (downloads)}. Sends are paced; profile photos are cached a day in <dir>/avatars.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, link, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelUser, ConnState, ConnStatus, Conversation, Message, MessageStatus, OutgoingFile, PresenceStatus, SendResult } from "../model/types.ts";
import type { ConnContext, Connection } from "./types.ts";
import * as wa from "./whatsapp-core.ts";
import { childEngine, type WaEngine, type WaEngineFactory } from "./whatsapp-engine.ts";
import { AgentWaStore } from "./whatsapp-history.ts";

const KEEP = 200;
/** A link (QR) left unscanned this long is given up (the engine would keep making new QRs). */
const PAIR_WAIT = 5 * 60_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WhatsappOptions {
  /** The engine (tests: a stand-in). */
  engine?: WaEngineFactory;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Hub's own WhatsApp store (the agents' app), read for older messages: its folder (default <hub data>/apps/whatsapp), null: none. */
  agentStore?: string | null;
}

interface Contact {
  name?: string;
  notify?: string;
  verifiedName?: string;
}

async function mtime(f: string): Promise<number | undefined> {
  try {
    return (await stat(f)).mtimeMs;
  } catch {
    return undefined;
  }
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

export function createWhatsapp(ctx: ConnContext, opts: WhatsappOptions = {}): Connection {
  const { id } = ctx;
  const http = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const log = (...a: unknown[]): void => ctx.log(`whatsapp[${id}]:`, ...a);
  const DIR = join(ctx.dir, `whatsapp-${id}`);
  const AUTH = join(DIR, "auth");
  const MEDIA = join(DIR, "media");
  const CACHE = join(DIR, "chats.json");
  const AVATARS = join(ctx.dir, "avatars");
  const FILES = join(ctx.dir, "files", wa.safeFileName(id, "whatsapp"));
  const makeEngine = opts.engine ?? childEngine;
  const store = opts.agentStore === null ? null : new AgentWaStore(opts.agentStore ?? join(ctx.dir, "..", "apps", "whatsapp"));

  let status: ConnStatus = "starting";
  let me: { id: string; phone: string; name: string } | null = null;
  let error: string | null = null;
  let qr: string | null = null;
  let engine: WaEngine | null = null;
  let starting: Promise<void> | null = null;
  let stopping = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restarts = 0;
  let pairTimer: ReturnType<typeof setTimeout> | undefined;
  const tracked = new Set<string>(); // phone digits
  const chats = new Map<string, Message[]>(); // digits -> messages (oldest first)
  const raws = new Map<string, Json>(); // message id -> raw (media, quoted replies)
  const lids = new Map<string, string>(); // lid jid -> phone jid
  const readIds = new Set<string>(); // their messages already marked read
  const early = new Map<string, MessageStatus | undefined>(); // message id -> status that came before the message
  const watched = new Set<string>(); // jids whose presence we subscribed to (this engine connection)
  const online = new Map<string, PresenceStatus>(); // digits -> online | offline (live)
  const lastSeen = new Map<string, number>(); // digits -> ms, when their privacy shows it
  // the account's contacts by phone digits: name = saved in the address book; notify = their
  // WhatsApp name (pushname); verifiedName = a business's verified name
  const contacts = new Map<string, Contact>();
  let contactsAt = "";
  const pacer = wa.createPacer();
  // profile photo lookups: one at a time, a few seconds apart, never in bulk
  const photoPacer = wa.createPacer({ minGap: 1500, maxGap: 3000 });

  try {
    const c = obj(JSON.parse(readFileSync(CACHE, "utf8")));
    for (const [k, v] of Object.entries(obj(c.chats))) if (Array.isArray(v)) chats.set(k, (v as Message[]).slice(-KEEP));
    for (const [k, v] of Object.entries(obj(c.raws))) raws.set(k, obj(v));
    for (const [k, v] of Object.entries(obj(c.lids))) if (typeof v === "string") lids.set(k, v);
    for (const [k, v] of Object.entries(obj(c.contacts))) if (v && typeof v === "object") contacts.set(k, v as Contact);
    if (typeof c.contactsAt === "string") contactsAt = c.contactsAt;
    for (const [k, v] of Object.entries(obj(c.lastSeen))) if (typeof v === "number") lastSeen.set(k, v);
  } catch {
    // none yet
  }

  const meUser = (): ChannelUser | null =>
    me ? { id: me.id, username: me.phone ? `+${me.phone}` : me.name, globalName: me.name || (me.phone ? `+${me.phone}` : "WhatsApp"), avatar: null, avatarUrl: "" } : null;
  const state = (): ConnState => ({ status, me: meUser(), gateway: status === "connected" ? "up" : "down", error, qr });
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
    if (s !== "signing-in") {
      clearTimeout(pairTimer);
      pairTimer = undefined;
    }
    pushState();
  };

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  async function writeCache(): Promise<void> {
    const keep: Record<string, Message[]> = {};
    const keepRaw: Record<string, Json> = {};
    for (const [k, v] of chats)
      if (tracked.has(k)) {
        keep[k] = v.slice(-KEEP);
        for (const m of keep[k]) {
          const r = raws.get(m.id);
          if (r) keepRaw[m.id] = r;
        }
      }
    try {
      await mkdir(DIR, { recursive: true, mode: 0o700 });
      const body = { version: 1, chats: keep, raws: keepRaw, lids: Object.fromEntries(lids), contacts: Object.fromEntries(contacts), contactsAt, lastSeen: Object.fromEntries([...lastSeen].filter(([k]) => tracked.has(k))) };
      await writeAtomic(CACHE, JSON.stringify(body));
    } catch (e) {
      log("cache write failed", msg(e));
    }
  }
  function save(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void writeCache();
    }, 1500);
  }

  // ---------- the engine ----------
  function call(op: string, args: Json = {}, waitMs?: number): Promise<Json> {
    if (!engine || !engine.running()) return Promise.reject(new Error("WhatsApp isn’t started"));
    return engine.request(op, args, waitMs);
  }

  /** The phone jid a direct chat is with (lids resolved), or '' for groups and broadcasts. */
  function chatJid(raw: Json): string {
    const k = obj(raw.key);
    let jid = wa.normJid(String(k.remoteJid ?? ""));
    if (wa.skipped(jid) || wa.isGroup(jid)) return "";
    if (wa.isLid(jid)) {
      const alt = k.remoteJidAlt ? wa.normJid(String(k.remoteJidAlt)) : "";
      if (alt && wa.isPhone(alt)) {
        lids.set(jid, alt);
        jid = alt;
      } else {
        const known = lids.get(jid);
        if (!known) return "";
        jid = known;
      }
    }
    return wa.isPhone(jid) ? jid : "";
  }

  function take(rawv: unknown, live: boolean): void {
    const raw = obj(rawv);
    const jid = chatJid(raw);
    if (!jid) return;
    const digits = wa.digitsOf(jid);
    const m = wa.slimWa(raw, jid, id);
    if (!m) return;
    if (m.attachments || live) raws.set(m.id, raw); // media keys for downloads, recent ones for quoted replies
    const list = chats.get(digits) ?? [];
    const i = list.findIndex((x) => x.id === m.id);
    // the ticks only move forward: a re-sent copy (or a receipt that came first) keeps the best status
    if (m.fromMe) {
      const st = wa.mergeStatus(wa.mergeStatus(i >= 0 ? list[i]?.status : undefined, early.get(m.id)), m.status);
      early.delete(m.id);
      if (st) m.status = st;
    }
    if (i >= 0) list[i] = m;
    else list.push(m);
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    chats.set(digits, list.slice(-KEEP));
    if (tracked.has(digits)) {
      ctx.emit({ type: "messages", peerId: digits, messages: [m] });
      save();
    }
  }

  /** A status change of one of our messages (messages.update, or a send that went through): kept (forward only) and sent as the message again. */
  function bumpStatus(keyv: unknown, next: MessageStatus | undefined): void {
    const key = obj(keyv);
    const msgId = String(key.id ?? "");
    if (!msgId || !next) return;
    const hinted = wa.digitsOf(chatJid({ key }));
    let digits = hinted && chats.get(hinted)?.some((x) => x.id === msgId) ? hinted : "";
    if (!digits)
      for (const [d, l] of chats)
        if (l.some((x) => x.id === msgId)) {
          digits = d;
          break;
        }
    if (!digits) {
      // a receipt before the message itself: applied when it arrives
      early.set(msgId, wa.mergeStatus(early.get(msgId), next));
      if (early.size > 300) {
        const first = early.keys().next().value;
        if (first !== undefined) early.delete(first);
      }
      return;
    }
    const list = chats.get(digits) ?? [];
    const i = list.findIndex((x) => x.id === msgId);
    const m = list[i];
    if (!m || !m.fromMe) return;
    const st = wa.mergeStatus(m.status, next);
    if (st === m.status || !st) return;
    const updated: Message = { ...m, status: st };
    list[i] = updated;
    if (tracked.has(digits)) {
      ctx.emit({ type: "messages", peerId: digits, messages: [updated] });
      save();
    }
  }

  /** A contact from Baileys (contacts.upsert / update, history): kept by phone digits. */
  function takeContact(cv: unknown): void {
    const c = obj(cv);
    let jid = wa.normJid(String(c.id ?? ""));
    if (!wa.isPhone(jid) && c.phoneNumber) jid = wa.normJid(String(c.phoneNumber));
    if (wa.isLid(jid)) jid = lids.get(jid) ?? "";
    const digits = wa.digitsOf(jid);
    if (!digits) return;
    const next: Contact = { ...(contacts.get(digits) ?? {}) };
    if (typeof c.name === "string") next.name = c.name;
    if (typeof c.notify === "string") next.notify = c.notify;
    if (typeof c.verifiedName === "string") next.verifiedName = c.verifiedName;
    contacts.set(digits, next);
    save();
  }

  /** The whole address book, read once per link (links made before contacts were kept). */
  let snapshot: Promise<void> | null = null;
  function loadContacts(): Promise<void> {
    if (contactsAt) return Promise.resolve();
    snapshot ??= call("contacts_snapshot")
      .then(() => {
        contactsAt = new Date().toISOString();
        save();
      })
      .catch((e: unknown) => log("contacts snapshot failed", msg(e)))
      .finally(() => {
        snapshot = null;
      });
    return snapshot;
  }

  function onEvent(ev: string, data: unknown): void {
    const d = obj(data);
    switch (ev) {
      case "contacts.upsert":
      case "contacts.update":
        for (const c of arr(data)) takeContact(c);
        break;
      case "qr":
        qr = String(d.qr ?? "") || null;
        if (status !== "connected") setStatus("signing-in");
        break;
      case "open": {
        // a new connection: presence subscriptions and our "online" start over (we connect as unavailable)
        watched.clear();
        available = false;
        clearTimeout(availTimer);
        dropOnline();
        restarts = 0;
        const phone = wa.digitsOf(wa.normJid(String(d.id ?? "")));
        me = { id: String(d.id ?? ""), phone, name: String(d.name ?? "") };
        qr = null;
        setStatus("connected");
        break;
      }
      case "close":
        if (d.loggedOut === true) {
          log("logged out by the phone");
          void forget("WhatsApp ended this link: link it again");
        } else if (d.refused === true) {
          log("link refused");
          void halt("WhatsApp refused the link: try again");
        } else if (status === "connected") setStatus("connecting");
        break;
      case "lid-mapping.update":
        for (const x of Array.isArray(data) ? data.map(obj) : [d]) if (typeof x.lid === "string" && typeof x.pn === "string") lids.set(wa.normJid(x.lid), wa.normJid(x.pn));
        break;
      case "messaging-history.set":
        for (const c of arr(d.contacts)) takeContact(c);
        for (const r of arr(d.messages)) take(r, false);
        save();
        break;
      case "presence.update": {
        // their typing / recording, online and last seen in a direct chat
        let jid = wa.normJid(String(d.id ?? ""));
        if (wa.isLid(jid)) jid = lids.get(jid) ?? "";
        if (!wa.isPhone(jid)) break;
        const digits = wa.digitsOf(jid);
        if (!tracked.has(digits)) break;
        const p = wa.parsePresence(data);
        if (!p) break;
        const kind = p.activity;
        ctx.emit({ type: "typing", peerId: digits, kind: kind ?? "typing", until: kind ? Date.now() + 10_000 : 0 });
        const st: PresenceStatus = p.online ? "online" : "offline";
        const seenChanged = p.lastSeen !== undefined && lastSeen.get(digits) !== p.lastSeen;
        if (seenChanged && p.lastSeen !== undefined) {
          lastSeen.set(digits, p.lastSeen);
          save();
        }
        if (online.get(digits) !== st || seenChanged) {
          online.set(digits, st);
          const seen = lastSeen.get(digits);
          ctx.emit(seen !== undefined ? { type: "presence", presence: { [digits]: st }, lastSeen: { [digits]: seen } } : { type: "presence", presence: { [digits]: st } });
        }
        break;
      }
      case "messages.upsert":
        for (const r of arr(d.messages)) take(r, true);
        break;
      case "messages.update":
        // delivery / read receipts of direct chats (groups come as message-receipt.update: not shown here)
        for (const uv of arr(data)) {
          const u = obj(uv);
          const upd = obj(u.update);
          if (obj(u.key).fromMe !== true || upd.status === undefined || upd.status === null) continue;
          bumpStatus(u.key, wa.waStatus(upd.status));
        }
        break;
    }
  }

  function onExit(): void {
    engine = null;
    if (stopping || status === "signed-out") return;
    // the engine went away by itself: start it again (gently) while there's a link
    if (!linked()) {
      setStatus("signed-out", "WhatsApp stopped before it was linked");
      return;
    }
    setStatus("connecting", "WhatsApp's engine stopped: starting it again");
    const wait = Math.min(5 * 60_000, 5000 * 2 ** restarts++);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!stopping && !engine) void startEngine().catch((e: unknown) => log("restart failed", msg(e)));
    }, wait);
  }

  function startEngine(): Promise<void> {
    if (engine?.running()) return Promise.resolve();
    starting ??= (async () => {
      stopping = false;
      await mkdir(DIR, { recursive: true, mode: 0o700 });
      const e = makeEngine({ authDir: AUTH, logFile: join(DIR, "engine.log"), say: (s) => log(s) });
      engine = e;
      try {
        await e.start(onEvent, onExit);
      } catch (err) {
        engine = null;
        await e.stop().catch(() => {});
        throw err;
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  /** Stops the engine (the link stays on disk). */
  async function halt(reason?: string): Promise<void> {
    stopping = true;
    clearTimeout(restartTimer);
    const e = engine;
    engine = null;
    await e?.stop().catch(() => {});
    qr = null;
    if (reason !== undefined) setStatus("signed-out", reason);
  }

  async function forget(reason?: string): Promise<void> {
    await halt();
    me = null;
    qr = null;
    await rm(AUTH, { recursive: true, force: true }).catch(() => {});
    setStatus("signed-out", reason ?? null);
  }

  const linked = (): boolean => {
    try {
      return !!obj(JSON.parse(readFileSync(join(AUTH, "creds.json"), "utf8"))).me;
    } catch {
      return false;
    }
  };
  const needConnected = (): void => {
    if (status !== "connected") throw new Error("Link WhatsApp first");
  };

  /** A message's media, downloaded once into media/<message id>. */
  async function mediaFile(msgId: string): Promise<string> {
    const file = join(MEDIA, wa.safeFileName(msgId));
    if ((await mtime(file)) !== undefined) return file;
    const raw = raws.get(msgId);
    if (!raw) throw new Error("Media not available");
    await mkdir(MEDIA, { recursive: true, mode: 0o700 });
    await call("download", { message: raw, to: file });
    return file;
  }

  // ---------- presence ----------
  // WhatsApp sends others' presence while this device is online. We connect as unavailable (the
  // phone keeps its notifications), so it's "online" only while a WhatsApp chat is open here: a
  // few minutes after the last watch, then unavailable again (as WhatsApp Web when it's closed).
  const AVAILABLE_MS = 3 * 60_000;
  let available = false;
  let availTimer: ReturnType<typeof setTimeout> | undefined;
  async function beAvailable(): Promise<void> {
    clearTimeout(availTimer);
    availTimer = setTimeout(() => void beUnavailable(), AVAILABLE_MS);
    if (available) return;
    available = true;
    await call("presence", { type: "available" }).catch(() => {
      available = false;
    });
    void subscribeRecent();
  }
  async function beUnavailable(): Promise<void> {
    if (!available) return;
    available = false;
    await call("presence", { type: "unavailable" }).catch(() => {});
    dropOnline();
  }
  /** While we're unavailable WhatsApp stops telling us: "online" isn't known any more (last seen stays). */
  function dropOnline(): void {
    if (!online.size) return;
    const gone: Record<string, PresenceStatus | null> = {};
    for (const d of online.keys()) gone[d] = null;
    online.clear();
    ctx.emit({ type: "presence", presence: gone });
  }
  /** Subscribes to a number's presence, once per connection. */
  async function subscribe(digits: string): Promise<void> {
    const jid = wa.jidOfPhone(digits);
    if (watched.has(jid)) return;
    watched.add(jid);
    await call("presence_subscribe", { jid }).catch(() => {
      watched.delete(jid);
    });
  }
  /** The people in the app talked to most recently (up to 12, paced): their rows show online too. */
  let subscribing = false;
  async function subscribeRecent(): Promise<void> {
    if (subscribing) return;
    subscribing = true;
    try {
      const recent = [...tracked]
        .map((d): [string, string] => [d, chats.get(d)?.at(-1)?.timestamp ?? ""])
        .filter(([d, at]) => at && !watched.has(wa.jidOfPhone(d)) && Date.now() - Date.parse(at) < 14 * 86_400_000)
        .sort((a, b) => b[1].localeCompare(a[1]))
        .slice(0, 12);
      for (const [d] of recent) {
        if (!available || status !== "connected") break;
        await sleep(2000 + Math.random() * 1500);
        await subscribe(d);
      }
    } finally {
      subscribing = false;
    }
  }

  // ---------- profile photos (Person Hub's chavatar://wa) ----------
  const photoAsking = new Map<string, Promise<string | null>>();
  const photoFailed = new Map<string, number>();
  const photoFile = (digits: string, type: string): string => join(AVATARS, `wa_${digits}_${type}.jpg`);
  /** Person Hub's files had no extension: renamed once so the picture loads by its name. */
  async function adoptLegacy(digits: string, type: string): Promise<void> {
    const legacy = join(AVATARS, `wa_${digits}_${type}`);
    const file = photoFile(digits, type);
    if ((await mtime(legacy)) === undefined || (await mtime(file)) !== undefined) return;
    await rename(legacy, file).catch(() => {});
  }
  /** Someone's profile photo URL (short-lived, pps.whatsapp.net): '' when they have none or their privacy hides it; throws when WhatsApp couldn't be asked. Paced. */
  async function photoUrl(digits: string, type: "preview" | "image"): Promise<string> {
    if (status !== "connected") throw new Error("WhatsApp isn’t connected");
    const wait = photoPacer.reserve();
    if (wait) await sleep(wait);
    const r = await call("profile_picture", { jid: wa.jidOfPhone(digits), type });
    return String(r.url ?? "");
  }
  /**
   * The profile photo of a number as a local file: asked of WhatsApp at most once a day per person
   * and size, "hidden / none" remembered too (a .none marker); offline, the last photo of any age.
   */
  async function photo(peer: string, type: "preview" | "image" = "preview"): Promise<string | null> {
    const digits = wa.normPhone(peer);
    if (!digits) return null;
    await adoptLegacy(digits, type);
    const file = photoFile(digits, type);
    const none = join(AVATARS, `wa_${digits}_${type}.none`);
    const [fileMs, noneMs] = await Promise.all([mtime(file), mtime(none)]);
    let st = wa.photoCache(fileMs, noneMs);
    if (st === "ask" && type === "preview") {
      // the big one, fresh, does for a row too
      await adoptLegacy(digits, "image");
      const big = photoFile(digits, "image");
      const [bigMs, bigNone] = await Promise.all([mtime(big), mtime(join(AVATARS, `wa_${digits}_image.none`))]);
      const b = wa.photoCache(bigMs, bigNone);
      if (b === "photo") return big;
      if (b === "none") st = "none";
    }
    if (st === "photo") return file;
    if (st === "none") return null;
    const stale = fileMs !== undefined ? file : null;
    if (status !== "connected" || Date.now() - (photoFailed.get(file) ?? 0) < 10 * 60_000) return stale;
    let p = photoAsking.get(file);
    if (!p) {
      p = (async (): Promise<string | null> => {
        try {
          const url = await photoUrl(digits, type);
          await mkdir(AVATARS, { recursive: true, mode: 0o700 });
          if (!url) {
            await rm(file, { force: true });
            await writeFile(none, "");
            return null;
          }
          const res = await http(url, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`photo ${res.status}`);
          await writeAtomic(file, new Uint8Array(await res.arrayBuffer()));
          await rm(none, { force: true });
          return file;
        } catch (e) {
          log("photo:", msg(e));
          photoFailed.set(file, Date.now());
          return stale;
        } finally {
          photoAsking.delete(file);
        }
      })();
      photoAsking.set(file, p);
    }
    return p;
  }

  async function sendOne(jid: string, content: Json, quoted?: Json): Promise<Json | undefined> {
    const r = await call("send", quoted ? { jid, content, quoted } : { jid, content });
    const last = r.message === undefined || r.message === null ? undefined : obj(r.message);
    if (last) {
      take(last, true);
      bumpStatus(last.key, "sent");
    }
    return last;
  }

  return {
    id: ctx.id,
    kind: ctx.kind,
    section: ctx.section,
    state,
    async start() {
      stopping = false;
      if (linked()) {
        setStatus("connecting");
        startEngine().catch((e: unknown) => {
          log("start failed", msg(e));
          setStatus("connecting", msg(e));
        });
      } else setStatus("signed-out");
    },
    async connect() {
      if (status === "connected" || status === "signing-in") return state();
      setStatus("signing-in");
      clearTimeout(pairTimer);
      pairTimer = setTimeout(() => {
        if (status === "signing-in" && !linked()) void halt("The QR code wasn’t scanned in time: link again");
      }, PAIR_WAIT);
      startEngine().catch((e: unknown) => {
        log("start failed", msg(e));
        setStatus("signed-out", msg(e));
      });
      return state();
    },
    async disconnect() {
      try {
        if (engine && status === "connected") await call("logout");
      } catch {
        // unlink locally anyway
      }
      await forget();
      chats.clear();
      raws.clear();
      clearTimeout(saveTimer);
      await rm(DIR, { recursive: true, force: true }).catch(() => {});
      await rm(FILES, { recursive: true, force: true }).catch(() => {});
      return state();
    },
    async track(peers) {
      tracked.clear();
      for (const n of peers) {
        const d = wa.normPhone(n);
        if (d) tracked.add(d);
      }
      const out: Record<string, Conversation> = {};
      for (const d of tracked) {
        const m = chats.get(d);
        if (m) out[d] = { channelId: wa.jidOfPhone(d), messages: m };
      }
      const pres: Record<string, PresenceStatus | null> = {};
      const seen: Record<string, number> = {};
      for (const d of tracked) {
        const o = online.get(d);
        if (o) pres[d] = o;
        const s = lastSeen.get(d);
        if (s !== undefined) seen[d] = s;
      }
      if (Object.keys(pres).length || Object.keys(seen).length) setTimeout(() => ctx.emit({ type: "presence", presence: pres, lastSeen: seen }), 0);
      return out;
    },
    /**
     * A number on WhatsApp (Add members): whether it has an account (with and without a Brazilian
     * mobile's 9th digit), their photo and name. `id` is the number as WhatsApp has it; `saved`: in
     * the address book (undefined: not known yet).
     */
    async lookup(q) {
      if (status !== "connected") return { matches: [], notes: ["WhatsApp isn’t connected"] };
      const typed = wa.normWhatsApp(q);
      if (!typed) return { matches: [], notFound: true };
      void loadContacts();
      const found = await call("on_whatsapp", { phones: wa.phoneVariants(typed).map(wa.jidOfPhone) });
      const hit = arr(found.found)
        .map(obj)
        .find((x) => x.exists && wa.isPhone(wa.normJid(String(x.jid ?? ""))));
      if (!hit) return { matches: [], notFound: true };
      const jid = wa.normJid(String(hit.jid));
      const digits = wa.digitsOf(jid);
      const pic = await call("profile_picture", { jid }).catch(() => ({ url: "" }) as Json);
      const c = contacts.get(digits) ?? {};
      const name = c.name || c.verifiedName || c.notify || "";
      const user: ChannelUser = { id: digits, username: `+${digits}`, globalName: name || null, avatar: null, avatarUrl: String(pic.url ?? "") };
      return c.name ? { matches: [user], saved: true } : contactsAt ? { matches: [user], saved: false } : { matches: [user] };
    },
    /** Saves the number in the account's address book under `name` (the phone's contacts too), unless it's there already. */
    async saveContact(peer, name) {
      needConnected();
      const d = wa.normPhone(peer);
      const n = String(name ?? "")
        .trim()
        .slice(0, 100);
      if (!d || !n) return { ok: false, error: "A number and a name" };
      await Promise.race([loadContacts(), sleep(20_000)]);
      if (contacts.get(d)?.name) return { ok: true, already: true };
      if (!contactsAt) return { ok: false, error: "Couldn’t read your WhatsApp contacts" };
      try {
        await call("add_contact", { jid: wa.jidOfPhone(d), name: n });
      } catch (e) {
        return { ok: false, error: msg(e) };
      }
      contacts.set(d, { ...(contacts.get(d) ?? {}), name: n });
      save();
      return { ok: true, saved: true };
    },
    async user() {
      return null;
    },
    /** Read in Hub: read receipts for their messages (the blue ticks), as the phone sends them. */
    async markRead(peer) {
      needConnected();
      const d = wa.normPhone(peer);
      const keys = (chats.get(d) ?? [])
        .filter((m) => !m.fromMe && !readIds.has(m.id) && raws.get(m.id)?.key)
        .map((m) => obj(raws.get(m.id)?.key));
      if (!keys.length) return { ok: true };
      await call("read", { keys });
      for (const k of keys) readIds.add(String(k.id));
      return { ok: true };
    },
    /** Mark as unread: kept in Hub only (the engine has no "mark chat unread"). */
    async markUnread(peer, messageId) {
      const list = chats.get(wa.normPhone(peer)) ?? [];
      const i = list.findIndex((m) => m.id === String(messageId));
      for (const m of i >= 0 ? list.slice(i) : []) readIds.delete(m.id);
      return { ok: true, local: true };
    },
    /** I'm typing (or stopped): WhatsApp's composing / paused. Also subscribes to theirs. */
    async typing(peer, on) {
      if (status !== "connected") return { ok: false };
      const d = wa.normPhone(peer);
      if (!d) return { ok: false };
      if (on !== false) await beAvailable();
      await subscribe(d);
      await call("presence", { jid: wa.jidOfPhone(d), type: on === false ? "paused" : "composing" }).catch(() => {});
      return { ok: true };
    },
    /** Their chat is open (repeated about every minute while it stays open): online for a few minutes and subscribed to their presence. */
    async watch(peer) {
      if (status !== "connected") return { ok: false };
      const d = wa.normPhone(peer);
      if (!d) return { ok: false };
      await beAvailable();
      await subscribe(d);
      return { ok: true };
    },
    async history(peer, before) {
      const d = wa.normPhone(peer);
      if (!d) throw new Error("Invalid number");
      const jid = wa.jidOfPhone(d);
      const have = chats.get(d) ?? [];
      const anchor = before ? have.find((m) => m.id === before) : undefined;
      if (before && !anchor) return { channelId: jid, messages: [] };
      // the page before it (or the newest) from Hub's own WhatsApp store, when it's this account's: a chat added
      // after this link's history sync has its past there
      const page = store && me?.phone ? store.page(me.phone, d, anchor ? Math.floor(Date.parse(anchor.timestamp) / 1000) : null) : { raws: [], more: false };
      if (page.raws.length) {
        const byId = new Map(have.map((m) => [m.id, m]));
        for (const raw of page.raws) {
          const m = wa.slimWa(raw, jid, id);
          if (!m || byId.has(m.id)) continue;
          byId.set(m.id, m);
          if (m.attachments || m.reply) raws.set(m.id, raw);
        }
        const list = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        // older pages stay beyond KEEP while the app runs (the cache file keeps the newest KEEP)
        chats.set(d, list);
        if (tracked.has(d)) save();
      }
      const all = chats.get(d) ?? [];
      return { channelId: jid, messages: anchor ? all.filter((m) => m.timestamp < anchor.timestamp) : all };
    },
    async send(peer: string, text: string, files?: OutgoingFile[], replyTo?: string): Promise<SendResult> {
      needConnected();
      const d = wa.normPhone(peer);
      if (!d) return { ok: false, error: "Invalid WhatsApp number" };
      let ups: wa.Upload[];
      try {
        ups = wa.checkUploads(files);
      } catch (e) {
        return { ok: false, error: msg(e) };
      }
      const body = String(text ?? "");
      if (!body.trim() && !ups.length) return { ok: false, error: "Empty message" };
      const wait = pacer.reserve();
      if (wait) await sleep(wait);
      try {
        const jid = wa.jidOfPhone(d);
        const quoted = replyTo ? raws.get(String(replyTo)) : undefined;
        let last: Json | undefined;
        const firstUp = ups[0];
        if (firstUp) {
          for (let i = 0; i < ups.length; i++) {
            const u = ups[i];
            if (!u) continue;
            last = (await sendOne(jid, wa.contentFor(u, i === 0 ? body : ""), i === 0 ? quoted : undefined)) ?? last;
          }
          // audio can't carry a caption: the text goes as its own message
          if (body.trim() && (firstUp.voice || firstUp.type.startsWith("audio/"))) last = (await sendOne(jid, { text: body })) ?? last;
        } else last = await sendOne(jid, { text: body }, quoted);
        const m = last ? wa.slimWa(last, jid, id) : undefined;
        if (m) m.status = chats.get(d)?.find((x) => x.id === m.id)?.status ?? "sent";
        return m ? { ok: true, message: m } : { ok: true };
      } catch (e) {
        return { ok: false, error: msg(e) };
      }
    },
    /** The media of a chwa:// URL, downloaded once, as a file with its name (files/<id>/). */
    async fetchAttachment(url, name) {
      const a = wa.parseMediaUrl(url);
      const src = await mediaFile(a.msgId);
      const file = join(FILES, `${wa.safeFileName(a.msgId).slice(0, 24)}-${wa.safeFileName(name || a.name)}`);
      if ((await mtime(file)) !== undefined) return file;
      await mkdir(FILES, { recursive: true, mode: 0o700 });
      await link(src, file).catch(async () => {
        await copyFile(src, file);
      });
      return file;
    },
    photo,
    async stop() {
      stopping = true;
      store?.close();
      clearTimeout(restartTimer);
      clearTimeout(pairTimer);
      clearTimeout(availTimer);
      const e = engine;
      engine = null;
      await e?.stop().catch(() => {});
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        await writeCache();
      }
    },
  };
}
