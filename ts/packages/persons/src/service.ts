// The Persons engine: Person Hub's useHub (creators-hub/src/lib/useHub.ts) moved out of the page into
// Hub's engine, so the Slint tab and the phone (routes.ts) share one state. It owns data.json, the
// connections (Discord, Gmail, WhatsApp), their conversations, presence, typing and the outgoing
// queue, and refreshes profiles and photos in the background. Every change bumps `rev`.
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allPeers, chatKey, chatsFor, KIND_LABEL, peerOf, personSections, phoneVariants, SECTION_LABEL, seenKey, serves, validPeer, type ChatRef } from "./model/accounts.ts";
import { freshIncoming, type IncomingLine } from "./incoming.ts";
import { contactConflict, personalShares, resolveContact, whatsAppContactToSave, type AddKind } from "./model/personal.ts";
import { linkPeople, unlinkPerson } from "./model/link.ts";
import { lastMessage, mergeMessages } from "./model/conversation.ts";
import { movePerson, type Place } from "./model/move.ts";
import { DEFAULT_LISTS } from "./model/data.ts";
import { applyDiscordUser, applyPhoto, applySocialPhoto, cleanUsername, emailsOf, inScope, isSettled, personLabel, photoStale, renamePerson, settlePerson, socialPhotoKey, socialPhotoSources, socialPhotoStale, staleProfiles, unsettlePerson, wakeSettled } from "./model/data.ts";
import { mergePresence, PRESENCE_RANK, rowStatus, type RowStatus } from "./model/presence.ts";
import { badgeChats, chatUnread, defaultChat, laterMark, migrateAllSeen, seenOf } from "./model/readState.ts";
import type { AppData, ChannelKind, ChannelUser, ConnEvent, ConnState, Conversation, LookupResult, Message, OutgoingFile, Person, PresenceStatus, SectionId, SendResult } from "./model/types.ts";
import type { Connection, ConnFactory, ConnMeta } from "./conn/types.ts";
import { DataFile, loadConnections, personsDir, saveConnections } from "./store.ts";

export interface Outgoing {
  key: string;
  text: string;
  files?: OutgoingFile[];
  replyTo?: string;
  subject?: string;
  status: "sending" | "failed";
  error?: string;
  at: string;
}

export type Typing = Record<string, { kind: "typing" | "recording"; until: number }>;

export interface Slice {
  state: ConnState;
  convos: Record<string, Conversation>;
  outgoing: Record<string, Outgoing[]>;
  presence: Record<string, PresenceStatus>;
  lastSeen: Record<string, number>;
  typing: Typing;
}

/** A connection as the views see it (meta + live slice). */
export interface ConnView extends ConnMeta, Slice {
  label: string;
  connected: boolean;
}

/** Add contact's outcome: the person, and when they were already in Persons, as whom and what changed. */
export interface AddedContact {
  person: Person;
  existed: boolean;
  /** Their name before (existed). */
  was: string;
  /** They weren't in Personal before. */
  joined: boolean;
  /** The name typed became theirs. */
  renamed: boolean;
}

export interface RowInfo {
  lastAt?: string;
  unread: number;
  presence?: PresenceStatus;
  status?: RowStatus;
  channel?: ChannelKind;
  typing?: "typing" | "recording";
}

/** A person just wrote (new messages from them, live: not history, not the user's own). */
export interface Incoming {
  person: Person;
  /** The section the chat is theirs in, and the chat's key (`<connection id>:<peer>`): the API's `section` and `account`. */
  section: SectionId;
  account: string;
  channel: ChannelKind;
  lines: IncomingLine[];
}

export interface ServiceOptions {
  dir?: string;
  factories?: Partial<Record<ChannelKind, ConnFactory>>;
  openExternal?: (url: string) => void;
  /** Social profile picture of a URL (YouTube / TikTok): https URL, null = none, undefined = couldn't read. */
  socialPhoto?: (url: string) => Promise<string | null | undefined>;
  /** No background refreshes, no connections started (screenshot rig, tests). */
  offline?: boolean;
  /** Offline, the connections drawn as connected (the screenshot rig's composer); nothing is sent. */
  offlineConnected?: boolean;
}

const REFRESH_EVERY_MS = 30 * 60_000;
const emptySlice = (): Slice => ({ state: { status: "starting", me: null, gateway: "down" }, convos: {}, outgoing: {}, presence: {}, lastSeen: {}, typing: {} });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const without = <T>(o: Record<string, T>, k: string): Record<string, T> => {
  const { [k]: _gone, ...rest } = o;
  return rest;
};

export class PersonsService {
  readonly dir: string;
  data: AppData | null = null;
  metas: ConnMeta[] = [];
  private conns = new Map<string, Connection>();
  private slices = new Map<string, Slice>();
  private file: DataFile;
  private listeners = new Set<() => void>();
  private waiters = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private trackedKey = "";
  private stopped = false;
  /** Connections whose cached chats are in (track answered): before that every message would look new. */
  private ready = new Set<string>();
  /** Message ids already announced as incoming (this run). */
  private announced = new Set<string>();
  private incoming = new Set<(m: Incoming) => void>();
  rev = 1;

  constructor(private readonly o: ServiceOptions = {}) {
    this.dir = o.dir ?? personsDir();
    this.file = new DataFile(this.dir);
  }

  log(...a: unknown[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, "persons.log"), `${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`, { mode: 0o600 });
    } catch {
      // logging is best effort
    }
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    this.data = this.file.load();
    this.metas = loadConnections(this.dir);
    // Personal talks through the Stores Discord and WhatsApp (the user's own logins) and its own Instagram
    const shared = personalShares(this.metas, `personal-instagram-${randomBytes(3).toString("hex")}`);
    if (shared !== this.metas) {
      this.metas = shared;
      if (!this.o.offline) saveConnections(this.dir, this.metas);
    }
    this.data = migrateAllSeen(this.data, this.metas);
    for (const m of this.metas) this.slices.set(m.id, emptySlice());
    this.file.watch(() => this.data, (d) => {
      this.data = migrateAllSeen(d, this.metas);
      this.changed(false);
      this.retrack();
    });
    if (this.o.offline) {
      const status = this.o.offlineConnected ? "connected" : "signed-out";
      for (const m of this.metas) this.patch(m.id, (s) => ({ ...s, state: { status, me: null, gateway: this.o.offlineConnected ? "up" : "down" }, convos: this.cachedConvos(m) }));
      this.changed(false);
      return;
    }
    for (const m of this.metas) this.open(m);
    this.retrack();
    this.timers.push(setTimeout(() => void this.refreshProfiles(), 4000), setInterval(() => void this.refreshProfiles(), REFRESH_EVERY_MS));
    this.timers.push(setTimeout(() => void this.refreshPhotos(), 6000), setInterval(() => void this.refreshPhotos(), REFRESH_EVERY_MS));
    this.timers.push(setTimeout(() => void this.refreshSocialPhotos(), 8000), setInterval(() => void this.refreshSocialPhotos(), REFRESH_EVERY_MS));
    this.changed(false);
  }

  /** A connection's conversations from its cache file, without starting it (offline: the screenshot rig). */
  private cachedConvos(m: ConnMeta): Record<string, Conversation> {
    const name = m.kind === "discord" ? (m.id === "stores" ? "discord-cache.json" : m.id === "spokpay" ? "discord-cache-spokpay.json" : `discord-cache-${m.id}.json`) : m.kind === "gmail" ? `gmail-cache-${m.id}.json` : m.kind === "instagram" ? `instagram-cache-${m.id}.json` : join(`whatsapp-${m.id}`, "chats.json");
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as { conversations?: Record<string, Conversation>; chats?: Record<string, Message[]> };
      const out: Record<string, Conversation> = {};
      for (const [k, v] of Object.entries(raw.conversations ?? {})) if (v && Array.isArray(v.messages)) out[k] = { channelId: v.channelId ?? null, messages: v.messages };
      // WhatsApp's cache: the messages per number
      for (const [k, v] of Object.entries(raw.chats ?? {})) if (Array.isArray(v)) out[k] = { channelId: k, messages: v };
      return out;
    } catch {
      return {};
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.flush();
    this.file.close();
    await Promise.all([...this.conns.values()].map((c) => c.stop().catch(() => {})));
  }

  /** Writes data.json now (Hub quitting). */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.data) {
      try {
        this.file.save(this.data);
      } catch (e) {
        this.log("save failed", errText(e));
      }
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Resolves when `rev` moves past `rev` or after `ms` (the phone's long-poll). */
  waitChange(rev: number, ms: number): Promise<void> {
    if (rev !== this.rev) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /** Something derived changed (a picture arrived): views re-read, nothing is saved. */
  touch(): void {
    this.changed(false);
  }

  private changed(save = true): void {
    this.rev++;
    if (save && this.data) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flush(), 250);
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      for (const l of [...this.listeners]) {
        try {
          l();
        } catch (e) {
          this.log("listener failed", errText(e));
        }
      }
      for (const w of [...this.waiters]) w();
    }, 30);
  }

  // ---------- data ----------

  update(fn: (d: AppData) => AppData): void {
    if (!this.data) return;
    const next = fn(this.data);
    if (next === this.data) return;
    this.data = { ...next, updatedAt: new Date().toISOString() };
    this.changed();
    this.retrack();
    // socials added or removed: their picture is read soon, not at the next half-hour pass
    if (!this.o.offline && this.o.socialPhoto && this.data.people.some((p) => socialPhotoStale(p))) {
      if (this.socialKick) clearTimeout(this.socialKick);
      this.socialKick = setTimeout(() => void this.refreshSocialPhotos(), 3000);
    }
  }

  private socialKick: ReturnType<typeof setTimeout> | null = null;
  private socialRunning = false;

  person(id: string): Person | undefined {
    return this.data?.people.find((p) => p.id === id);
  }

  updatePerson(id: string, fn: (p: Person) => Person): void {
    this.update((d) => {
      let hit = false;
      const people = d.people.map((p) => {
        if (p.id !== id) return p;
        const n = fn(p);
        if (n !== p) hit = true;
        return n;
      });
      return hit ? { ...d, people } : d;
    });
  }

  rename(id: string, name: string): void {
    this.updatePerson(id, (p) => renamePerson(p, name));
  }

  /** Move to…: person `id` leaves `from` (null: everywhere) for `to` (model/move.ts). Returns the sections they left. */
  move(id: string, from: Place | null, to: Place): SectionId[] | null {
    if (!this.data) return null;
    const r = movePerson(this.data, id, from, to);
    if (!r) return null;
    this.log("moved", id, "to", to.section === "stores" ? `store ${to.store}` : to.section);
    this.update(() => r.data);
    this.flush();
    return r.left;
  }

  setSettled(id: string, section: SectionId, on: boolean): void {
    const p = this.person(id);
    if (!p) return;
    const lastAt = this.rowInfo(p, section).lastAt;
    this.updatePerson(id, (x) => (on ? settlePerson(x, section, lastAt) : unsettlePerson(x, section)));
  }

  deletePerson(id: string): void {
    this.update((d) => ({
      ...d,
      people: d.people.filter((x) => x.id !== id),
      stores: d.stores.map((s) => {
        if (s.ownerId !== id) return s;
        const { ownerId: _o, ...rest } = s;
        return rest;
      }),
    }));
  }

  newId(prefix = "p"): string {
    return `${prefix}_${randomBytes(6).toString("hex")}`;
  }

  /** Settled people with a newer message in that section come back (Harbor's rule). */
  private wake(): void {
    if (!this.data) return;
    const lastAt = (p: Person, section: string): string | undefined => this.rowInfo(p, section as SectionId).lastAt;
    if (!this.data.people.some((p) => Object.keys(p.settled ?? {}).some((sec) => !isSettled(p, sec, lastAt(p, sec))))) return;
    this.update((d) => wakeSettled(d, lastAt));
  }

  // ---------- connections ----------

  private patch(id: string, fn: (s: Slice) => Slice): void {
    const cur = this.slices.get(id) ?? emptySlice();
    const next = fn(cur);
    if (next === cur) return;
    this.slices.set(id, next);
    this.changed(false);
  }

  private open(m: ConnMeta): void {
    const f = this.o.factories?.[m.kind];
    if (!f) {
      this.patch(m.id, (s) => ({ ...s, state: { status: "signed-out", me: null, gateway: "down", error: `${KIND_LABEL[m.kind]} isn't available in this build` } }));
      return;
    }
    const conn = f({
      ...m,
      dir: this.dir,
      emit: (ev) => this.onEvent(m.id, ev),
      log: (...a) => this.log(`${m.kind}[${m.id}]`, ...a),
      openExternal: (url) => this.o.openExternal?.(url),
    });
    this.conns.set(m.id, conn);
    this.patch(m.id, (s) => ({ ...s, state: conn.state() }));
    void conn.start().then(
      () => {
        this.patch(m.id, (s) => ({ ...s, state: conn.state() }));
        this.trackedKey = "";
        this.retrack();
      },
      (e) => this.log(`start ${m.id} failed`, errText(e)),
    );
  }

  private onEvent(id: string, ev: ConnEvent): void {
    if (this.stopped) return;
    if (ev.type === "state") {
      const was = this.slices.get(id)?.state.status;
      this.patch(id, (s) => ({ ...s, state: ev.state }));
      if (ev.state.status === "connected" && was !== "connected") {
        this.trackedKey = "";
        this.retrack();
      }
    } else if (ev.type === "messages") {
      const before = this.slices.get(id)?.convos[ev.peerId];
      this.patch(id, (s) => {
        const t = ev.messages.some((x) => !x.fromMe) && s.typing[ev.peerId] ? without(s.typing, ev.peerId) : s.typing;
        return { ...s, typing: t, convos: { ...s.convos, [ev.peerId]: mergeMessages(s.convos[ev.peerId], ev.messages) } };
      });
      this.wake();
      if (this.ready.has(id) && this.incoming.size > 0) this.announce(id, ev.peerId, before, ev.messages);
    } else if (ev.type === "typing") {
      this.patch(id, (s) => ({ ...s, typing: ev.until > Date.now() ? { ...s.typing, [ev.peerId]: { kind: ev.kind, until: ev.until } } : without(s.typing, ev.peerId) }));
      if (ev.until > Date.now()) setTimeout(() => this.patch(id, (s) => (s.typing[ev.peerId]?.until === ev.until ? { ...s, typing: without(s.typing, ev.peerId) } : s)), ev.until - Date.now() + 50);
    } else if (ev.type === "delete") {
      this.patch(id, (s) => {
        const c = s.convos[ev.peerId];
        return c ? { ...s, convos: { ...s.convos, [ev.peerId]: { ...c, messages: c.messages.filter((x) => x.id !== ev.messageId) } } } : s;
      });
    } else if (ev.type === "presence") {
      this.patch(id, (s) => {
        const presence = mergePresence(s.presence, ev.presence);
        const lastSeen = ev.lastSeen ? { ...s.lastSeen, ...ev.lastSeen } : s.lastSeen;
        return presence === s.presence && lastSeen === s.lastSeen ? s : { ...s, presence, lastSeen };
      });
    } else if (ev.type === "users") {
      this.applyUsers(ev.users);
    }
  }

  private applyUsers(users: ChannelUser[]): void {
    const byId = new Map(users.map((u) => [u.id, u]));
    this.update((d) => {
      let changed = false;
      const people = d.people.map((p) => {
        const u = p.discordId ? byId.get(p.discordId) : undefined;
        let n = u ? applyDiscordUser(p, u) : p;
        if (n.identities?.some((i) => i.kind === "discord" && byId.has(i.value))) {
          const at = new Date().toISOString();
          const ids = n.identities.map((i) => {
            const v = i.kind === "discord" ? byId.get(i.value) : undefined;
            if (!v || (v.username === i.username && v.avatar === i.avatar && (v.globalName ?? undefined) === i.displayName)) return i;
            const x = { ...i, username: v.username, avatar: v.avatar ?? null, profileAt: at };
            if (v.globalName) x.displayName = v.globalName;
            else delete x.displayName;
            return x;
          });
          if (ids.some((i, k) => i !== n.identities![k])) n = { ...n, identities: ids };
        }
        if (n !== p) changed = true;
        return n;
      });
      return changed ? { ...d, people } : d;
    });
  }

  /** Each connection follows the people with an identifier of its kind. */
  private retrack(): void {
    if (!this.data || this.o.offline) return;
    const keyFor = (kind: ChannelKind): string[] => [...new Set((this.data?.people ?? []).flatMap((p) => allPeers(p, kind)))].sort();
    const key = JSON.stringify([keyFor("discord"), keyFor("gmail"), keyFor("whatsapp"), keyFor("instagram"), this.metas.map((m) => `${m.id}:${this.slices.get(m.id)?.state.status}`)]);
    if (key === this.trackedKey) return;
    this.trackedKey = key;
    for (const m of this.metas) {
      const c = this.conns.get(m.id);
      if (!c) continue;
      void c.track(keyFor(m.kind)).then(
        (cached) => {
          this.patch(m.id, (s) => {
            const n = { ...s.convos };
            for (const [pid, conv] of Object.entries(cached)) n[pid] = mergeMessages(n[pid], conv.messages, conv.channelId);
            return { ...s, convos: n };
          });
          this.ready.add(m.id);
          this.wake();
        },
        (e) => this.log(`track ${m.id} failed`, errText(e)),
      );
    }
  }

  conn(id: string): Connection | undefined {
    return this.conns.get(id);
  }

  /** Hears every person's new incoming messages (Hub's phone notifications); returns the unsubscribe. */
  onIncoming(f: (m: Incoming) => void): () => void {
    this.incoming.add(f);
    return () => this.incoming.delete(f);
  }

  /** A "messages" event's news for whoever in Persons that chat is (freshIncoming), told to onIncoming's listeners. */
  private announce(connId: string, peer: string, before: Conversation | undefined, msgs: Message[]): void {
    const m = this.metas.find((x) => x.id === connId);
    if (!m || !this.data || !msgs.some((x) => !x.fromMe)) return;
    const views = this.views();
    const same = (v: string): boolean => (m.kind === "whatsapp" ? v === peer || phoneVariants(v).includes(peer) || phoneVariants(peer).includes(v) : v === peer);
    for (const p of this.data.people) {
      const chat = chatsFor(p, views, null).find((c) => c.conn.id === connId && same(c.peer));
      if (!chat) continue;
      const lines = freshIncoming(before, msgs, Date.now(), this.announced, seenOf(p, connId, chat.peer));
      if (!lines.length) return;
      for (const l of lines) this.announced.add(l.id);
      if (this.announced.size > 5000) this.announced = new Set([...this.announced].slice(-2500));
      const section = personSections(p).find((s) => serves(m, s)) ?? (p.carried ?? []).find((s) => serves(m, s)) ?? m.section;
      const ev: Incoming = { person: p, section, account: chatKey(chat), channel: m.kind, lines };
      for (const f of [...this.incoming]) {
        try {
          f(ev);
        } catch (e) {
          this.log("incoming listener failed", errText(e));
        }
      }
      return;
    }
  }

  views(): ConnView[] {
    return this.metas.map((m) => {
      const s = this.slices.get(m.id) ?? emptySlice();
      return { ...m, ...s, label: `${SECTION_LABEL[m.section]} ${KIND_LABEL[m.kind]}`, connected: s.state.status === "connected" };
    });
  }

  view(id: string): ConnView | undefined {
    return this.views().find((v) => v.id === id);
  }

  async addConnection(section: SectionId, kind: ChannelKind): Promise<ConnMeta> {
    const m: ConnMeta = { id: `${section}-${kind}-${randomBytes(3).toString("hex")}`, kind, section };
    this.metas = [...this.metas, m];
    saveConnections(this.dir, this.metas);
    this.slices.set(m.id, emptySlice());
    this.open(m);
    this.changed(false);
    const c = this.conns.get(m.id);
    if (c) void c.connect().then((st) => this.patch(m.id, (s) => ({ ...s, state: st })), (e) => this.log("connect failed", errText(e)));
    return m;
  }

  /** Instagram: the session pasted from a browser's cookies (sessionid=…; ds_user_id=…), checked before it's kept. */
  async setSession(id: string, cookie: string): Promise<ConnState> {
    const c = this.conns.get(id);
    if (!c?.setSession) throw new Error("That connection takes no session");
    const st = await c.setSession(cookie);
    this.patch(id, (s) => ({ ...s, state: st }));
    this.trackedKey = "";
    this.retrack();
    return st;
  }

  /**
   * Personal › Add contact: `handle` (a WhatsApp number, a Discord username, an Instagram username) resolved to who they
   * are on that platform through a connection serving Personal, then saved as a person in Personal (someone already in
   * Persons with that id just joins Personal). Throws with the reason when it can't be resolved: nothing is saved then.
   */
  /**
   * Add contact, in any section (`place`: Personal unless said; Stores takes a store): their WhatsApp number, Discord or
   * Instagram username, or email, resolved on that platform through a connection of the section (else any of that kind)
   * before anything is saved. Someone already in Persons joins the place instead.
   */
  async addContact(kind: AddKind, handle: string, name = "", confirm = false, place: Place = { section: "personal" }): Promise<AddedContact> {
    if (!this.data) throw new Error("Persons isn't loaded");
    const section = place.section;
    const store = place.section === "stores" ? place.store : "";
    if (section === "stores" && !this.data.stores.some((x) => x.id === store)) throw new Error("Pick the store they're in");
    const where = SECTION_LABEL[section] ?? section;
    let r: { id: string; username: string; displayName?: string; avatar?: string | null; photo?: string };
    if (kind === "gmail") r = await resolveContact(kind, handle, async () => ({ matches: [] }));
    else {
      const all = this.views().filter((v) => v.kind === kind);
      const views = all.filter((v) => serves(v, section));
      // the section's own connection first; else any of that kind (only to find who they are)
      const conn = views.find((v) => v.connected) ?? all.find((v) => v.connected) ?? views[0] ?? all[0];
      if (!conn) throw new Error(`No ${KIND_LABEL[kind]} connection in ${where}`);
      if (!conn.connected) throw new Error(`${KIND_LABEL[kind]} isn't connected${conn.state.error ? `: ${conn.state.error}` : ""}`);
      const c = this.conns.get(conn.id);
      if (!c) throw new Error("That connection is gone");
      r = await resolveContact(kind, handle, (q) => c.lookup(q));
    }
    const at = new Date().toISOString();
    const inPlace = (x: Person): boolean => (section === "stores" ? x.storeIds.includes(store) : x.listIds.includes(section));
    const join = (x: Person): Person => (section === "stores" ? { ...x, storeIds: [...x.storeIds, store] } : { ...x, listIds: [...x.listIds, section] });
    // the section's list, made when it isn't there yet (as moving someone in does)
    const ensureList = (): void => {
      if (section === "stores" || this.data!.lists.some((l) => l.id === section)) return;
      const def = DEFAULT_LISTS.find((l) => l.id === section);
      if (def) this.update((d) => ({ ...d, lists: [...d.lists, { ...def }] }));
    };
    // the same human already in Persons (a WhatsApp number in either Brazilian form counts): they join the place. A name
    // typed that isn't theirs, or a number WhatsApp names otherwise, stops here until the user confirms (ContactConflict):
    // a mistyped number must never rename or add someone else silently
    const same = (v: string): boolean => (kind === "whatsapp" ? phoneVariants(r.id).includes(v) || phoneVariants(v).includes(r.id) : v === r.id);
    const existing = this.data.people.find((p) => allPeers(p, kind).some(same));
    const typed = name.trim();
    const shown = kind === "whatsapp" ? `+${r.id}` : kind === "gmail" ? r.id : `@${r.username}`;
    const conflict = confirm
      ? null
      : contactConflict({ typed, handle: shown, existing: existing ? { id: existing.id, label: personLabel(existing), inPersonal: inPlace(existing) } : null, platformName: kind === "whatsapp" ? r.displayName : undefined, section: where });
    if (conflict) throw conflict;
    ensureList();
    if (existing) {
      const was = personLabel(existing);
      const joined = !inPlace(existing);
      // only a confirmed Rename changes their name
      const renamed = confirm && !!typed && typed !== existing.name;
      if (joined || renamed) this.updatePerson(existing.id, (x) => ({ ...(joined ? join(renamed ? renamePerson(x, typed) : x) : renamed ? renamePerson(x, typed) : x), updatedAt: at }));
      this.log("contact existed", section, kind, existing.id, joined ? "joined" : "", renamed ? "renamed" : "");
      // the number they were found by (their main one may be another): saved in WhatsApp contacts unless named there already
      if (kind === "whatsapp") {
        const now = this.person(existing.id) ?? existing;
        this.saveWhatsAppContact(undefined, { ...now, whatsapp: r.id });
      }
      return { person: this.person(existing.id) ?? existing, existed: true, was, joined, renamed };
    }
    let p: Person = { id: this.newId(), name: typed, discordId: "", storeIds: [], listIds: [], createdAt: at, updatedAt: at };
    p = join(p);
    if (kind === "discord") {
      p.discordId = r.id;
      p.discordUsername = r.username;
      if (r.displayName) p.displayName = r.displayName;
      if (r.avatar !== undefined) p.avatar = r.avatar;
      p.profileAt = at;
    } else if (kind === "whatsapp") {
      p.whatsapp = r.id;
      if (!p.name && r.displayName) p.name = r.displayName;
    } else if (kind === "gmail") {
      p.email = r.id;
      if (!p.name) p.name = r.id.split("@")[0] ?? r.id;
    } else {
      p.instagram = r.id;
      p.instagramUsername = r.username;
      if (r.displayName) p.displayName = r.displayName;
      if (r.photo) {
        p.photo = r.photo;
        p.photoAt = at;
      }
    }
    this.log("contact added", section, kind, p.id);
    const added = p;
    this.update((d) => ({ ...d, people: [...d.people, added] }));
    if (kind === "whatsapp") this.saveWhatsAppContact(undefined, p);
    return { person: p, existed: false, was: "", joined: true, renamed: false };
  }

  /**
   * A person just added or edited (`before` = as they were): a WhatsApp number new to them in Personal is saved in the
   * user's WhatsApp contacts (the phone's address book) under their name, through the WhatsApp connection serving Personal.
   * In the background; logged, never failing the edit.
   */
  saveWhatsAppContact(before: Person | undefined, after: Person | undefined): void {
    const want = whatsAppContactToSave(before, after);
    if (!want) return;
    const views = this.views().filter((v) => v.kind === "whatsapp" && serves(v, "personal"));
    const conn = views.find((v) => v.connected);
    const c = conn && this.conns.get(conn.id);
    if (!c?.saveContact) return this.log("whatsapp contact not saved", want.number, conn ? "no saveContact" : "no connected WhatsApp in Personal");
    void c.saveContact(want.number, want.name).then(
      (r) => this.log("whatsapp contact", want.number, r.saved ? "saved" : r.already ? "already saved" : `not saved: ${r.error ?? "?"}`),
      (e) => this.log("whatsapp contact failed", want.number, errText(e)),
    );
  }

  async removeConnection(id: string): Promise<void> {
    const c = this.conns.get(id);
    this.conns.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
    this.slices.delete(id);
    saveConnections(this.dir, this.metas);
    this.changed(false);
    if (c) {
      await c.disconnect().catch(() => {});
      await c.stop().catch(() => {});
    }
  }

  /** Signs out and forgets the session; the connection stays in its section, signed out (Instagram's way). */
  async disconnect(id: string): Promise<void> {
    const c = this.conns.get(id);
    if (!c) return;
    const st = await c.disconnect();
    this.patch(id, (s) => ({ ...s, state: st }));
  }

  connect(id: string): void {
    const c = this.conns.get(id);
    if (c) void c.connect().then((st) => this.patch(id, (s) => ({ ...s, state: st })), (e) => this.log("connect failed", errText(e)));
  }

  /** The sign-in dialog was closed: Discord stops its QR code; a WhatsApp link never made is removed (Person Hub's way). */
  async cancelSignIn(id: string): Promise<void> {
    const c = this.conns.get(id);
    const v = this.view(id);
    if (!c || !v || v.state.status !== "signing-in") return;
    if (c.cancelSignIn) c.cancelSignIn();
    else if (v.kind === "whatsapp") await this.removeConnection(id);
  }

  reconnect(id: string): void {
    const c = this.conns.get(id);
    const f = c?.reconnect ?? c?.connect;
    if (c && f) void f.call(c).then((st) => this.patch(id, (s) => ({ ...s, state: st })), (e) => this.log("reconnect failed", errText(e)));
  }

  /** A Discord connection to look people up with: the section's connected one, else any connected one. */
  discordFor(section?: SectionId | null): ConnView | undefined {
    const d = this.views().filter((c) => c.kind === "discord");
    const mine = (c: ConnView): boolean => !!section && serves(c, section);
    return d.find((c) => mine(c) && c.connected) ?? d.find((c) => c.connected) ?? d.find(mine) ?? d[0];
  }

  async lookup(connId: string, q: string): Promise<LookupResult> {
    const c = this.conns.get(connId);
    if (!c) throw new Error("That connection is gone");
    return c.lookup(q);
  }

  async loadHistory(connId: string, peer: string, before?: string): Promise<number> {
    const c = this.conns.get(connId);
    const m = this.metas.find((x) => x.id === connId);
    if (!c || !m || !validPeer(m.kind, peer)) return 0;
    const conv = await c.history(peer, before);
    // only what's new changes the state: an empty or known page must not bump `rev` (the open chat reloads on every
    // change, and a reload asks for history again)
    this.patch(connId, (s) => {
      const cur = s.convos[peer];
      const known = new Set((cur?.messages ?? []).map((m) => m.id));
      const fresh = conv.messages.some((m) => !known.has(m.id)) || (!!conv.channelId && conv.channelId !== (cur?.channelId ?? null));
      return fresh ? { ...s, convos: { ...s.convos, [peer]: mergeMessages(cur, conv.messages, conv.channelId) } } : s;
    });
    return conv.messages.length;
  }

  private setOut(id: string, pid: string, fn: (l: Outgoing[]) => Outgoing[]): void {
    this.patch(id, (s) => {
      const list = fn(s.outgoing[pid] ?? []);
      const o = { ...s.outgoing };
      if (list.length) o[pid] = list;
      else delete o[pid];
      return { ...s, outgoing: o };
    });
  }

  private async deliver(m: ConnMeta, pid: string, key: string, item: Outgoing): Promise<SendResult> {
    const c = this.conns.get(m.id);
    if (!c) return { ok: false, error: "That connection is gone" };
    let r: SendResult;
    try {
      r = await c.send(pid, item.text, item.files, item.replyTo, item.subject);
    } catch (e) {
      r = { ok: false, error: errText(e) };
    }
    if (r.ok && r.message) {
      const msg = r.message;
      this.patch(m.id, (s) => ({ ...s, convos: { ...s.convos, [pid]: mergeMessages(s.convos[pid], [msg]) } }));
      this.setOut(m.id, pid, (l) => l.filter((x) => x.key !== key));
    } else if (r.ok) this.setOut(m.id, pid, (l) => l.filter((x) => x.key !== key));
    else this.setOut(m.id, pid, (l) => l.map((x) => (x.key === key ? { ...x, status: "failed", error: r.error ?? "Not sent" } : x)));
    return r;
  }

  /** Who a person is on a connection: `peer` when it is one of theirs (a linked person's number), else their own. */
  peerFor(p: Person, m: ConnMeta, peer?: string): string {
    return peer && allPeers(p, m.kind).includes(peer) ? peer : peerOf(p, m.kind, m.section);
  }

  async send(personId: string, connId: string, text: string, opts: { files?: OutgoingFile[]; replyTo?: string; subject?: string; peer?: string } = {}): Promise<SendResult> {
    const p = this.person(personId);
    const m = this.metas.find((x) => x.id === connId);
    if (!p || !m) return { ok: false, error: "Not found" };
    const pid = this.peerFor(p, m, opts.peer);
    if (!validPeer(m.kind, pid)) return { ok: false, error: m.kind === "gmail" ? "No email address" : m.kind === "whatsapp" ? "No WhatsApp number" : m.kind === "instagram" ? "No Instagram account" : "No Discord id yet" };
    const key = `o${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const item: Outgoing = { key, text, status: "sending", at: new Date().toISOString() };
    if (opts.files?.length) item.files = opts.files;
    if (opts.replyTo) item.replyTo = opts.replyTo;
    if (opts.subject) item.subject = opts.subject;
    this.setOut(m.id, pid, (l) => [...l, item]);
    const r = await this.deliver(m, pid, key, item);
    if (r.ok) this.markSeen(personId, connId, undefined, pid);
    return r;
  }

  retry(personId: string, connId: string, key: string, peer?: string): void {
    const p = this.person(personId);
    const m = this.metas.find((x) => x.id === connId);
    if (!p || !m) return;
    const pid = this.peerFor(p, m, peer);
    const item = this.slices.get(m.id)?.outgoing[pid]?.find((x) => x.key === key);
    if (!item) return;
    const next: Outgoing = { ...item, status: "sending", at: new Date().toISOString() };
    delete next.error;
    this.setOut(m.id, pid, (l) => l.map((x) => (x.key === key ? next : x)));
    void this.deliver(m, pid, key, next);
  }

  dismiss(connId: string, peer: string, key: string): void {
    this.setOut(connId, peer, (l) => l.filter((x) => x.key !== key));
  }

  /** The chat was seen up to its newest message (also read on the platform). */
  markSeen(personId: string, connId: string, upTo?: string, who?: string): void {
    const p = this.person(personId);
    const c = this.view(connId);
    if (!p || !c) return;
    const peer = this.peerFor(p, c, who);
    if (!validPeer(c.kind, peer)) return;
    const key = seenKey(connId, peer);
    const mark = laterMark(upTo, c.convos[peer]?.messages.at(-1)?.timestamp);
    if (mark && laterMark(p.seen?.[key], mark) !== p.seen?.[key]) this.updatePerson(personId, (x) => ({ ...x, seen: { ...x.seen, [key]: mark } }));
    if (c.connected) void this.conns.get(connId)?.markRead?.(peer).catch(() => {});
  }

  markUnread(personId: string, connId: string, message: Message, who?: string): void {
    const p = this.person(personId);
    const c = this.view(connId);
    if (!p || !c) return;
    const peer = this.peerFor(p, c, who);
    const key = seenKey(connId, peer);
    const before = new Date(Date.parse(message.timestamp) - 1).toISOString();
    this.updatePerson(personId, (x) => ({ ...x, seen: { ...x.seen, [key]: before } }));
    if (c.connected) void this.conns.get(connId)?.markUnread?.(peer, message.id).catch(() => {});
  }

  sendTyping(connId: string, peer: string, on: boolean): void {
    if (this.view(connId)?.connected) void this.conns.get(connId)?.typing?.(peer, on).catch(() => {});
  }

  watch(connId: string, peer: string): void {
    if (this.view(connId)?.connected) void this.conns.get(connId)?.watch?.(peer).catch(() => {});
  }

  /** Presence of a Discord id / WhatsApp number as seen by any connection (online wins). */
  presenceOf(id: string): PresenceStatus | undefined {
    let best: PresenceStatus | undefined;
    for (const s of this.slices.values()) {
      const v = s.presence[id];
      if (v && (!best || PRESENCE_RANK[v] > PRESENCE_RANK[best])) best = v;
    }
    return best;
  }

  /** An attachment's bytes on disk (downloaded through the connection of its kind). */
  async fetchAttachment(url: string, name: string, connId?: string): Promise<string | null> {
    const kind: ChannelKind = url.startsWith("chmail:") ? "gmail" : url.startsWith("chwa:") ? "whatsapp" : /^https:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)\//.test(url) ? "instagram" : "discord";
    const views = this.views();
    const cid = connId?.split(":")[0];
    const c = (cid ? views.find((x) => x.id === cid) : undefined) ?? views.find((x) => x.kind === kind && x.connected) ?? views.find((x) => x.kind === kind);
    const conn = c ? this.conns.get(c.id) : undefined;
    if (!conn?.fetchAttachment) return null;
    return conn.fetchAttachment(url, name);
  }

  // ---------- derived ----------

  /** Card info for a person as seen from a section (null: All people). App.tsx `info`. */
  rowInfo(p: Person, section: SectionId | null = null): RowInfo {
    const views = this.views();
    const chans = badgeChats(p, views, section);
    const readSince = this.data?.readSince;
    let unread = 0;
    let typing: "typing" | "recording" | undefined;
    let lastAt = "";
    let channel: ChannelKind | undefined;
    for (const ch of chans) {
      const cn = ch.conn;
      const key = ch.peer;
      if (!key) continue;
      const cv = cn.convos[key];
      unread += chatUnread(p, cn, readSince, key);
      const t = cn.typing[key];
      if (t && t.until > Date.now()) typing = t.kind;
      const at = lastMessage(cv)?.timestamp ?? "";
      if (at > lastAt || !channel) {
        if (at > lastAt) lastAt = at;
        channel = cn.kind;
      }
    }
    if (!channel) channel = p.discordId ? "discord" : p.email ? "gmail" : p.whatsapp ? "whatsapp" : undefined;
    const was = views.filter((c) => c.kind === "whatsapp");
    const status = rowStatus(
      allPeers(p, "discord").map((d) => this.presenceOf(d)),
      allPeers(p, "whatsapp").flatMap((d) => was.map((c) => {
        const x: { status?: PresenceStatus; lastSeen?: number } = {};
        const st = c.presence[d];
        if (st) x.status = st;
        const ls = c.lastSeen[d];
        if (ls) x.lastSeen = ls;
        return x;
      })),
    );
    const out: RowInfo = { unread };
    if (lastAt) out.lastAt = lastAt;
    if (status?.dot) out.presence = status.dot;
    if (status) out.status = status;
    if (channel) out.channel = channel;
    if (typing) out.typing = typing;
    return out;
  }

  /** The connections a person's chat can use from a section (App.tsx choicesFull), and the default one. */
  /** The chats a person's page shows from a section (every channel of theirs and of their linked people), and the
   *  one the composer sends on by default (where their latest message came in). */
  chatChoices(p: Person, section: SectionId | null): { choices: ChatRef<ConnView>[]; current: ChatRef<ConnView> | undefined } {
    const views = this.views();
    let choices = chatsFor(p, views, section);
    if (!choices.length) choices = chatsFor(p, views, null);
    // the section's own account first: chats carried from a section they were moved out of only when it has none
    const own = section ? choices.filter((c) => serves(c.conn, section)) : [];
    return { choices, current: defaultChat(p, own.length ? own : choices, this.data?.readSince) };
  }

  // ---------- Link with… / Unlink ----------

  /** data.json as it was before the first link (Link with… is reversible with Unlink; this is the belt and braces). */
  private backupBeforeLink(): void {
    const file = join(this.dir, "data.json");
    const backup = join(this.dir, "data.before-link.json");
    try {
      this.flush();
      if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
    } catch (e) {
      this.log("backup before link failed", errText(e));
      throw new Error("Couldn't back up data.json first, so nothing was linked");
    }
  }

  /** `ids` become part of `primaryId` (model/link.ts). Returns the ids linked. */
  link(primaryId: string, ids: string[]): string[] {
    if (!this.data) throw new Error("Persons isn't loaded");
    const r = linkPeople(this.data, primaryId, ids);
    if (!r) return [];
    this.backupBeforeLink();
    this.log("linked", r.linked.join(","), "into", primaryId);
    this.update(() => r.data);
    this.flush();
    return r.linked;
  }

  /** `linkedId` split back out of `personId` into their own person (same id as before). */
  unlink(personId: string, linkedId: string): boolean {
    if (!this.data) return false;
    const r = unlinkPerson(this.data, personId, linkedId);
    if (!r) return false;
    this.log("unlinked", linkedId, "from", personId);
    this.update(() => r.data);
    this.flush();
    return true;
  }

  /** Total unread over everyone (the tab badge). */
  totalUnread(): number {
    return (this.data?.people ?? []).reduce((n, p) => n + this.rowInfo(p, null).unread, 0);
  }

  inScope = inScope;
  label = personLabel;

  // ---------- background refreshes (useHub.ts) ----------

  private connectedOf(kind: ChannelKind): ConnView[] {
    return this.views().filter((c) => c.kind === kind && c.connected);
  }

  private async refreshProfiles(): Promise<void> {
    if (this.stopped || !this.connectedOf("discord").length || !this.data) return;
    for (const p of this.data.people) for (const i of p.identities ?? []) {
      if (this.stopped) return;
      if (i.kind !== "discord" || (i.profileAt && Date.now() - Date.parse(i.profileAt) < 24 * 3600_000)) continue;
      const v0 = this.connectedOf("discord");
      const cv = v0.find((x) => x.section === i.section) ?? v0[0];
      const c = cv ? this.conns.get(cv.id) : undefined;
      if (!c) break;
      let v: ChannelUser | null = null;
      try {
        v = await c.user(i.value);
      } catch {
        continue;
      }
      const at = new Date().toISOString();
      this.updatePerson(p.id, (x) => ({
        ...x,
        identities: (x.identities ?? []).map((y) => {
          if (y.kind !== "discord" || y.value !== i.value) return y;
          const n = { ...y, profileAt: at };
          if (v) {
            n.username = v.username;
            n.avatar = v.avatar ?? null;
            if (v.globalName) n.displayName = v.globalName;
            else delete n.displayName;
          }
          return n;
        }),
      }));
      await sleep(1500);
    }
    for (const p of staleProfiles(this.data?.people ?? []).slice(0, 40)) {
      if (this.stopped) return;
      let u: ChannelUser | null = null;
      let tried = false;
      for (const a of this.connectedOf("discord")) {
        if (u) break;
        const c = this.conns.get(a.id);
        if (!c) continue;
        tried = true;
        try {
          if (p.discordId) u = await c.user(p.discordId);
          else if (p.discordUsername) {
            const r = await c.lookup(p.discordUsername);
            const want = cleanUsername(p.discordUsername).toLowerCase();
            u = r.matches.find((x) => x.username.toLowerCase() === want) ?? null;
            const found = u;
            if (found && this.data?.people.some((x) => x.discordId === found.id)) u = null;
          }
        } catch {
          // offline or paced: next round
        }
      }
      if (tried) {
        const at = new Date().toISOString();
        const found = u;
        this.updatePerson(p.id, (x) => (found ? applyDiscordUser(x, found, at) : { ...x, profileAt: at }));
      }
      await sleep(1500);
    }
  }

  private async refreshPhotos(): Promise<void> {
    const g = this.connectedOf("gmail")[0];
    const c = g ? this.conns.get(g.id) : undefined;
    if (this.stopped || !g || !c || !this.data) return;
    const contacts = !!g.state.contacts;
    for (const p of this.data.people.filter((x) => photoStale(x, contacts)).slice(0, 40)) {
      if (this.stopped) return;
      let photo: string | undefined;
      let searched = false;
      try {
        for (const e of emailsOf(p)) {
          const r = await c.lookup(e);
          searched = !!r.searched;
          photo = r.matches[0]?.avatarUrl || undefined;
          if (photo) break;
        }
      } catch {
        return;
      }
      const at = new Date().toISOString();
      this.updatePerson(p.id, (x) => applyPhoto(x, photo, searched, at));
      await sleep(1500);
    }
  }

  private async refreshSocialPhotos(): Promise<void> {
    const read = this.o.socialPhoto;
    if (this.stopped || !read || !this.data || this.socialRunning) return;
    this.socialRunning = true;
    try {
      await this.socialPass(read);
    } finally {
      this.socialRunning = false;
    }
  }

  private async socialPass(read: (url: string) => Promise<string | null | undefined>): Promise<void> {
    if (!this.data) return;
    for (const p of this.data.people.filter((x) => socialPhotoStale(x)).slice(0, 20)) {
      if (this.stopped) return;
      const key = socialPhotoKey(p);
      let photo: string | null = null;
      let ok = !key;
      for (const t of socialPhotoSources(p)) {
        const a = await read(t.url).catch(() => undefined);
        if (a !== undefined) ok = true;
        if (a) {
          photo = a;
          break;
        }
      }
      if (ok) {
        const at = new Date().toISOString();
        this.updatePerson(p.id, (x) => (socialPhotoKey(x) === key ? applySocialPhoto(x, photo, at) : x));
      }
      if (key) await sleep(1500);
    }
  }
}
