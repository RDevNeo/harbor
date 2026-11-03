import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, join, normalize, sep } from "node:path";
import { kvJson, now, type Kv } from "./kv.ts";
import { Shared } from "./shared.ts";
import { hashStr, Ordered, type Json } from "./wire.ts";

/** The longest a long-poll waits before answering with nothing new (clients time out at 25 s). */
export const POLL = 20_000;
const COALESCE = 150;
export const TYPING_TTL = 6_000;
export const VIEWING_TTL = 15_000;
export const PREVIEW_GAP = 400;
export const PREVIEW_CHARS = 500;
export const DRAFT_CHARS = 32_000;
export const DRAFT_ITEMS = 20;
export const DRAFT_HOLD = 1_000;
export const INBOX_TTL = 24 * 3600 * 1000;
export const APP_INBOX = 17000;
const PHONES_SEEN = "phones_seen";
const DRAFTS_KEY = "shared_drafts";

/** A phone's handle here (kv `api_tokens`, serde field order and skips as api.rs's Token). */
export interface Token {
  token: string;
  name: string;
  created: number;
  group: string;
  fp: string;
  account: string;
  account_name: string;
}

export function tokenJson(t: Token): Ordered {
  const e: [string, Json][] = [
    ["token", t.token],
    ["name", t.name],
    ["created", t.created],
    ["group", t.group],
    ["fp", t.fp],
  ];
  if (t.account !== "") e.push(["account", t.account]);
  if (t.account_name !== "") e.push(["account_name", t.account_name]);
  return new Ordered(e);
}

export interface Typer {
  device: string;
  kind: string;
  label: string;
  until: number;
  text: string;
  quiet: number | null;
  held: boolean;
}

export interface DraftFile {
  id: string;
  name: string;
  path: string;
}

export interface SharedDraft {
  text: string;
  files: DraftFile[];
  mentions: unknown[];
  by: string;
  label: string;
  rev: number;
  quiet: number | null;
  held: boolean;
}

function emptyDraft(): SharedDraft {
  return { text: "", files: [], mentions: [], by: "", label: "", rev: 0, quiet: null, held: false };
}

export function draftEmpty(d: SharedDraft): boolean {
  return d.text.trim() === "" && d.files.length === 0 && d.mentions.length === 0;
}

/** As the chats list and items replies carry it (json! object: keys sorted on the wire). */
export function draftJson(d: SharedDraft): Json {
  return {
    text: d.text,
    files: d.files.map((f) => new Ordered([["id", f.id], ["name", f.name], ["path", f.path]])),
    mentions: d.mentions as Json[],
    by: d.by,
    label: d.label,
    rev: d.rev,
  };
}

export function draftFromJson(v: unknown): SharedDraft | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.rev !== "number" || !Number.isInteger(o.rev) || o.rev < 0) return null;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const files: DraftFile[] = [];
  for (const f of Array.isArray(o.files) ? o.files : []) {
    if (typeof f !== "object" || f === null) continue;
    const x = f as Record<string, unknown>;
    if (typeof x.id === "string" && typeof x.name === "string") files.push({ id: x.id, name: x.name, path: typeof x.path === "string" ? x.path : "" });
  }
  return { text: s("text"), files, mentions: Array.isArray(o.mentions) ? o.mentions : [], by: s("by"), label: s("label"), rev: o.rev, quiet: null, held: false };
}

export type Apply = "now" | "later" | "skip";

/** Whether a newer shared draft goes into this device's composer (`edited`: its last edit, ms). */
export function shouldApply(d: SharedDraft, me: string, edited: number | null, at: number): Apply {
  if (d.by === me) return "skip";
  if (edited !== null && at - edited < DRAFT_HOLD) return "later";
  return "now";
}

/** The end of a draft, at most PREVIEW_CHARS characters. */
export function previewTail(text: string): string {
  const c = Array.from(text);
  return c.slice(Math.max(0, c.length - PREVIEW_CHARS)).join("");
}

/** A client's device id: stable per token, without giving the token away. */
export function deviceId(token: string): string {
  return `tok:${(hashStr(token) & 0xffffffffn).toString(16).padStart(8, "0")}`;
}

export interface PairedPhone {
  group: string;
  name: string;
  seen: number;
  ip: string;
  via: string;
  app: number;
  owner: string;
  platform: string;
  alive: number;
}

export interface Sighting {
  group: string;
  name: string;
  seen: number;
  app: number;
  alive: number;
  platform: string;
}

export interface Parcel {
  id: string;
  group: string;
  kind: "text" | "image" | "clip-image" | "file";
  name: string;
  text: string;
  path: string | null;
  temp: boolean;
  size: number;
  at: number;
  report: (sent: number, delivered: boolean, error: string | null) => void;
}

function parcelJson(p: Parcel): Json {
  const v: Record<string, Json> = { id: p.id, kind: p.kind, name: p.name, size: p.size };
  if (p.kind === "text") v.text = p.text;
  return v;
}

function finish(p: Parcel, error: string | null): void {
  if (p.temp && p.path) rmSync(p.path, { force: true });
  p.report(error === null ? p.size : 0, error === null, error);
}

export type Level = "loopback" | "legacy";

/** How a connection reached the listener. */
export type Via = { kind: "tls"; fp: string | null } | { kind: "loopback" } | { kind: "legacy" } | { kind: "refused" };

/** notify.rs's notes as the hub uses them. */
export interface NotesLike {
  last(): number;
  wait(since: number, ms: number): Promise<[unknown[], number]>;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export function loadTokens(kv: Kv): Token[] {
  const raw = kvJson<unknown>(kv, "api_tokens", []);
  const list: Token[] = (Array.isArray(raw) ? raw : []).flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const o = x as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    if (typeof o.token !== "string") return [];
    return [{ token: o.token, name: s("name"), created: typeof o.created === "number" ? o.created : 0, group: s("group"), fp: s("fp"), account: s("account"), account_name: s("account_name") }];
  });
  if (list.some((t) => t.group === "")) {
    for (const t of list) if (t.group === "") t.group = randomBytes(16).toString("hex");
    saveTokens(kv, list);
  }
  return list;
}

export function saveTokens(kv: Kv, t: Token[]): void {
  kv.set("api_tokens", JSON.stringify(t.map((x) => Object.fromEntries(tokenJson(x).entries))));
}

export function loadRevoked(kv: Kv): string[] {
  const v = kvJson<unknown>(kv, "api_revoked", []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The claims of a signed-in phone's Harbor token that the hub keeps (account.rs `Claims`). */
export interface PhoneClaims {
  sub: string;
  email: string;
  name: string;
}

export class Hub {
  enabled = false;
  port: number;
  tokens: Token[];
  seen = new Map<string, [string, number]>();
  ips = new Map<string, string>();
  apps = new Map<string, number>();
  platforms = new Map<string, string>();
  alive = new Map<string, [number, number]>();
  elsewhere = new Map<string, [string, Sighting[]]>();
  remembered = new Map<string, Sighting>();
  inbox: Parcel[] = [];
  net: { addrs: string[]; bound: string[]; error: string } = { addrs: [], bound: [], error: "" };
  readonly epoch: number;
  mesh = new Shared();
  tokensDirty = false;
  revoked: string[] = [];
  notes: NotesLike | null = null;

  private rev_: number;
  private state: number;
  private chats = new Map<number, number>();
  private typingMap = new Map<number, Typer[]>();
  private viewingMap = new Map<number, Typer[]>();
  private drafts = new Map<number, SharedDraft>();
  private draftsDirty = false;
  private waiters = new Set<() => void>();

  constructor(tokens: Token[], port: number, private clock: () => number = () => performance.now()) {
    const base = Date.now();
    this.port = port;
    this.tokens = tokens;
    this.rev_ = base;
    this.state = base;
    this.epoch = base;
  }

  /** Phones or the mesh are on: the listener answers. */
  active(): boolean {
    return this.enabled || this.mesh.on;
  }

  rev(): number {
    return this.rev_;
  }

  private notify(): void {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const f of w) f();
  }

  private mark(chat: number): void {
    this.rev_ += 1;
    this.chats.set(chat, this.rev_);
    this.state = this.rev_;
  }

  /** A new revision for a changed chat and/or the state; wakes the long-polls. */
  touch(chat: number | null, state: boolean): number {
    this.rev_ += 1;
    if (chat !== null) this.chats.set(chat, this.rev_);
    if (state) this.state = this.rev_;
    this.notify();
    return this.rev_;
  }

  /** A new revision that wakes nobody. */
  bump(): number {
    this.rev_ += 1;
    return this.rev_;
  }

  chatRev(chat: number): number {
    return this.chats.get(chat) ?? 0;
  }

  /** Drops run-out leases and announces held drafts that are due; true when any chat changed. */
  private prune(at: number): boolean {
    const gone: number[] = [];
    for (const [chat, v] of this.typingMap) {
      for (const t of v) {
        if (t.held && t.quiet !== null && t.quiet <= at) {
          t.held = false;
          t.quiet = at + PREVIEW_GAP;
          gone.push(chat);
        }
      }
    }
    for (const [chat, d] of this.drafts) {
      if (d.held && d.quiet !== null && d.quiet <= at) {
        d.held = false;
        d.quiet = at + PREVIEW_GAP;
        if (!gone.includes(chat)) gone.push(chat);
      }
    }
    for (const map of [this.typingMap, this.viewingMap]) {
      for (const [chat, v] of map) {
        const kept = v.filter((t) => t.until > at);
        if (kept.length !== v.length && !gone.includes(chat)) gone.push(chat);
        if (kept.length === 0) map.delete(chat);
        else map.set(chat, kept);
      }
    }
    for (const c of gone) this.mark(c);
    return gone.length > 0;
  }

  private nextExpiry(): number | null {
    let min: number | null = null;
    const see = (x: number | null) => {
      if (x !== null && (min === null || x < min)) min = x;
    };
    for (const v of [...this.typingMap.values(), ...this.viewingMap.values()]) for (const t of v) see(t.until);
    for (const v of this.typingMap.values()) for (const t of v) if (t.held) see(t.quiet);
    for (const d of this.drafts.values()) if (d.held) see(d.quiet);
    return min;
  }

  setTyping(chat: number, device: string, kind: string, label: string, on: boolean, text: string | null): boolean {
    return this.lease(false, chat, device, kind, label, on, text === null ? null : previewTail(text));
  }

  setViewing(chat: number, device: string, label: string, focused: boolean, on: boolean): boolean {
    return this.lease(true, chat, device, focused ? "focused" : "away", label, on, null);
  }

  viewing(chat: number): Typer[] {
    const at = this.clock();
    return (this.viewingMap.get(chat) ?? []).filter((t) => t.until > at).map((t) => ({ ...t }));
  }

  typing(chat: number): Typer[] {
    const at = this.clock();
    return (this.typingMap.get(chat) ?? []).filter((t) => t.until > at).map((t) => ({ ...t }));
  }

  private lease(view: boolean, chat: number, device: string, kind: string, label: string, on: boolean, text: string | null): boolean {
    const at = this.clock();
    const ttl = view ? VIEWING_TTL : TYPING_TTL;
    let changed = this.prune(at);
    const map = view ? this.viewingMap : this.typingMap;
    const v = map.get(chat) ?? [];
    const i = v.findIndex((t) => t.device === device);
    const t = i >= 0 ? v[i] : undefined;
    if (t && on) {
      t.until = at + ttl;
      if (t.label !== label || t.kind !== kind) {
        t.label = label;
        t.kind = kind;
        changed = true;
      }
      if (text !== null && text !== t.text) {
        t.text = text;
        if (t.quiet !== null && t.quiet > at) t.held = true;
        else {
          t.quiet = at + PREVIEW_GAP;
          changed = true;
        }
      }
    } else if (!t && on) {
      v.push({ device, kind, label, until: at + ttl, text: text ?? "", quiet: at + PREVIEW_GAP, held: false });
      changed = true;
    } else if (t && !on) {
      v.splice(i, 1);
      changed = true;
    }
    if (v.length > 0) map.set(chat, v);
    else map.delete(chat);
    if (changed) {
      this.mark(chat);
      this.notify();
    }
    return changed;
  }

  /** A device's composer for `chat` now holds this (`files`/`mentions` null: kept as they are). */
  setDraft(chat: number, device: string, label: string, text: string, files: DraftFile[] | null, mentions: unknown[] | null): boolean {
    const at = this.clock();
    let changed = this.prune(at);
    const chars = Array.from(text);
    const t = chars.length > DRAFT_CHARS ? chars.slice(chars.length - DRAFT_CHARS).join("") : text;
    const old = this.drafts.get(chat) ?? emptyDraft();
    const d: SharedDraft = { ...old, text: t, files: (files ?? old.files).slice(0, DRAFT_ITEMS), mentions: (mentions ?? old.mentions).slice(0, DRAFT_ITEMS), by: device, label };
    if (d.text === old.text && JSON.stringify(d.files) === JSON.stringify(old.files) && JSON.stringify(d.mentions) === JSON.stringify(old.mentions)) {
      if (changed) this.notify();
      return changed;
    }
    this.rev_ += 1;
    d.rev = this.rev_;
    const nowToo = !(d.quiet !== null && d.quiet > at);
    if (nowToo) {
      d.quiet = at + PREVIEW_GAP;
      d.held = false;
      changed = true;
    } else d.held = true;
    this.drafts.set(chat, d);
    this.draftsDirty = true;
    if (changed) {
      this.mark(chat);
      this.notify();
    }
    return nowToo;
  }

  /** A typing report: the lease, and the composer's content when it says (`draft` {text, files?, mentions?}). */
  report(chat: number, device: string, kind: string, label: string, on: boolean, draft: Record<string, unknown> | null, resolve: (id: string) => DraftFile | null): boolean {
    const text = draft && typeof draft.text === "string" ? draft.text : null;
    let changed = this.setTyping(chat, device, kind, label, on, text);
    if (draft) {
      const textOnly = !("files" in draft) && !("mentions" in draft);
      if (!(textOnly && !on)) {
        const files = Array.isArray(draft.files)
          ? draft.files
              .map((f) => (typeof f === "string" ? f : typeof f === "object" && f !== null && typeof (f as { id?: unknown }).id === "string" ? (f as { id: string }).id : null))
              .filter((x): x is string => x !== null)
              .map(resolve)
              .filter((x): x is DraftFile => x !== null)
          : null;
        const mentions = Array.isArray(draft.mentions) ? draft.mentions : null;
        changed = this.setDraft(chat, device, label, text ?? "", files, mentions) || changed;
      }
    }
    return changed;
  }

  /** A message went out of `chat`: its draft empties everywhere and its typers stop. The empty draft always gets a
   * new rev, even when this hub knew no draft (it restarted, or the composer was never reported): every device's
   * composer may still hold the message, and only a newer rev makes it give way. */
  clearDraft(chat: number): void {
    this.typingMap.delete(chat);
    this.rev_ += 1;
    this.drafts.set(chat, { ...emptyDraft(), rev: this.rev_ });
    this.draftsDirty = true;
    this.mark(chat);
    this.notify();
  }

  draft(chat: number): SharedDraft | null {
    return this.drafts.get(chat) ?? null;
  }

  draftRevs(): [number, number][] {
    return [...this.drafts].map(([c, d]) => [c, d.rev]);
  }

  /** The drafts as kv `shared_drafts` keeps them for the next run, when they changed since the last save. */
  saveDrafts(kv: Kv): void {
    if (!this.draftsDirty) return;
    this.draftsDirty = false;
    kv.set(DRAFTS_KEY, JSON.stringify([...this.drafts].map(([c, d]) => [c, { text: d.text, files: d.files, mentions: d.mentions, by: d.by, label: d.label, rev: d.rev }])));
  }

  /** The drafts of the last run: a restart doesn't forget a cleared draft (whose rev makes the devices empty their
   * composers) nor one a device wrote. Revs go on from the newest kept, so they stay newer than what devices saw. */
  loadDrafts(kv: Kv, exists: (path: string) => boolean = existsSync): void {
    const v = kvJson<unknown>(kv, DRAFTS_KEY, []);
    for (const e of Array.isArray(v) ? v : []) {
      if (!Array.isArray(e) || typeof e[0] !== "number" || !Number.isInteger(e[0])) continue;
      const d = draftFromJson(e[1]);
      if (!d) continue;
      d.files = d.files.filter((f) => f.path !== "" && exists(f.path));
      this.drafts.set(e[0], d);
      if (d.rev >= this.rev_) this.rev_ = d.rev + 1;
    }
    this.state = this.rev_;
  }

  /** The soonest a lease runs out, ms on the hub's clock (prunes first). */
  nextTypingExpiry(): number | null {
    if (this.prune(this.clock())) this.notify();
    return this.nextExpiry();
  }

  /** The long-poll: as soon as anything changed after `since`, or after `wait` ms. [rev, chats, state changed]. */
  async wait(since: number, wait: number): Promise<[number, number[], boolean]> {
    if (since > this.rev_) return [this.rev_, [], true];
    const deadline = this.clock() + wait;
    for (;;) {
      if (this.prune(this.clock())) this.notify();
      if (this.rev_ > since) break;
      const left = deadline - this.clock();
      if (left <= 0) break;
      const exp = this.nextExpiry();
      const until = exp === null ? left : Math.min(Math.max(exp - this.clock(), 10), left);
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.waiters.delete(done);
          resolve();
        }, until);
        const done = () => {
          clearTimeout(t);
          resolve();
        };
        this.waiters.add(done);
      });
    }
    if (this.rev_ > since && wait > 0) await Bun.sleep(COALESCE);
    const chats = [...this.chats].filter(([, v]) => v > since).map(([k]) => k).sort((a, b) => a - b);
    return [this.rev_, chats, this.state > since];
  }

  groupOf(token: string): string {
    return this.tokens.find((t) => t.token === token)?.group ?? "";
  }

  /** The phones as this PC saw them, one per pairing (what `GET /mesh/v1/phones` tells peers). */
  localPhones(): PairedPhone[] {
    const out: PairedPhone[] = [];
    for (const t of this.tokens.filter((x) => x.group !== "")) {
      const [named, at] = this.seen.get(t.token) ?? ["", 0];
      const name = named !== "" ? named : t.name;
      const ip = this.ips.get(t.token) ?? "";
      const app = this.apps.get(t.token) ?? 0;
      const pinged = this.alive.get(t.token)?.[0] ?? 0;
      const platform = this.platforms.get(t.token) ?? "";
      const p = out.find((x) => x.group === t.group);
      if (p) {
        if (platform !== "" && (p.platform === "" || at > p.seen)) p.platform = platform;
        p.app = Math.max(p.app, app);
        p.alive = Math.max(p.alive, pinged);
        if (p.owner === "") p.owner = t.account_name;
        if (at > p.seen) {
          p.seen = at;
          p.ip = ip;
          if (name !== "") p.name = name;
        } else if (p.name === "") p.name = name;
      } else out.push({ group: t.group, name, seen: at, ip, app, via: "", owner: t.account_name, alive: pinged, platform });
    }
    for (const p of out) {
      const r = this.remembered.get(p.group);
      if (!r) continue;
      p.app = Math.max(p.app, r.app);
      if (p.seen === 0) {
        p.seen = r.seen;
        if (p.name === "") p.name = r.name;
      }
      p.alive = Math.max(p.alive, r.alive);
      if (p.platform === "") p.platform = r.platform;
    }
    return out;
  }

  loadRemembered(kv: Kv): void {
    const v = kvJson<unknown>(kv, PHONES_SEEN, null);
    if (typeof v !== "object" || v === null) return;
    for (const [group, x] of Object.entries(v as Record<string, unknown>)) {
      const o = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
      const n = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
      const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
      this.remembered.set(group, { group, name: s("name"), seen: n("seen"), app: n("app"), alive: n("alive"), platform: s("platform") });
    }
  }

  /** Keeps the phones' last-seen times and app versions for the next run (kv `phones_seen`). */
  rememberPhones(kv: Kv): void {
    const cur = new Map<string, Sighting>();
    for (const p of this.localPhones()) {
      if (p.seen > 0 || p.alive > 0 || p.app > 0) cur.set(p.group, { group: p.group, name: p.name, seen: p.seen, app: p.app, alive: p.alive, platform: p.platform });
    }
    const kept = this.remembered;
    const stale =
      cur.size !== kept.size ||
      [...cur].some(([g, n]) => {
        const k = kept.get(g);
        return !k || k.app !== n.app || k.name !== n.name || k.platform !== n.platform || Math.max(n.seen, n.alive) - Math.max(k.seen, k.alive) >= 300;
      });
    if (!stale) return;
    const v: Record<string, Json> = {};
    for (const [g, p] of cur) v[g] = { name: p.name, seen: p.seen, app: p.app, alive: p.alive, platform: p.platform };
    kv.set(PHONES_SEEN, JSON.stringify(v));
    this.remembered = cur;
  }

  /** The phones paired here, with what the other PCs saw of them; most recently seen first. */
  pairedPhones(): PairedPhone[] {
    const out = this.localPhones();
    for (const p of out) {
      for (const [pc, sightings] of this.elsewhere.values()) {
        for (const s of sightings.filter((x) => x.group === p.group)) {
          p.app = Math.max(p.app, s.app);
          if (s.alive > p.alive) {
            if (s.alive > Math.max(p.seen, p.alive) && s.seen <= p.seen) p.via = pc;
            p.alive = s.alive;
          }
          if (s.seen > p.seen) {
            p.seen = s.seen;
            p.via = pc;
            if (s.name !== "") p.name = s.name;
          }
        }
      }
    }
    return out.sort((a, b) => b.seen - a.seen);
  }

  post(p: Parcel): void {
    this.pruneInbox();
    this.inbox.push(p);
    this.touch(null, false);
  }

  private pruneInbox(): void {
    const at = this.clock();
    const old = this.inbox.filter((p) => at - p.at > INBOX_TTL);
    this.inbox = this.inbox.filter((p) => at - p.at <= INBOX_TTL);
    for (const p of old) finish(p, "The phone's Harbor app didn't pick it up within a day");
  }

  inboxFor(group: string): Json[] {
    this.pruneInbox();
    if (group === "") return [];
    return this.inbox.filter((p) => p.group === group).map(parcelJson);
  }

  parcel(group: string, id: string): Parcel | null {
    return this.inbox.find((p) => p.group === group && p.id === id) ?? null;
  }

  delivered(group: string, id: string, error: string | null): boolean {
    const i = this.inbox.findIndex((p) => p.group === group && p.id === id);
    const p = this.inbox[i];
    if (!p) return false;
    this.inbox.splice(i, 1);
    finish(p, error);
    return true;
  }

  /** A pairing token from before accounts: full over loopback, elsewhere only to update the app. */
  auth(token: string, via: Via): Level {
    let hit = false;
    for (const t of this.tokens) if (t.account === "") hit = same(t.token, token) || hit;
    if (!hit) throw new Error("unknown token: sign in with Google in Harbor for Android");
    if (via.kind === "loopback") return "loopback";
    if (via.kind === "refused") throw new Error("plain HTTP isn't answered here: use TLS");
    return "legacy";
  }

  /** Who a phone's message comes from: "Pixel 8 (Sam Rig)" for a signed-in phone. */
  callerLabel(token: string, device: string): string {
    const phone = device === "" ? "Phone" : device;
    const t = this.tokens.find((x) => x.token === token && x.account_name !== "");
    return t ? `${phone} (${t.account_name})` : phone;
  }

  /** The person a phone is signed in as ("" for a phone paired before accounts). */
  callerWho(token: string): string {
    return this.tokens.find((x) => x.token === token)?.account_name ?? "";
  }

  /** The handle of a signed-in phone (key `fp`): made the first time it calls. */
  accountPhone(c: PhoneClaims, fp: string): string {
    const name = c.name === "" ? c.email : c.name;
    const t = this.tokens.find((x) => x.account !== "" && x.fp === fp);
    if (t) {
      if (t.account !== c.sub || t.account_name !== name) {
        t.account = c.sub;
        t.account_name = name;
        this.tokensDirty = true;
      }
      return t.token;
    }
    const token = newToken();
    this.tokens.push({ token, name: "", created: now(), group: fp, fp, account: c.sub, account_name: name });
    this.tokensDirty = true;
    return token;
  }
}


/** Rust's char::is_control: the Cc category. */
export function isControl(c: string): boolean {
  const n = c.codePointAt(0) ?? 0;
  return n < 0x20 || (n >= 0x7f && n <= 0x9f);
}

/** A safe file name: the last path part, no control characters, at most 100 characters. */
export function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const s = Array.from(base)
    .filter((c) => !isControl(c))
    .slice(0, 100)
    .join("")
    .trim()
    .replace(/^\.+/, "");
  return s === "" ? "file" : s;
}

/** The file of an upload id ("<chat or pending>/<file>") under `dir`; null for anything else. */
export function resolveUpload(dir: string, id: string): string | null {
  const parts = id.split("/");
  if (parts.length !== 2 || parts.some((p) => p === "" || p === "." || p === "..")) return null;
  const f = join(dir, ...parts);
  if (normalize(f) !== f || !f.startsWith(dir + sep)) return null;
  try {
    return existsSync(f) && statSync(f).isFile() ? f : null;
  } catch {
    return null;
  }
}

export function draftFileOf(dir: string, id: string): DraftFile | null {
  const path = resolveUpload(dir, id);
  return path ? { id, name: basename(path), path } : null;
}
