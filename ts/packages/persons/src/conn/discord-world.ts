// What a Discord session knows about the account's world beyond its DMs with the people in Persons: servers (their
// channels, emoji, owner), every private channel, relationships and friend nicknames, read state, per-server
// notification settings, the settings proto (server folders), members and activities seen, and who's typing where.
// Fed with the gateway's dispatches (READY and what follows); the agents' Discord tools (../agent/discord.ts) read it.
// Pure: no network, so the unit tests load it.
import { cmpId, isSnowflake, type RawUser, type SlimUser, slimUser } from "./discord-core.ts";

export interface WEmoji {
  id: string;
  name: string;
  animated: boolean;
}

export interface WChannel {
  id: string;
  type: number;
  name: string | null;
  guildId: string | null;
  parentId: string | null;
  topic: string | null;
  lastMessageId: string | null;
  /** DMs and groups: the other people. */
  recipientIds: string[];
  position: number;
}

export interface WGuild {
  id: string;
  name: string;
  ownerId: string | null;
  emojis: WEmoji[];
  channels: Map<string, WChannel>;
}

export interface WReadState {
  lastMessageId: string | null;
  mentionCount: number;
}

export interface WMuteConfig {
  end_time: string | null;
  selected_time_window: number | null;
}

export interface WGuildSettings {
  muted: boolean;
  muteConfig: WMuteConfig | null;
}

export interface WActivity {
  name: string | null;
  type: number | null;
  state: string | null;
  details: string | null;
  applicationId: string | null;
}

export const RELATIONSHIP_WORDS: Readonly<Record<number, string>> = { 1: "friend", 2: "blocked", 3: "incoming friend request", 4: "outgoing friend request", 5: "implicit" };

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const n = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Text channels' types a person reads (text, announcement, the three thread kinds); DMs and groups are 1 and 3. */
export const TEXT_TYPES: ReadonlySet<number> = new Set([0, 5, 10, 11, 12]);
export const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

function channelOf(c: Raw, guildId: string | null): WChannel | null {
  const id = s(c.id);
  if (!id) return null;
  const recipients = arr(c.recipient_ids).map(String);
  if (!recipients.length) for (const r of arr(c.recipients)) if (s(obj(r).id)) recipients.push(String(obj(r).id));
  return {
    id,
    type: n(c.type),
    name: s(c.name),
    guildId: guildId ?? s(c.guild_id),
    parentId: s(c.parent_id),
    topic: s(c.topic),
    lastMessageId: s(c.last_message_id),
    recipientIds: recipients,
    position: n(c.position),
  };
}

function emojisOf(v: unknown): WEmoji[] {
  return arr(v)
    .map((e) => obj(e))
    .filter((e) => s(e.id) && s(e.name))
    .map((e) => ({ id: String(e.id), name: String(e.name), animated: e.animated === true }));
}

export interface World {
  readonly guilds: Map<string, WGuild>;
  /** DMs and group DMs. */
  readonly privates: Map<string, WChannel>;
  readonly users: Map<string, SlimUser>;
  readonly relationships: Map<string, { type: number; nickname: string | null }>;
  readonly readStates: Map<string, WReadState>;
  readonly guildSettings: Map<string, WGuildSettings>;
  /** userId → guildId → server nickname (null: a member without one), from members the session saw. */
  readonly members: Map<string, Map<string, string | null>>;
  readonly activities: Map<string, WActivity[]>;
  /** The settings proto (base64, type 1: server folders live there) as READY or its update gave it; null: not known. */
  settingsProto: string | null;
  /** True once a READY came. */
  ready: boolean;
  apply(t: string, d: unknown, meId: string | null): void;
  /** A channel anywhere: a DM, a group, a server's channel or thread. */
  channel(id: string): WChannel | undefined;
  /** Puts a channel learned from the API in (a thread, a DM just opened). */
  remember(c: unknown): WChannel | null;
  /** The DM channel with this person, if one is known. */
  dmWith(userId: string): WChannel | undefined;
  /** DMs and groups newest first (the sidebar's order). */
  privateOrder(): WChannel[];
  /** Who's typing in a channel now. */
  typingIn(channelId: string, now?: number): string[];
  clear(): void;
}

export function createWorld(): World {
  const guilds = new Map<string, WGuild>();
  const privates = new Map<string, WChannel>();
  const users = new Map<string, SlimUser>();
  const relationships = new Map<string, { type: number; nickname: string | null }>();
  const readStates = new Map<string, WReadState>();
  const guildSettings = new Map<string, WGuildSettings>();
  const members = new Map<string, Map<string, string | null>>();
  const activities = new Map<string, WActivity[]>();
  const typing = new Map<string, Map<string, number>>();
  const threads = new Map<string, WChannel>(); // threads seen by id (also in their guild's channels)

  const user = (raw: unknown): SlimUser | null => {
    const u = slimUser(raw as RawUser);
    if (u) users.set(u.id, u);
    return u;
  };
  const member = (uid: string, gid: string, nick: unknown): void => {
    if (!isSnowflake(uid) || !isSnowflake(gid)) return;
    let m = members.get(uid);
    if (!m) members.set(uid, (m = new Map()));
    if (m.size < 200 || m.has(gid)) m.set(gid, s(nick));
  };

  function putGuild(g: Raw): void {
    const id = s(g.id);
    if (!id || g.unavailable === true) return;
    const p = obj(g.properties);
    const old = guilds.get(id);
    const name = s(p.name) ?? s(g.name) ?? old?.name ?? "";
    const ownerId = s(p.owner_id) ?? s(g.owner_id) ?? old?.ownerId ?? null;
    const channels = new Map<string, WChannel>();
    const list = [...arr(g.channels), ...arr(g.threads)];
    if (list.length) {
      for (const c of list) {
        const ch = channelOf(obj(c), id);
        if (ch) {
          channels.set(ch.id, ch);
          if (THREAD_TYPES.has(ch.type)) threads.set(ch.id, ch);
        }
      }
    } else if (old) for (const [k, v] of old.channels) channels.set(k, v);
    const emojis = g.emojis !== undefined ? emojisOf(g.emojis) : (old?.emojis ?? []);
    guilds.set(id, { id, name, ownerId, emojis, channels });
  }

  function putChannel(c: Raw): WChannel | null {
    const gid = s(c.guild_id);
    const ch = channelOf(c, gid);
    if (!ch) return null;
    if (ch.type === 1 || ch.type === 3) {
      privates.set(ch.id, ch);
      for (const r of arr(c.recipients)) user(r);
      return ch;
    }
    const g = gid ? guilds.get(gid) : undefined;
    if (g) g.channels.set(ch.id, ch);
    if (THREAD_TYPES.has(ch.type)) threads.set(ch.id, ch);
    return ch;
  }

  function channel(id: string): WChannel | undefined {
    const p = privates.get(id);
    if (p) return p;
    const t = threads.get(id);
    if (t) return t;
    for (const g of guilds.values()) {
      const c = g.channels.get(id);
      if (c) return c;
    }
    return undefined;
  }

  function settingsEntry(e: Raw): void {
    const gid = s(e.guild_id);
    if (!gid) return;
    const mc = obj(e.mute_config);
    guildSettings.set(gid, {
      muted: e.muted === true,
      muteConfig: e.mute_config ? { end_time: s(mc.end_time), selected_time_window: typeof mc.selected_time_window === "number" ? mc.selected_time_window : null } : null,
    });
  }

  function clear(): void {
    for (const m of [guilds, privates, users, relationships, readStates, guildSettings, members, activities, typing, threads]) m.clear();
    w.settingsProto = null;
    w.ready = false;
  }

  const w: World = {
    guilds,
    privates,
    users,
    relationships,
    readStates,
    guildSettings,
    members,
    activities,
    settingsProto: null,
    ready: false,
    channel,
    remember: (c) => putChannel(obj(c)),
    dmWith(userId) {
      for (const c of privates.values()) if (c.type === 1 && c.recipientIds.length === 1 && c.recipientIds[0] === userId) return c;
      return undefined;
    },
    privateOrder() {
      return [...privates.values()].sort((a, b) => cmpId(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id));
    },
    typingIn(channelId, now = Date.now()) {
      const m = typing.get(channelId);
      if (!m) return [];
      return [...m].filter(([, until]) => until > now).map(([u]) => u);
    },
    clear,
    apply(t, data, meId) {
      const d = obj(data);
      switch (t) {
        case "READY": {
          clear();
          w.ready = true;
          for (const u of arr(d.users)) user(u);
          for (const g of arr(d.guilds)) putGuild(obj(g));
          for (const c of arr(d.private_channels)) putChannel(obj(c));
          for (const r of arr(d.relationships)) {
            const x = obj(r);
            const id = s(x.id) ?? s(x.user_id) ?? s(obj(x.user).id);
            if (x.user) user(x.user);
            if (id) relationships.set(id, { type: n(x.type), nickname: s(x.nickname) });
          }
          const rs = d.read_state;
          for (const e of Array.isArray(rs) ? rs : arr(obj(rs).entries)) {
            const x = obj(e);
            const id = s(x.id);
            if (!id || (x.read_state_type !== undefined && x.read_state_type !== 0)) continue;
            readStates.set(id, { lastMessageId: s(x.last_message_id), mentionCount: n(x.mention_count) });
          }
          const ugs = d.user_guild_settings;
          for (const e of Array.isArray(ugs) ? ugs : arr(obj(ugs).entries)) settingsEntry(obj(e));
          w.settingsProto = typeof d.user_settings_proto === "string" ? d.user_settings_proto : null;
          // merged_members: the account's own member object per guild, in READY's guild order
          const gl = arr(d.guilds);
          arr(d.merged_members).forEach((ms, i) => {
            const gid = s(obj(gl[i]).id);
            for (const m of arr(ms)) if (gid) member(String(obj(m).user_id ?? meId ?? ""), gid, obj(m).nick);
          });
          break;
        }
        case "GUILD_CREATE":
        case "GUILD_UPDATE":
          putGuild(d);
          for (const m of arr(d.members)) {
            const x = obj(m);
            const u = user(x.user);
            const gid = s(d.id);
            if (u && gid) member(u.id, gid, x.nick);
          }
          break;
        case "GUILD_DELETE": {
          const id = s(d.id);
          if (id && d.unavailable !== true) {
            const g = guilds.get(id);
            if (g) for (const c of g.channels.keys()) threads.delete(c);
            guilds.delete(id);
          }
          break;
        }
        case "GUILD_EMOJIS_UPDATE": {
          const g = guilds.get(s(d.guild_id) ?? "");
          if (g) g.emojis = emojisOf(d.emojis);
          break;
        }
        case "CHANNEL_CREATE":
        case "CHANNEL_UPDATE":
        case "THREAD_CREATE":
        case "THREAD_UPDATE":
          putChannel(d);
          break;
        case "CHANNEL_DELETE":
        case "THREAD_DELETE": {
          const id = s(d.id);
          if (!id) break;
          privates.delete(id);
          threads.delete(id);
          guilds.get(s(d.guild_id) ?? "")?.channels.delete(id);
          break;
        }
        case "THREAD_LIST_SYNC":
          for (const c of arr(d.threads)) putChannel({ ...obj(c), guild_id: d.guild_id });
          break;
        case "MESSAGE_CREATE": {
          const cid = s(d.channel_id);
          const mid = s(d.id);
          if (!cid || !mid) break;
          const author = user(d.author);
          const gid = s(d.guild_id);
          if (author && gid) member(author.id, gid, obj(d.member).nick);
          for (const m of arr(d.mentions)) {
            const u = user(m);
            if (u && gid && obj(m).member) member(u.id, gid, obj(obj(m).member).nick);
          }
          const ch = channel(cid);
          if (ch && cmpId(mid, ch.lastMessageId) > 0) ch.lastMessageId = mid;
          if (!ch && !gid && d.author) {
            // a DM this session hadn't seen yet (CHANNEL_CREATE usually comes first)
            const peer = author && author.id !== meId ? author.id : null;
            if (peer) privates.set(cid, { id: cid, type: 1, name: null, guildId: null, parentId: null, topic: null, lastMessageId: mid, recipientIds: [peer], position: 0 });
          }
          const rs = readStates.get(cid) ?? { lastMessageId: null, mentionCount: 0 };
          if (author && author.id === meId) {
            // what you send yourself counts as read
            rs.lastMessageId = mid;
            rs.mentionCount = 0;
          } else {
            const mentioned = meId !== null && (arr(d.mentions).some((m) => s(obj(m).id) === meId) || (!gid && (ch?.type === 1 || ch?.type === 3 || !ch)));
            if (mentioned) rs.mentionCount++;
          }
          readStates.set(cid, rs);
          const ty = typing.get(cid);
          if (author && ty) ty.delete(author.id);
          break;
        }
        case "MESSAGE_ACK": {
          const cid = s(d.channel_id);
          if (!cid) break;
          readStates.set(cid, { lastMessageId: s(d.message_id), mentionCount: n(d.mention_count) });
          break;
        }
        case "TYPING_START": {
          const cid = s(d.channel_id);
          const uid = s(d.user_id);
          if (!cid || !uid) break;
          let m = typing.get(cid);
          if (!m) typing.set(cid, (m = new Map()));
          m.set(uid, Date.now() + 10_000);
          const gid = s(d.guild_id);
          if (gid && obj(d.member).user) {
            user(obj(d.member).user);
            member(uid, gid, obj(d.member).nick);
          }
          break;
        }
        case "RELATIONSHIP_ADD":
        case "RELATIONSHIP_UPDATE": {
          const id = s(d.id);
          if (d.user) user(d.user);
          if (id) relationships.set(id, { type: n(d.type, relationships.get(id)?.type ?? 0), nickname: d.nickname !== undefined ? s(d.nickname) : (relationships.get(id)?.nickname ?? null) });
          break;
        }
        case "RELATIONSHIP_REMOVE": {
          const id = s(d.id);
          if (id) relationships.delete(id);
          break;
        }
        case "USER_GUILD_SETTINGS_UPDATE":
          settingsEntry(d);
          break;
        case "USER_SETTINGS_PROTO_UPDATE": {
          const st = obj(d.settings);
          if ((st.type === 1 || st.type === undefined) && typeof st.proto === "string" && d.partial !== true) w.settingsProto = st.proto;
          else if (st.type === 1 && d.partial === true) w.settingsProto = null; // a partial update: read the whole thing again when needed
          break;
        }
        case "PRESENCE_UPDATE": {
          const uid = s(obj(d.user).id);
          if (!uid) break;
          const list = arr(d.activities).map((a) => {
            const x = obj(a);
            return { name: s(x.name), type: typeof x.type === "number" ? x.type : null, state: s(x.state), details: s(x.details), applicationId: s(x.application_id) };
          });
          if (list.length) activities.set(uid, list);
          else activities.delete(uid);
          if (activities.size > 5000) activities.delete(activities.keys().next().value as string);
          break;
        }
        case "GUILD_MEMBERS_CHUNK": {
          const gid = s(d.guild_id);
          for (const m of arr(d.members)) {
            const x = obj(m);
            const u = user(x.user);
            if (u && gid) member(u.id, gid, x.nick);
          }
          break;
        }
        case "GUILD_MEMBER_UPDATE": {
          const u = user(d.user);
          const gid = s(d.guild_id);
          if (u && gid) member(u.id, gid, d.nick);
          break;
        }
      }
    },
  };
  return w;
}
