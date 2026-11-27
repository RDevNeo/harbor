// Pure helpers for the Discord connection (port of Person Hub's shell/discord-core.cjs, plus the
// upload/attachment rules of its shell/files.cjs): no network, so the unit tests load it.
import type { Attachment, ChannelUser, Message, OutgoingFile, PresenceStatus, Relation, ReplyRef } from "../model/types.ts";

const CDN = "https://cdn.discordapp.com";

// ---------- Discord's raw shapes (only the fields read here) ----------

export interface RawUser {
  id?: string | number | null;
  username?: string | null;
  global_name?: string | null;
  globalName?: string | null;
  avatar?: string | null;
  discriminator?: string | null;
  bot?: boolean | null;
}

export interface RawAttachment {
  filename?: string;
  url?: string;
  content_type?: string;
  size?: number;
  width?: number | null;
  height?: number | null;
  proxy_url?: string;
  duration_secs?: number;
  waveform?: string;
}

export interface RawMessage {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  channel_type?: number;
  author?: RawUser;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  attachments?: RawAttachment[];
  embeds?: unknown[];
  flags?: number;
  type?: number;
  message_reference?: { message_id?: string; channel_id?: string };
  referenced_message?: RawMessage | null;
  /** A forwarded message: what was forwarded (its own content is empty). */
  message_snapshots?: { message?: RawMessage | null }[];
  sticker_items?: RawSticker[];
}

export interface RawSticker {
  id?: string;
  name?: string;
  /** 1 PNG, 2 APNG, 3 Lottie, 4 GIF */
  format_type?: number;
}

/** A sticker as a picture (Lottie ones have none: null). */
export function stickerAttachment(s: RawSticker): Attachment | null {
  if (!s.id || s.format_type === 3) return null;
  const ext = s.format_type === 4 ? "gif" : "png";
  return { name: `${s.name || "sticker"}.${ext}`, url: `https://media.discordapp.net/stickers/${s.id}.${ext}?size=160`, type: `image/${ext}`, width: 160, height: 160 };
}

export interface RawChannel {
  id?: string;
  type?: number;
  recipient_ids?: string[];
  recipients?: RawUser[];
  last_message_id?: string | null;
}

export interface RawPresence {
  user_id?: string;
  user?: { id?: string };
  status?: string;
}

/** A user without its picture URL (what the connection keeps; `withAvatar` adds the URL). */
export type SlimUser = Omit<ChannelUser, "avatarUrl">;

/** Discord user object (REST or gateway) -> the small shape the app gets. */
export function slimUser(u: RawUser | null | undefined): SlimUser | null {
  if (!u || typeof u !== "object" || !u.id) return null;
  const out: SlimUser = {
    id: String(u.id),
    username: String(u.username ?? ""),
    globalName: u.global_name ?? u.globalName ?? null,
    avatar: u.avatar ?? null,
  };
  if (u.discriminator && u.discriminator !== "0") out.discriminator = String(u.discriminator);
  if (u.bot) out.bot = true;
  return out;
}

export function avatarUrl(user: { id?: string; avatar?: string | null; discriminator?: string } | null | undefined, size = 128): string {
  if (user?.avatar) return `${CDN}/avatars/${user.id}/${user.avatar}.${String(user.avatar).startsWith("a_") ? "gif" : "png"}?size=${size}`;
  return defaultAvatarUrl(user?.id, user?.discriminator);
}

/** New usernames: (id >> 22) % 6; legacy tags: discriminator % 5. */
export function defaultAvatarUrl(id: string | undefined, discriminator?: string): string {
  let n = 0;
  try {
    n = discriminator && discriminator !== "0" ? Number(discriminator) % 5 : Number((BigInt(id ?? "") >> 22n) % 6n);
  } catch {
    n = 0;
  }
  return `${CDN}/embed/avatars/${n}.png`;
}

/** The user with its picture URL. */
export const withAvatar = (u: SlimUser, size = 128): ChannelUser => ({ ...u, avatarUrl: avatarUrl(u, size) });

/** Discord message -> what the conversation view needs. */
export function slimMessage(m: RawMessage, meId: string | null | undefined): Message {
  const out: Message = {
    id: String(m.id),
    channelId: String(m.channel_id),
    authorId: String(m.author?.id ?? ""),
    fromMe: !!meId && m.author?.id === meId,
    content: String(m.content ?? ""),
    timestamp: m.timestamp ?? snowflakeTime(String(m.id)),
  };
  // a forward carries its message in a snapshot; a sticker has no text: both showed as an empty bubble
  const snap = m.message_snapshots?.[0]?.message ?? null;
  if (snap) {
    out.forwarded = true;
    if (!out.content) out.content = String(snap.content ?? "");
  }
  const src = m.attachments?.length ? m.attachments : (snap?.attachments ?? []);
  const files = src.map(slimAttachment);
  const stickers = [...(m.sticker_items ?? []), ...(snap?.sticker_items ?? [])];
  for (const st of stickers) {
    const a = stickerAttachment(st);
    if (a) files.push(a);
    else if (!out.content) out.content = `[Sticker: ${st.name || "sticker"}]`;
  }
  if (m.edited_timestamp) out.edited = true;
  if (files.length) out.attachments = files;
  if ((m.flags ?? 0) & 8192) out.voice = true;
  if ((m.embeds?.length || snap?.embeds?.length) && !out.content) out.embed = true;
  const refId = m.message_reference?.message_id;
  if (refId && (m.type === 19 || m.referenced_message)) out.reply = slimReply(refId, m.referenced_message, meId);
  return out;
}

/** The message a reply quotes (Discord sends it as referenced_message; null when it was deleted). */
export function slimReply(id: string, ref: RawMessage | null | undefined, meId: string | null | undefined): ReplyRef {
  if (!ref) return { id: String(id), deleted: true };
  const out: ReplyRef = {
    id: String(id),
    authorId: String(ref.author?.id ?? ""),
    fromMe: !!meId && ref.author?.id === meId,
    content: String(ref.content ?? "").slice(0, 300),
  };
  const first = ref.attachments?.[0];
  if (ref.attachments?.length && first) {
    out.attachments = ref.attachments.length;
    out.attachment = slimAttachment(first);
  }
  if ((ref.flags ?? 0) & 8192) out.voice = true;
  return out;
}

/** What the conversation needs to show a file: inline image, audio player or a file chip. */
export function slimAttachment(a: RawAttachment): Attachment {
  const out: Attachment = { name: String(a.filename ?? "file"), url: String(a.url ?? "") };
  if (a.content_type) out.type = String(a.content_type);
  if (Number.isFinite(a.size)) out.size = a.size as number;
  if (a.width && a.height) {
    out.width = a.width;
    out.height = a.height;
  }
  if (a.proxy_url) out.proxyUrl = String(a.proxy_url);
  if (Number.isFinite(a.duration_secs)) out.duration = a.duration_secs as number;
  if (typeof a.waveform === "string" && a.waveform.length <= 1000) out.waveform = a.waveform;
  return out;
}

export const DISCORD_EPOCH = 1420070400000n;

export function snowflakeTime(id: string): string {
  try {
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Numeric compare of snowflakes (strings of different lengths). */
export function cmpId(a: string | null | undefined, b: string | null | undefined): number {
  const x = BigInt(a || 0);
  const y = BigInt(b || 0);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A nonce / snowflake for "now" (what the client sends with a message). */
export const nowSnowflake = (now = Date.now()): string => ((BigInt(now) - DISCORD_EPOCH) << 22n).toString();

export const isSnowflake = (s: unknown): s is string => typeof s === "string" && /^\d{15,21}$/.test(s);

/** A username query as typed: "@Name", "name#1234", spaces. */
export function normalizeQuery(q: unknown): string {
  let s = String(q ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  const tag = /^(.+)#(\d{4})$/.exec(s);
  if (tag?.[1]) s = tag[1];
  return s;
}

/** Ranks users for a query: exact username, then exact display name, then prefix, then contains. */
export function rankUsers<U extends { id: string; username: string; globalName: string | null }>(users: Iterable<U>, query: string, limit = 10): U[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const out: { rank: number; u: U }[] = [];
  for (const u of users) {
    if (!u?.id) continue;
    const name = (u.username || "").toLowerCase();
    const g = (u.globalName || "").toLowerCase();
    let rank: number;
    if (name === q) rank = 0;
    else if (g === q) rank = 1;
    else if (name.startsWith(q)) rank = 2;
    else if (g.startsWith(q)) rank = 3;
    else if (name.includes(q) || g.includes(q)) rank = 4;
    else continue;
    out.push({ rank, u });
  }
  out.sort((a, b) => a.rank - b.rank || a.u.username.localeCompare(b.u.username));
  const seen = new Set<string>();
  const res: U[] = [];
  for (const { u } of out) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    res.push(u);
    if (res.length >= limit) break;
  }
  return res;
}

export interface Pacer {
  /** ms to wait before this send, and books the slot. */
  reserve(): number;
}

/**
 * Gentle pacing for sends: a lone message goes right away; one that follows another closely waits a
 * human-ish random gap. `now`/`random` are injectable for tests.
 */
export function createPacer({ minGap = 1800, maxGap = 4200, now = () => Date.now(), random = Math.random }: { minGap?: number; maxGap?: number; now?: () => number; random?: () => number } = {}): Pacer {
  let next = 0;
  return {
    reserve() {
      const t = now();
      const wait = Math.max(0, next - t);
      next = t + wait + minGap + Math.round(random() * (maxGap - minGap));
      return wait;
    },
  };
}

export interface Bucket {
  take(n?: number): boolean;
}

/** Token bucket for gateway member searches (Discord allows ~120 gateway commands a minute). */
export function createBucket({ capacity = 60, perMs = 60_000, now = () => Date.now() }: { capacity?: number; perMs?: number; now?: () => number } = {}): Bucket {
  let tokens = capacity;
  let at = now();
  return {
    take(n = 1) {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - at) / perMs) * capacity);
      at = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
  };
}

export interface StoredConversation {
  channelId: string;
  messages: Message[];
}

export interface Conversations {
  setChannel(peerId: string, channelId: string): void;
  peerOf(channelId: string): string | undefined;
  channelOf(peerId: string): string | undefined;
  get(peerId: string): StoredConversation | undefined;
  /** Adds/replaces messages; returns true when something changed. */
  merge(peerId: string, msgs: Message[]): boolean;
  /** Removes a message; returns the peer whose conversation had it, or null. */
  remove(channelId: string, messageId: string): string | null;
  clear(): void;
  lastId(peerId: string): string | undefined;
  toJSON(): Record<string, StoredConversation>;
  load(json: unknown): void;
}

/**
 * Conversations by peer (the other user's id): channel id + the latest messages, oldest first.
 * Merges history pages, live messages, edits and deletes without duplicates.
 */
export function createConversations(max = 200): Conversations {
  const byPeer = new Map<string, StoredConversation>();
  const peerOfChannel = new Map<string, string>();
  return {
    setChannel(peerId, channelId) {
      if (!peerId || !channelId) return;
      const c = byPeer.get(peerId);
      if (c) c.channelId = channelId;
      else byPeer.set(peerId, { channelId, messages: [] });
      peerOfChannel.set(channelId, peerId);
    },
    peerOf: (channelId) => peerOfChannel.get(channelId),
    channelOf: (peerId) => byPeer.get(peerId)?.channelId,
    get: (peerId) => byPeer.get(peerId),
    merge(peerId, msgs) {
      const first = msgs?.[0];
      if (!peerId || !first) return false;
      let c = byPeer.get(peerId);
      if (!c) {
        c = { channelId: first.channelId, messages: [] };
        byPeer.set(peerId, c);
      }
      if (first.channelId) {
        c.channelId = first.channelId;
        peerOfChannel.set(c.channelId, peerId);
      }
      const map = new Map(c.messages.map((m) => [m.id, m]));
      let changed = false;
      for (const m of msgs) {
        const prev = map.get(m.id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(m)) {
          map.set(m.id, m);
          changed = true;
        }
      }
      if (!changed) return false;
      c.messages = [...map.values()].sort((a, b) => cmpId(a.id, b.id)).slice(-max);
      return true;
    },
    remove(channelId, messageId) {
      const peer = peerOfChannel.get(channelId);
      const c = peer !== undefined ? byPeer.get(peer) : undefined;
      if (!c || peer === undefined) return null;
      const n = c.messages.length;
      c.messages = c.messages.filter((m) => m.id !== messageId);
      return c.messages.length !== n ? peer : null;
    },
    clear() {
      byPeer.clear();
      peerOfChannel.clear();
    },
    lastId: (peerId) => byPeer.get(peerId)?.messages.at(-1)?.id,
    toJSON() {
      const out: Record<string, StoredConversation> = {};
      for (const [k, v] of byPeer) out[k] = v;
      return out;
    },
    load(json) {
      if (!json || typeof json !== "object") return;
      for (const [peer, c] of Object.entries(json as Record<string, unknown>)) {
        if (!c || typeof c !== "object") continue;
        const raw = c as { channelId?: unknown; messages?: unknown };
        if (!Array.isArray(raw.messages)) continue;
        const channelId = typeof raw.channelId === "string" ? raw.channelId : "";
        const messages = (raw.messages as unknown[]).filter((m): m is Message => !!m && typeof m === "object" && !!(m as { id?: unknown }).id).slice(-max);
        byPeer.set(peer, { channelId, messages });
        if (channelId) peerOfChannel.set(channelId, peer);
      }
    },
  };
}

/** The 1:1 DM partner of a private channel (gateway READY shapes: recipient_ids + users, or recipients). */
export function dmPeer(channel: RawChannel | null | undefined, usersById?: Map<string, SlimUser>): { id: string; user: SlimUser | null | undefined } | null {
  if (!channel || channel.type !== 1) return null;
  const rid = channel.recipient_ids?.[0];
  if (Array.isArray(channel.recipient_ids) && channel.recipient_ids.length === 1 && rid !== undefined) return { id: String(rid), user: usersById?.get(String(rid)) };
  const r = channel.recipients?.[0];
  if (Array.isArray(channel.recipients) && channel.recipients.length === 1 && r) return { id: String(r.id), user: slimUser(r) };
  return null;
}

/** Parses the x-super-properties header (base64 JSON) without throwing. */
export function decodeSuperProps(b64: unknown): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(String(b64), "base64").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------- presence ----------
const STATUSES = new Set<string>(["online", "idle", "dnd", "offline", "invisible"]);

/** A gateway presence object (deduped `user_id`, or `user.id`) as [userId, status], or null. */
export function presenceEntry(x: RawPresence | null | undefined): [string, PresenceStatus] | null {
  const uid = String(x?.user_id ?? x?.user?.id ?? "");
  const st = x?.status;
  return isSnowflake(uid) && st !== undefined && STATUSES.has(st) ? [uid, st as PresenceStatus] : null;
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * Every presence a READY or READY_SUPPLEMENTAL payload carries: `presences` (friends and implicit
 * relationships) and `merged_presences` ({ friends: [...], guilds: [[...], ...] }). With the
 * PRIORITIZED_READY_PAYLOAD capability the merged ones only come in READY_SUPPLEMENTAL.
 */
export function readyPresences(d: { presences?: unknown; merged_presences?: { friends?: unknown; guilds?: unknown } } | null | undefined): Map<string, PresenceStatus> {
  const all = [...list<RawPresence>(d?.presences), ...list<RawPresence>(d?.merged_presences?.friends)];
  for (const g of list<unknown>(d?.merged_presences?.guilds)) if (Array.isArray(g)) all.push(...(g as RawPresence[]));
  const out = new Map<string, PresenceStatus>();
  for (const x of all) {
    const e = presenceEntry(x);
    if (e) out.set(e[0], e[1]);
  }
  return out;
}

/** Friends (relationship type 1) from READY's relationships. */
export function friendIds(relationships: unknown): Set<string> {
  const out = new Set<string>();
  for (const r of list<{ id?: string; user_id?: string; user?: { id?: string }; type?: number }>(relationships)) {
    const id = String(r?.id ?? r?.user_id ?? r?.user?.id ?? "");
    if (r?.type === 1 && isSnowflake(id)) out.add(id);
  }
  return out;
}

/**
 * GUILD_MEMBERS_CHUNK of a request with presences: each returned member's status (no presence entry
 * for a member = offline, as Discord only lists non-offline ones).
 */
export function chunkPresences(d: { presences?: unknown; members?: unknown } | null | undefined): Map<string, PresenceStatus> {
  const st = new Map<string, PresenceStatus>();
  for (const x of list<RawPresence>(d?.presences)) {
    const e = presenceEntry(x);
    if (e) st.set(e[0], e[1]);
  }
  const out = new Map<string, PresenceStatus>();
  for (const m of list<{ user?: { id?: string }; user_id?: string }>(d?.members)) {
    const uid = String(m?.user?.id ?? m?.user_id ?? "");
    if (isSnowflake(uid)) out.set(uid, st.get(uid) ?? "offline");
  }
  return out;
}

/** `list` in pieces of at most `n`. */
export function chunk<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * Which guild to follow each person's presence in (gateway op 37 member subscriptions), given the
 * guilds each one shares with the account. Every person needs one guild only: guilds already used
 * (`current`, { guildId: [userIds] }) come first, then the ones that cover the most people, so the
 * subscription stays small. At most `perGuild` members per guild and `total` overall.
 * Returns { guildId: [userIds] } (current ones included).
 */
export function planMemberSubscriptions(
  guildsOf: Map<string, readonly string[]>,
  current: Record<string, readonly string[]> = {},
  { perGuild = 100, total = 300 }: { perGuild?: number; total?: number } = {},
): Record<string, string[]> {
  const plan: Record<string, string[]> = {};
  let n = 0;
  const placed = new Set<string>();
  for (const [g, ids] of Object.entries(current)) {
    plan[g] = [...ids];
    for (const id of ids) {
      placed.add(id);
      n++;
    }
  }
  const count = new Map<string, number>();
  for (const [uid, gs] of guildsOf) if (!placed.has(uid)) for (const g of gs) count.set(g, (count.get(g) ?? 0) + 1);
  const order = [...guildsOf.keys()].filter((u) => !placed.has(u));
  for (const uid of order) {
    if (n >= total) break;
    const gs = [...(guildsOf.get(uid) ?? [])].filter((g) => (plan[g]?.length ?? 0) < perGuild);
    if (!gs.length) continue;
    gs.sort((a, b) => (plan[b] ? 1 : 0) - (plan[a] ? 1 : 0) || (count.get(b) ?? 0) - (count.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
    const g = gs[0] as string;
    (plan[g] ??= []).push(uid);
    placed.add(uid);
    n++;
  }
  return plan;
}

// ---------- files (Person Hub's shell/files.cjs, the parts Discord uses) ----------

/** Discord's upload limit for accounts without Nitro, and our cap per message. */
export const MAX_UPLOAD = 10 * 1024 * 1024;
export const MAX_FILES = 10;

/** A file name safe to write in a folder and to show. */
export function safeFileName(name: unknown, fallback = "file"): string {
  const s = [...String(name ?? "")]
    .filter((c) => c.charCodeAt(0) >= 32)
    .join("")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return s || fallback;
}

export interface Upload {
  name: string;
  type: string;
  data: Uint8Array;
  voice?: { duration: number; waveform: string };
}

/** Files for a message: names, types and sizes checked. Throws a user-facing message. */
export function checkUploads(files: readonly OutgoingFile[] | null | undefined): Upload[] {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files per message`);
  let total = 0;
  return files.map((f, i) => {
    const data = f?.data;
    if (!(data instanceof Uint8Array)) throw new Error("Invalid file");
    total += data.byteLength;
    if (data.byteLength === 0) throw new Error(`${safeFileName(f.name)} is empty`);
    if (total > MAX_UPLOAD) throw new Error("Files are over Discord’s 10 MB limit");
    const out: Upload = {
      name: safeFileName(f.name, `file-${i + 1}`),
      type: typeof f.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? f.type : "application/octet-stream",
      data,
    };
    if (f.voice) {
      const duration = Number(f.voice.duration);
      const waveform = String(f.voice.waveform ?? "");
      if (!Number.isFinite(duration) || duration <= 0 || duration > 1200 || !/^[A-Za-z0-9+/=]{0,400}$/.test(waveform)) throw new Error("Invalid voice message");
      out.voice = { duration: Math.round(duration * 100) / 100, waveform };
    }
    return out;
  });
}

/** Attachment links that may be downloaded: Discord's CDN only (plus a test origin's host). */
export function isAttachmentUrl(url: string, extraHost?: string | null): boolean {
  try {
    const u = new URL(url);
    if (extraHost && u.host === extraHost) return true;
    return u.protocol === "https:" && ["cdn.discordapp.com", "media.discordapp.net"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** The file an attachment is saved as: its id folder from the URL, then its (safe) name. */
export function attachmentFileName(url: string, name?: string | null): string {
  let p = "";
  try {
    p = new URL(url).pathname;
  } catch {
    // not a URL: the name alone
  }
  const parts = p.split("/");
  const id = (parts.at(-2) || Date.now().toString(36)).replace(/[^\w-]/g, "").slice(0, 30);
  const base = parts.at(-1) ?? "";
  return `${id}-${safeFileName(name || base)}`;
}

/** A send Discord answered with a captcha: never solved nor retried in Hub; Discord's own app shows it. */
export const CAPTCHA_SEND = "Discord wants a captcha. Open it in the Discord app.";
/** A friend request Discord answered with a captcha: their profile opens in Discord's app, where the person adds them. */
export const CAPTCHA_FRIEND = "Discord wants a captcha: finish adding them in the Discord app.";

/** Errors Discord answers sends with, in the user's words. */
export const SEND_ERRORS: Readonly<Record<number, string>> = {
  50007: "Discord blocked it: you’re not friends and share no server. Add friend first.",
  40002: "Discord wants this account verified first",
  20026: "Discord flagged this account; open Discord",
  40005: "The file is too big for Discord",
  50006: "Discord says the message is empty",
};

/** A relationship's type in Discord's numbers (READY, RELATIONSHIP_ADD) as Persons says it; null = none. */
export function relationOf(type: unknown): Relation | null {
  return type === 1 ? "friend" : type === 2 ? "blocked" : type === 3 ? "incoming" : type === 4 ? "sent" : null;
}

/** Errors Discord answers a friend request with, in the user's words. */
export const FRIEND_ERRORS: Readonly<Record<number, string>> = {
  80000: "They don’t take friend requests from people they share no server with",
  80001: "Discord didn’t send it: they don’t take requests from this account",
  80003: "That’s this account",
  80004: "Discord doesn’t know that user",
  80007: "You’re already friends",
  40002: "Discord wants this account verified first",
  20026: "Discord flagged this account; open Discord",
};

/** X-Context-Properties of the web client's Add Friend on a user's profile (base64 JSON). */
export const FRIEND_CONTEXT = btoa(JSON.stringify({ location: "User Profile" }));

// ---------- the account's files (and Person Hub's session folder names, for the import) ----------

/** The original two connections keep Person Hub's names, so their logins and caches carry over. */
const ACCOUNTS: Readonly<Record<string, { partition: string; cache: string; client: string }>> = {
  stores: { partition: "persist:discord", cache: "discord-cache.json", client: "discord-client.json" },
  spokpay: { partition: "persist:discord-spokpay", cache: "discord-cache-spokpay.json", client: "discord-client-spokpay.json" },
};

/** Person Hub's names for a connection's session, cache and client-headers files. */
export const discordFiles = (id: string): { partition: string; cache: string; client: string } =>
  ACCOUNTS[id] ?? { partition: `persist:conn-${id}`, cache: `discord-cache-${id}.json`, client: `discord-client-${id}.json` };

/** Person Hub's session (partition) of a connection ("persist:discord" for "stores"…): where the import reads its login. */
export const partitionOf = (id: string): string => discordFiles(id).partition;

/** That session's folder name under Person Hub's Partitions/ (without "persist:"). */
export const partitionFolder = (id: string): string => partitionOf(id).replace(/^persist:/, "");

/** What reading or getting a login gives (the token store, a QR sign-in). */
export interface SessionResult {
  token?: string;
  superProps?: string | null;
  locale?: string | null;
  timezone?: string | null;
  signedOut?: boolean;
  cancelled?: boolean;
  ok?: boolean;
  error?: string;
}

