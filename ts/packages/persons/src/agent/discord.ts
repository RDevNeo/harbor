// Hub's agents' Discord tools (the `discord` MCP app: discord_view, discord_send, …), run in the hub on a Persons
// Discord connection: its HTTP API and its gateway, no browser engine. Same names, arguments and answers as the tools
// that ran inside a Discord web page before; the few that only made sense with a page (view, open, screenshot,
// onboarding's clicks) answer from Discord's API instead, and say so. discord_notes stays in the app (a local file),
// and discord_attachment's bytes are fetched there too: this answers with where the attachment is.
import { ApiError, type DiscordLink } from "../conn/discord.ts";
import * as core from "../conn/discord-core.ts";
import { RELATIONSHIP_WORDS, THREAD_TYPES, type WChannel } from "../conn/discord-world.ts";
import type { ConnStatus } from "../model/types.ts";
import { type Folder, readFolders, withFolders } from "./folders.ts";
import { PaceLog } from "./pace.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;
type RawMsg = Omit<core.RawMessage, "embeds" | "referenced_message"> & {
  referenced_message?: RawMsg | null;
  mentions?: core.RawUser[];
  mention_roles?: string[];
  mention_everyone?: boolean;
  reactions?: { emoji?: { name?: string | null; id?: string | null }; count?: number; me?: boolean }[];
  pinned?: boolean;
  hit?: boolean;
  embeds?: { type?: string; title?: string; description?: string; url?: string; author?: { name?: string }; provider?: { name?: string } }[];
};

/** A tool's answer: an object (printed as JSON by the app), or plain text. */
export type ToolAnswer = { json: unknown } | { text: string };

export interface DiscordAbout {
  /** "Stores Discord": the Persons connection the tools use. */
  label: string;
  status: ConnStatus;
  error?: string | null;
}

export interface DiscordToolsOptions {
  /** The chosen connection's link; null: there's no Discord connection in Persons. */
  link(): DiscordLink | null;
  about(): DiscordAbout | null;
  /** The pace log's file (owner-only). */
  paceFile: string;
  sleep?: (ms: number) => Promise<void>;
  /** How long joins and leaves wait for the gateway to confirm (tests shorten it). */
  confirmMs?: number;
}

/** Where to sign in, for every answer that needs a signed-in account. */
export const SIGN_IN_HOW = "Sign in in Hub's Persons tab: Stores › + › Discord, then scan the QR code with the Discord app on your phone (You › Scan QR code).";

const NO_PAGE = "Hub talks to Discord over its API, with no Discord page or browser";

const ownName = (u: { global_name?: string | null; globalName?: string | null; username?: string | null } | null | undefined): string | null => u?.global_name ?? u?.globalName ?? u?.username ?? null;

const clamp = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : d;
  return Math.max(lo, Math.min(hi, n));
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const snowflakeRe = /^\d{15,25}$/;

export function snowflakeToIso(id: string): string | null {
  try {
    return new Date(Number((BigInt(id) >> 22n) + core.DISCORD_EPOCH)).toISOString();
  } catch {
    return null;
  }
}

export function isoToSnowflake(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return ((BigInt(ms) - core.DISCORD_EPOCH) << 22n).toString();
}

/** A raw message → the projection `select` asks for (`id` always). */
export function projectMessage(msg: RawMsg, select: Set<string>): Obj {
  const out: Obj = { id: msg.id };
  if (select.has("content")) out.content = msg.content || "";
  if (select.has("timestamp")) out.timestamp = msg.timestamp || snowflakeToIso(String(msg.id));
  if (select.has("author") && msg.author) out.author = { id: msg.author.id, username: msg.author.username, name: ownName(msg.author), bot: !!msg.author.bot };
  if (select.has("attachments") && msg.attachments?.length)
    out.attachments = msg.attachments.map((a) => ({ name: a.filename, url: a.url, size: a.size, contentType: a.content_type, width: a.width, height: a.height }));
  if (select.has("replyTo") && msg.message_reference?.message_id) out.replyTo = { id: msg.message_reference.message_id, channelId: msg.message_reference.channel_id };
  if (select.has("mentions") && msg.mentions?.length) out.mentions = msg.mentions.map((u) => ({ id: u.id, name: ownName(u) }));
  if (select.has("reactions") && msg.reactions?.length) out.reactions = msg.reactions.map((r) => ({ emoji: r.emoji?.name || r.emoji?.id || String(r.emoji), count: r.count, me: !!r.me }));
  if (select.has("edited") && msg.edited_timestamp) out.edited = msg.edited_timestamp;
  return out;
}

function compactMessage(msg: RawMsg): Obj {
  return {
    id: msg.id,
    timestamp: msg.timestamp ?? null,
    author: msg.author ? { id: msg.author.id, username: msg.author.username, name: ownName(msg.author), bot: !!msg.author.bot } : null,
    content: (msg.content || "").slice(0, 800),
  };
}

/** "<:name:id>", "<a:name:id>" or a unicode emoji → what the reaction URLs take. */
export function parseEmoji(input: string): { name: string; id: string | null; animated: boolean } {
  const m = /^<(a?):([^:]+):(\d+)>$/.exec(input);
  if (m) return { name: m[2] as string, id: m[3] as string, animated: !!m[1] };
  const s = input.trim();
  if (!s) throw new Error("Empty emoji.");
  if (/^:[^:]+:$/.test(s)) throw new Error(`Shortcode ${s} not supported — pass raw unicode (e.g. "👍") or the full "<:name:id>" / "<a:name:id>" form.`);
  return { name: s, id: null, animated: false };
}

/** The invite code out of any form a user pastes. */
export function parseInviteCode(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) throw new Error("Empty invite — pass an invite URL or code.");
  const m = /(?:discord\.gg|discord(?:app)?\.com\/invite|invite)\/([^/?#\s]+)/i.exec(s);
  if (m) s = m[1] as string;
  s = (s.split(/[?#/]/)[0] ?? "").trim();
  if (!s) throw new Error(`Could not parse an invite code from: ${String(raw)}`);
  return s;
}

const RAW_STOPWORDS = [
  "the", "and", "for", "are", "but", "not", "you", "your", "yours", "with", "this", "that", "from", "have", "has", "had", "was", "were", "will", "would", "could", "should", "can", "may", "might",
  "just", "like", "what", "when", "where", "why", "how", "who", "which", "than", "then", "into", "over", "about", "out", "all", "any", "some", "one", "two", "get", "got", "going", "yeah", "yes",
  "ok", "okay", "lol", "haha", "really", "very", "much", "only", "also", "even", "still", "now", "here", "there", "their", "them", "they", "his", "her", "him", "she", "its", "our", "ours", "mine",
  "myself", "yourself", "been", "being", "does", "did", "doing", "done", "say", "said", "says", "see", "seen", "know", "knew",
  "que", "para", "com", "como", "uma", "uns", "umas", "dos", "das", "nas", "nos", "por", "pelo", "pela", "pelos", "pelas", "sem", "mais", "menos", "muito", "muita", "muitos", "muitas", "tão",
  "também", "ainda", "agora", "depois", "antes", "sempre", "nunca", "aqui", "ali", "lá", "cá", "isto", "isso", "aquilo", "este", "esta", "esse", "essa", "aquele", "aquela", "estes", "estas",
  "esses", "essas", "aqueles", "aquelas", "meu", "minha", "meus", "minhas", "teu", "tua", "seu", "sua", "seus", "suas", "nosso", "nossa", "nossos", "nossas", "dele", "dela", "deles", "delas",
  "ser", "ter", "estar", "estou", "está", "estão", "estava", "estavam", "foi", "fui", "foram", "fosse", "são", "ele", "ela", "eles", "elas", "você", "vocês", "nós", "vós", "eu", "tu", "não",
  "sim", "então", "porque", "porquê", "pra", "pro", "tá", "tô", "né", "aí", "mas", "ou", "se", "já", "só", "vai", "vão", "vou", "vamos", "vem", "veio", "ver", "fazer", "feito", "faz", "fez",
  "tem", "tinha", "teve", "tive", "havia", "até", "onde", "qual", "quem", "quando",
];
const stripAccents = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const STOPWORDS = new Set(RAW_STOPWORDS.map((w) => stripAccents(w.toLowerCase())));
const URL_RE = /https?:\/\/([^\s/]+)/gi;
const WORD_RE = /[a-zA-ZÀ-ſ]{3,}/g;

export function bucketOf(iso: string, groupBy: string): string {
  const d = new Date(iso);
  if (groupBy === "day") return d.toISOString().slice(0, 10);
  if (groupBy === "week") {
    const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
    const week = Math.ceil((Math.floor((d.getTime() - jan1) / 86_400_000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return d.toISOString().slice(0, 7);
}

const MUTE_SECONDS: Record<string, number> = { "15m": 900, "1h": 3600, "3h": 10_800, "8h": 28_800, "24h": 86_400, forever: -1 };

/** The tools: one per Hub, on whichever connection `link` gives. */
export class DiscordTools {
  /** The channel discord_open (or discord_dm_open) left each chat on: the default `channelId`, and what discord_view reads. */
  private readonly current = new Map<string, { channelId: string; around?: string }>();
  /** Servers discord_join joined, newest last (discord_onboarding's default). */
  private readonly joined: string[] = [];
  private readonly pace: PaceLog;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: DiscordToolsOptions) {
    this.pace = new PaceLog(o.paceFile);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Runs a tool. `chat`: the Hub chat whose agent calls it (each has its own open channel). Errors throw. */
  async call(name: string, args: unknown, chat: number | null = null): Promise<ToolAnswer> {
    const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Obj;
    const key = String(chat ?? "");
    switch (name) {
      case "discord_status":
        return { text: this.statusText() };
      case "discord_screenshot":
        return { text: await this.screenshot(a, key) };
    }
    const link = this.need();
    const t = new Run(link, this, key);
    const run: Record<string, () => Promise<unknown>> = {
      discord_view: () => t.view(a),
      discord_open: () => t.open(a),
      discord_dms: () => t.dms(a),
      discord_send: () => t.send(a),
      discord_history: () => t.history(a),
      discord_search: () => t.search(a),
      discord_user_messages: () => t.userMessages(a),
      discord_stats: () => t.stats(a),
      discord_react: () => t.react(a),
      discord_edit: () => t.edit(a),
      discord_delete: () => t.delete(a),
      discord_pins: () => t.pins(a),
      discord_threads: () => t.threads(a),
      discord_find_user: () => t.findUser(a),
      discord_member: () => t.member(a),
      discord_resolveMessage: () => t.resolveMessage(a),
      discord_attachment: () => t.attachment(a),
      discord_dm_open: () => t.dmOpen(a),
      discord_emoji: () => t.emoji(a),
      discord_unread: () => t.unread(a),
      discord_ack: () => t.ack(a),
      discord_guilds: () => t.guilds(),
      discord_organize: () => t.organize(a),
      discord_join: () => t.join(a),
      discord_leave: () => t.leave(a),
      discord_mute_guild: () => t.mute(a),
      discord_waitForMessage: () => t.waitForMessage(a),
      discord_onboarding: () => t.onboarding(a),
    };
    const f = run[name];
    if (!f) throw new Error(`No such tool: ${name}`);
    try {
      return { json: await f() };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new Error(`Discord signed this account out. ${SIGN_IN_HOW}`);
      if (e instanceof ApiError && e.status === 0 && !link.me()) throw new Error(`Discord isn't signed in. ${SIGN_IN_HOW}`);
      throw e;
    }
  }

  /** The link, signed in; else why not, in words. */
  private need(): DiscordLink {
    const l = this.o.link();
    const about = this.o.about();
    if (!l || !about) throw new Error(`Hub has no Discord account for its agents yet. ${SIGN_IN_HOW}`);
    if (l.status() !== "connected") {
      if (l.status() === "connecting" || l.status() === "starting") throw new Error(`Discord (${about.label}) is still connecting${about.error ? `: ${about.error}` : ""}. Try again in a moment.`);
      throw new Error(`Discord (${about.label}) is signed out. ${SIGN_IN_HOW}`);
    }
    return l;
  }

  statusText(): string {
    const about = this.o.about();
    const l = this.o.link();
    if (!about || !l) return `Not signed in: Hub has no Discord account for its agents. ${SIGN_IN_HOW}`;
    const me = l.me();
    const who = me ? `${me.globalName ?? me.username} (@${me.username})` : "someone";
    switch (l.status()) {
      case "connected":
        return `Signed in as ${who}, the ${about.label} account of Hub's Persons tab. ${l.gatewayUp() ? "Discord is connected: every tool works." : "Discord's live connection is down and Hub is reconnecting: tools that read Discord's API work; discord_dms, discord_guilds, discord_unread, discord_emoji, discord_find_user and discord_waitForMessage need the live connection."} ${NO_PAGE}: discord_view and discord_open read channels through it, and discord_screenshot has no picture to take.`;
      case "connecting":
      case "starting":
        return `Discord (${about.label}) is connecting${about.error ? `: ${about.error}` : ""}. Try again in a moment.`;
      case "signing-in":
        return `Discord (${about.label}) is signing in: a QR code waits in Hub's Persons tab to be scanned with the Discord app.`;
      default:
        return `Not signed in: Discord (${about.label}) is signed out${about.error ? ` (${about.error})` : ""}. ${SIGN_IN_HOW}`;
    }
  }

  private async screenshot(a: Obj, key: string): Promise<string> {
    const saved = str(a.savePath) ? ` Nothing was saved to ${String(a.savePath)}.` : "";
    const head = `No screenshot: ${NO_PAGE}, so there's no screen to take a picture of.${saved}`;
    const cur = this.current.get(key);
    if (!cur) return `${head} Open a channel with discord_open and read it with discord_view.`;
    const view = await new Run(this.need(), this, key).view({ limit: 30 });
    return `${head} The channel this chat has open, as text:\n${JSON.stringify(view, null, 2)}`;
  }

  // ---------- state the runs share ----------
  currentOf(key: string): { channelId: string; around?: string } | undefined {
    return this.current.get(key);
  }
  setCurrent(key: string, channelId: string, around?: string): void {
    this.current.set(key, around ? { channelId, around } : { channelId });
  }
  noteJoined(gid: string): void {
    const i = this.joined.indexOf(gid);
    if (i >= 0) this.joined.splice(i, 1);
    this.joined.push(gid);
    if (this.joined.length > 20) this.joined.shift();
  }
  joinedGuilds(): string[] {
    return [...this.joined];
  }
  paceLog(): PaceLog {
    return this.pace;
  }
  wait(ms: number): Promise<void> {
    return this.sleep(ms);
  }
  confirmMs(): number {
    return this.o.confirmMs ?? 6000;
  }
}

/** One tool call: the link, and the chat's state. */
class Run {
  private readonly w;

  constructor(
    private readonly l: DiscordLink,
    private readonly tools: DiscordTools,
    private readonly key: string,
  ) {
    this.w = l.world;
  }

  private api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.l.api<T>(method, path, body);
  }

  private needWorld(): void {
    if (!this.w.ready) throw new Error("Discord's live connection isn't up yet, so Hub doesn't know this account's servers and DMs. Try again in a moment.");
  }

  private channelId(a: Obj): string {
    const id = str(a.channelId) ?? this.tools.currentOf(this.key)?.channelId;
    if (!id) throw new Error("No channel selected and no channelId provided. Pass `channelId` (discord_open sets the channel tools use when it's left out).");
    return id;
  }

  /** A channel, from what the session knows or Discord's API; undefined when it can't be seen. */
  private async channel(id: string): Promise<WChannel | undefined> {
    const c = this.w.channel(id);
    if (c) return c;
    try {
      return this.w.remember(await this.api("GET", `/channels/${id}`)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private guildName(gid: string | null): string | null {
    return gid ? (this.w.guilds.get(gid)?.name ?? null) : null;
  }

  private dmName(ch: WChannel): string | null {
    if (ch.name) return ch.name;
    if (ch.type !== 1 && ch.type !== 3) return null;
    return "(DM)";
  }

  private brief(ch: WChannel | undefined, id: string, extra: { type?: boolean; topic?: boolean; guildName?: boolean; parent?: boolean } = {}): Obj {
    if (!ch) return { id };
    const out: Obj = { id: ch.id, name: this.dmName(ch) };
    if (extra.type) out.type = ch.type;
    if (extra.topic) out.topic = ch.topic;
    out.guildId = ch.guildId;
    if (extra.guildName) out.guildName = this.guildName(ch.guildId);
    if (extra.parent) out.parentId = ch.parentId;
    return out;
  }

  private messages(cid: string, params: Record<string, string | number | undefined>): Promise<RawMsg[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    return this.api<RawMsg[]>("GET", `/channels/${cid}/messages?${q}`).then((r) => (Array.isArray(r) ? r : []));
  }

  /** One message (Discord's single-message route is bots' only: the client asks for the one around it). */
  private async message(cid: string, mid: string): Promise<RawMsg | null> {
    try {
      return (await this.messages(cid, { around: mid, limit: 1 })).find((m) => m.id === mid) ?? null;
    } catch {
      return null;
    }
  }

  private async replyChain(cid: string, mid: string, depth: number): Promise<Obj[]> {
    const chain: Obj[] = [];
    let ch = cid;
    let id: string | undefined = mid;
    const seen = new Set<string>();
    for (let i = 0; i < depth && id; i++) {
      const k = `${ch}/${id}`;
      if (seen.has(k)) break;
      seen.add(k);
      const m = await this.message(ch, id);
      if (!m) {
        chain.push({ id, unloaded: true });
        break;
      }
      chain.push(compactMessage(m));
      if (!m.message_reference?.message_id) break;
      ch = m.message_reference.channel_id || ch;
      id = m.message_reference.message_id;
    }
    return chain.reverse();
  }

  private viewer(): Obj | null {
    const me = this.l.me();
    return me ? { id: me.id, username: me.username, name: me.globalName ?? me.username } : null;
  }

  // ---------- reading ----------
  async view(a: Obj): Promise<Obj> {
    const cur = this.tools.currentOf(this.key);
    if (!cur) throw new Error("No channel is open in this chat: call discord_open({channelId}) first (discord_dms and discord_guilds find channel ids), or read any channel with discord_history.");
    const cid = cur.channelId;
    const ch = await this.channel(cid);
    if (!ch) throw new Error(`Channel not found: ${cid}`);
    const limit = clamp(a.limit, 1, 200, 50);
    let raw: RawMsg[];
    if (cur.around) {
      raw = await this.messages(cid, { around: cur.around, limit: Math.min(100, limit) });
    } else {
      raw = [];
      let before: string | undefined;
      while (raw.length < limit) {
        const batch = await this.messages(cid, { limit: Math.min(100, limit - raw.length), before });
        raw.push(...batch);
        if (batch.length < Math.min(100, limit - raw.length + batch.length)) break;
        before = batch.at(-1)?.id;
      }
    }
    raw.sort((x, y) => core.cmpId(x.id, y.id));
    const messages = raw.map((m) => {
      const out: Obj = {
        id: m.id,
        timestamp: m.timestamp ?? snowflakeToIso(String(m.id)),
        author: m.author ? { id: m.author.id, username: m.author.username, name: ownName(m.author), bot: !!m.author.bot } : null,
        content: m.content || "",
      };
      if (m.edited_timestamp) out.edited = m.edited_timestamp;
      if (m.attachments?.length) out.attachments = m.attachments.map((x) => ({ name: x.filename, url: x.url, contentType: x.content_type, size: x.size, width: x.width, height: x.height }));
      const refId = m.message_reference?.message_id;
      if (refId) {
        const ref = m.referenced_message;
        out.replyTo = ref ? { id: ref.id, authorId: ref.author?.id, authorName: ownName(ref.author), contentPreview: (ref.content || "").slice(0, 160) } : { id: refId, unloaded: true };
      }
      if (m.mentions?.length) out.mentions = m.mentions.map((u) => ({ id: u.id, name: ownName(u) }));
      if (m.mention_roles?.length) out.mentionRoles = [...m.mention_roles];
      if (m.mention_everyone) out.mentionEveryone = true;
      if (m.embeds?.length) {
        if (a.includeEmbeds === true)
          out.embeds = m.embeds.map((e) => ({ type: e.type, title: e.title, description: (e.description || "").slice(0, 400), url: e.url, author: e.author?.name, providerName: e.provider?.name }));
        else out.embedCount = m.embeds.length;
      }
      if (m.reactions?.length) {
        if (a.includeReactions === true) out.reactions = m.reactions.map((r) => ({ emoji: r.emoji?.name || r.emoji?.id || String(r.emoji), count: r.count, me: !!r.me }));
        else out.reactionCount = m.reactions.length;
      }
      if (m.flags) out.flags = m.flags;
      if (m.pinned) out.pinned = true;
      if (m.type && m.type !== 0) out.type = m.type;
      return out;
    });
    const depth = clamp(a.resolveReplies, 0, 20, 0);
    if (depth > 0) {
      for (const m of messages) {
        const r = m.replyTo as { id?: string; unloaded?: boolean } | undefined;
        if (!r?.id) continue;
        try {
          m.replyChain = await this.replyChain(cid, r.id, depth);
          const tip = (m.replyChain as Obj[]).at(-1) as { id?: string; unloaded?: boolean; author?: { id?: string; name?: string }; content?: string } | undefined;
          if (r.unloaded && tip && !tip.unloaded) m.replyTo = { id: tip.id, authorId: tip.author?.id, authorName: tip.author?.name, contentPreview: (tip.content || "").slice(0, 160) };
        } catch {
          // the shallow replyTo stays
        }
      }
    }
    const ids = new Set<string>(ch.recipientIds);
    if (!ids.size) for (const m of messages) if ((m.author as { id?: string } | null)?.id) ids.add((m.author as { id: string }).id);
    const me = this.l.me();
    if (me) ids.add(me.id);
    const typing = new Set(this.w.typingIn(cid));
    const participants = [...ids].map((uid) => {
      const u = this.w.users.get(uid);
      return { userId: uid, name: u ? (u.globalName ?? u.username) : null, presence: this.l.presence(uid) ?? "offline", typing: typing.has(uid) };
    });
    return {
      channel: { id: ch.id, name: this.dmName(ch), type: ch.type, topic: ch.topic, guildId: ch.guildId, guildName: this.guildName(ch.guildId), parentId: ch.parentId },
      viewer: this.viewer(),
      scroll: null,
      note: cur.around
        ? `${NO_PAGE}: these are the messages around ${cur.around}, the one discord_open jumped to.`
        : `${NO_PAGE}: these are the channel's newest messages. discord_history reads further back.`,
      participants,
      renderedCount: messages.length,
      unresolved: 0,
      messages,
    };
  }

  async open(a: Obj): Promise<Obj> {
    const id = str(a.channelId);
    if (!id) throw new Error("`channelId` is required.");
    const ch = await this.channel(id);
    if (!ch) throw new Error(`Channel not found: ${id} (not one this account can see).`);
    const mid = str(a.messageId);
    this.tools.setCurrent(this.key, id, mid);
    const recipients = ch.recipientIds.map((rid) => {
      const u = this.w.users.get(rid);
      return u ? { id: u.id, username: u.username, name: u.globalName ?? u.username } : { id: rid };
    });
    const first = recipients[0] as { name?: string; username?: string } | undefined;
    return {
      ok: true,
      note: `${NO_PAGE}: this channel is now the one discord_view reads and the default for tools called without channelId, in this chat.`,
      currentChannelId: id,
      path: `/channels/${ch.guildId ?? "@me"}/${id}${mid ? `/${mid}` : ""}`,
      channel: { id: ch.id, name: ch.name || (first?.name ?? first?.username ?? null), type: ch.type, guildId: ch.guildId, guildName: this.guildName(ch.guildId), recipients: recipients.length ? recipients : undefined },
      scrolledToMessage: mid ?? null,
    };
  }

  private dmEntry(ch: WChannel): Obj {
    const isGroup = ch.type === 3;
    const recipients = ch.recipientIds.map((rid) => {
      const u = this.w.users.get(rid);
      const nickname = this.w.relationships.get(rid)?.nickname ?? null;
      return u ? { id: u.id, username: u.username, name: u.globalName ?? u.username, nickname, bot: !!u.bot } : { id: rid, nickname };
    }) as { id: string; username?: string; name?: string; nickname: string | null }[];
    const name = isGroup
      ? ch.name ||
        recipients
          .map((r) => r.nickname || r.name || r.username)
          .filter(Boolean)
          .join(", ") ||
        "(group)"
      : recipients[0]?.nickname || recipients[0]?.name || recipients[0]?.username || "(unknown)";
    return { channelId: ch.id, kind: isGroup ? "group" : "dm", name, memberCount: isGroup ? recipients.length : undefined, recipients };
  }

  async dms(a: Obj): Promise<Obj> {
    this.needWorld();
    const all = this.w.privateOrder().map((c) => this.dmEntry(c));
    const q = (str(a.query) ?? "").trim().toLowerCase();
    let results = all;
    if (q) {
      const score = (dm: Obj): number => {
        const rs = dm.recipients as { nickname?: string | null; name?: string; username?: string }[];
        let best = -1;
        for (const t of [dm.name as string, ...rs.flatMap((r) => [r.nickname, r.name, r.username])]) {
          const lo = (t || "").toLowerCase();
          if (!lo) continue;
          if (lo === q) best = Math.max(best, 100);
          else if (lo.startsWith(q)) best = Math.max(best, 75);
          else if (lo.includes(q)) best = Math.max(best, 50);
        }
        return best;
      };
      results = all
        .map((dm) => ({ dm, s: score(dm) }))
        .filter((x) => x.s >= 0)
        .sort((x, y) => y.s - x.s)
        .map((x) => x.dm);
    }
    const limit = clamp(a.limit, 1, 100, q ? 20 : 50);
    return { total: all.length, matched: q ? results.length : undefined, query: q || undefined, dms: results.slice(0, limit) };
  }

  async history(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    const ch = await this.channel(cid);
    const select = new Set(strs(a.select).length ? strs(a.select) : ["id", "content", "author", "timestamp"]);
    const depth = clamp(a.resolveReplies, 0, 20, 0);
    if (depth > 0) select.add("replyTo");
    const limit = clamp(a.limit, 1, 5000, 200);
    const before = str(a.before) ?? (str(a.until) ? (isoToSnowflake(a.until as string) ?? undefined) : undefined);
    const after = str(a.after) ?? (str(a.since) ? (isoToSnowflake(a.since as string) ?? undefined) : undefined);
    const from = str(a.from);
    const contains = str(a.contains)?.toLowerCase();
    const lower = after ? BigInt(after) : null;
    const out: Obj[] = [];
    let cursor = before;
    let reachedEnd = false;
    let pages = 0;
    const keep = (m: RawMsg): boolean => !(from && m.author?.id !== from) && !(contains && !(m.content || "").toLowerCase().includes(contains));
    if (str(a.around) && !cursor) {
      for (const m of await this.messages(cid, { limit: 100, around: a.around as string })) if (keep(m)) out.push(projectMessage(m, select));
      reachedEnd = true;
      out.sort((x, y) => core.cmpId(y.id as string, x.id as string));
    } else {
      while (out.length < limit) {
        const batch = await this.messages(cid, { limit: 100, before: cursor });
        pages++;
        if (!batch.length) {
          reachedEnd = true;
          break;
        }
        let stop = false;
        for (const m of batch) {
          if (lower !== null && BigInt(String(m.id)) <= lower) {
            stop = true;
            continue;
          }
          if (!keep(m)) continue;
          out.push(projectMessage(m, select));
          if (out.length >= limit) break;
        }
        cursor = batch.at(-1)?.id;
        if (batch.length < 100 || stop) {
          reachedEnd = true;
          break;
        }
      }
    }
    out.reverse();
    if (depth > 0) {
      for (const m of out) {
        const r = m.replyTo as { id?: string; channelId?: string } | undefined;
        if (!r?.id) continue;
        try {
          m.replyChain = await this.replyChain(r.channelId || cid, r.id, depth);
        } catch {
          // left out
        }
      }
    }
    return {
      channel: ch ? { id: ch.id, name: this.dmName(ch), type: ch.type, guildId: ch.guildId } : { id: cid },
      count: out.length,
      pagesFetched: pages,
      hasMoreBefore: !reachedEnd,
      nextBefore: !reachedEnd ? cursor || null : null,
      oldestId: out[0]?.id ?? null,
      newestId: out.at(-1)?.id ?? null,
      messages: out,
    };
  }

  /** Discord's search, one page (25 groups); `indexing` when Discord isn't ready to search there yet. */
  private async searchPage(base: string, params: URLSearchParams): Promise<{ indexing: true; retryAfter: number | null } | { total: number; groups: RawMsg[][] }> {
    const j = await this.api<{ total_results?: number; messages?: RawMsg[][]; retry_after?: number; code?: number }>("GET", `${base}?${params}`);
    if (!Array.isArray(j?.messages) && (j?.retry_after !== undefined || j?.code === 110000)) return { indexing: true, retryAfter: j.retry_after ?? null };
    return { total: j?.total_results ?? 0, groups: j?.messages ?? [] };
  }

  async search(a: Obj): Promise<Obj> {
    const query = str(a.query);
    if (!query?.trim()) throw new Error("`query` is required.");
    const cid = this.channelId(a);
    const ch = await this.channel(cid);
    const limit = clamp(a.limit, 1, 200, 25);
    const base = ch?.guildId ? `/guilds/${ch.guildId}/messages/search` : `/channels/${cid}/messages/search`;
    const p0 = new URLSearchParams();
    p0.set("content", query);
    if (ch?.guildId) p0.set("channel_id", cid);
    if (str(a.from)) p0.set("author_id", a.from as string);
    if (str(a.mentions)) p0.set("mentions", a.mentions as string);
    for (const h of strs(a.has)) p0.append("has", h);
    if (str(a.before)) p0.set("max_id", a.before as string);
    if (str(a.after)) p0.set("min_id", a.after as string);
    const select = new Set(["id", "content", "author", "timestamp", "attachments"]);
    const collected: Obj[] = [];
    let total = 0;
    let offset = 0;
    while (collected.length < limit) {
      const p = new URLSearchParams(p0);
      p.set("offset", String(offset));
      const r = await this.searchPage(base, p);
      if ("indexing" in r) return { indexing: true, retryAfter: r.retryAfter, message: "Discord is indexing this channel for search. Retry after `retryAfter` seconds." };
      total = r.total || total;
      if (!r.groups.length) break;
      for (const g of r.groups) {
        const hit = g.find((m) => m.hit) ?? g[Math.floor(g.length / 2)] ?? g[0];
        if (!hit) continue;
        collected.push({ ...projectMessage(hit, select), hit: true });
        if (collected.length >= limit) break;
      }
      offset += r.groups.length;
      if (r.groups.length < 25) break;
    }
    return { channel: ch ? { id: ch.id, name: this.dmName(ch), guildId: ch.guildId } : { id: cid }, query, totalResults: total, count: collected.length, messages: collected };
  }

  async userMessages(a: Obj): Promise<Obj> {
    const gid = str(a.guildId) ?? "";
    const uid = str(a.userId) ?? "";
    if (!snowflakeRe.test(gid)) throw new Error("`guildId` must be a Discord snowflake.");
    if (!snowflakeRe.test(uid)) throw new Error("`userId` must be a Discord snowflake.");
    const g = this.w.guilds.get(gid);
    const limit = clamp(a.limit, 1, 500, 100);
    const start = clamp(a.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const p0 = new URLSearchParams();
    p0.set("author_id", uid);
    const q = str(a.query)?.trim();
    if (q) p0.set("content", q);
    if (str(a.before)) p0.set("max_id", a.before as string);
    if (str(a.after)) p0.set("min_id", a.after as string);
    const select = new Set(["id", "content", "author", "timestamp", "attachments", "replyTo", "mentions"]);
    const collected: Obj[] = [];
    let total = 0;
    let offset = start;
    let indexing = false;
    let retryAfter: number | null = null;
    while (collected.length < limit) {
      const p = new URLSearchParams(p0);
      p.set("offset", String(offset));
      const r = await this.searchPage(`/guilds/${gid}/messages/search`, p);
      if ("indexing" in r) {
        indexing = true;
        retryAfter = r.retryAfter;
        break;
      }
      total = r.total || total;
      if (!r.groups.length) break;
      let used = 0;
      for (const grp of r.groups) {
        used++;
        const hit = grp.find((m) => m.hit) ?? grp[Math.floor(grp.length / 2)] ?? grp[0];
        if (!hit) continue;
        collected.push({ ...projectMessage(hit, select), channelId: hit.channel_id ?? null, guildId: gid, hit: true });
        if (collected.length >= limit) break;
      }
      offset += used;
      if (r.groups.length < 25) break;
    }
    const more = start + collected.length < total;
    return {
      guild: g ? { id: g.id, name: g.name } : { id: gid },
      userId: uid,
      query: q || null,
      limit,
      offset: start,
      nextOffset: more ? start + collected.length : null,
      hasMore: more,
      totalResults: total,
      count: collected.length,
      indexing,
      retryAfter,
      messages: collected,
    };
  }

  async stats(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    const ch = await this.channel(cid);
    const since = str(a.since) ? isoToSnowflake(a.since as string) : null;
    const until = str(a.until) ? isoToSnowflake(a.until as string) : null;
    const groupBy = str(a.groupBy) ?? "month";
    const topN = clamp(a.topN, 1, 100, 10);
    const hardCap = clamp(a.hardCap, 100, 200_000, 50_000);
    const lower = since ? BigInt(since) : null;
    let cursor = until ?? undefined;
    let scanned = 0;
    let reachedEnd = false;
    let pages = 0;
    let attachments = 0;
    let links = 0;
    let replies = 0;
    const authorCount = new Map<string, number>();
    const authorName = new Map<string, string | null>();
    const buckets = new Map<string, number>();
    const edges = new Map<string, number>();
    const domains = new Map<string, number>();
    const words = new Map<string, number>();
    const authorById = new Map<string, string>();
    const pending: { from: string; refId: string }[] = [];
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    const inc = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
    while (scanned < hardCap) {
      const batch = await this.messages(cid, { limit: 100, before: cursor });
      pages++;
      if (!batch.length) {
        reachedEnd = true;
        break;
      }
      let stop = false;
      for (const m of batch) {
        if (lower !== null && BigInt(String(m.id)) <= lower) {
          stop = true;
          break;
        }
        scanned++;
        const aid = m.author?.id ? String(m.author.id) : undefined;
        if (aid) {
          inc(authorCount, aid);
          if (!authorName.has(aid)) authorName.set(aid, ownName(m.author));
          authorById.set(String(m.id), aid);
        }
        const ref = m.referenced_message;
        if (ref?.author?.id) {
          authorById.set(String(ref.id), String(ref.author.id));
          if (!authorName.has(String(ref.author.id))) authorName.set(String(ref.author.id), ownName(ref.author));
        }
        const ts = m.timestamp || snowflakeToIso(String(m.id));
        if (ts) {
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
          inc(buckets, bucketOf(ts, groupBy));
        }
        attachments += m.attachments?.length ?? 0;
        const refId = m.message_reference?.message_id;
        if (refId) {
          replies++;
          const to = ref?.author?.id ? String(ref.author.id) : authorById.get(refId);
          if (aid && to) inc(edges, `${aid}→${to}`);
          else if (aid) pending.push({ from: aid, refId });
        }
        const content = m.content || "";
        for (const u of content.match(URL_RE) ?? []) {
          links++;
          const dm = /https?:\/\/([^\s/]+)/i.exec(u);
          if (dm?.[1]) inc(domains, dm[1].replace(/^www\./, "").toLowerCase());
        }
        for (const wd of content.replace(/https?:\/\/\S+/gi, " ").toLowerCase().match(WORD_RE) ?? []) {
          const norm = stripAccents(wd);
          if (!STOPWORDS.has(norm)) inc(words, norm);
        }
      }
      cursor = batch.at(-1)?.id;
      if (stop || batch.length < 100) {
        reachedEnd = true;
        break;
      }
    }
    for (const { from, refId } of pending) {
      const to = authorById.get(refId);
      if (to) inc(edges, `${from}→${to}`);
    }
    const rank = (m: Map<string, number>, n: number): [string, number][] => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n);
    return {
      channel: ch ? { id: ch.id, name: this.dmName(ch), type: ch.type, guildId: ch.guildId } : { id: cid },
      summary: {
        total: scanned,
        attachments,
        links,
        replies,
        distinctAuthors: authorCount.size,
        span: { firstTs, lastTs },
        windowSince: str(a.since) ?? null,
        windowUntil: str(a.until) ?? null,
        pagesFetched: pages,
        scanComplete: reachedEnd,
        hardCapHit: scanned >= hardCap,
      },
      byAuthor: rank(authorCount, topN).map(([id, count]) => ({ id, name: authorName.get(id) ?? null, count, pct: scanned ? +((count / scanned) * 100).toFixed(1) : 0 })),
      byBucket: [...buckets.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([bucket, count]) => ({ bucket, count })),
      replyEdges: rank(edges, topN).map(([k, count]) => {
        const [from = "", to = ""] = k.split("→");
        return { from, fromName: authorName.get(from) ?? null, to, toName: authorName.get(to) ?? null, count };
      }),
      topDomains: rank(domains, topN).map(([domain, count]) => ({ domain, count })),
      topWords: rank(words, topN).map(([word, count]) => ({ word, count })),
    };
  }

  async pins(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    const ch = await this.channel(cid);
    let raw: RawMsg[];
    try {
      raw = await this.api<RawMsg[]>("GET", `/channels/${cid}/pins`);
    } catch (e) {
      // Discord's newer pins route, paged
      const r = await this.api<{ items?: { message?: RawMsg }[] }>("GET", `/channels/${cid}/messages/pins?limit=50`).catch(() => {
        throw e;
      });
      raw = (r?.items ?? []).map((x) => x.message).filter((m): m is RawMsg => !!m);
    }
    raw = Array.isArray(raw) ? raw : [];
    const select = new Set(strs(a.select).length ? strs(a.select) : ["id", "content", "author", "timestamp"]);
    return { channel: ch ? { id: ch.id, name: this.dmName(ch), guildId: ch.guildId } : { id: cid }, count: raw.length, messages: raw.map((m) => projectMessage(m, select)) };
  }

  async threads(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    const ch = await this.channel(cid);
    const archivedLimit = clamp(a.archivedLimit, 1, 100, 25);
    type RawThread = { id: string; name?: string; type?: number; parent_id?: string; owner_id?: string; member_count?: number; message_count?: number; thread_metadata?: { archived?: boolean; locked?: boolean; auto_archive_duration?: number; archive_timestamp?: string } };
    const project = (t: RawThread): Obj => ({
      id: t.id,
      name: t.name,
      type: t.type,
      parentId: t.parent_id,
      archived: !!t.thread_metadata?.archived,
      locked: !!t.thread_metadata?.locked,
      autoArchiveDuration: t.thread_metadata?.auto_archive_duration ?? null,
      archiveTimestamp: t.thread_metadata?.archive_timestamp ?? null,
      memberCount: t.member_count ?? null,
      messageCount: t.message_count ?? null,
      ownerId: t.owner_id ?? null,
    });
    const isThread = !!ch && THREAD_TYPES.has(ch.type);
    const parent = isThread ? (ch.parentId ?? cid) : cid;
    const gid = ch?.guildId ?? null;
    const active: Obj[] = [];
    if (gid) {
      try {
        const j = await this.api<{ threads?: RawThread[] }>("GET", `/guilds/${gid}/threads/active`);
        for (const t of j?.threads ?? []) if (t.parent_id === parent) active.push(project(t));
      } catch {
        // users can't always list them; the channel's own search below still works
      }
    }
    let archived: Obj[] = [];
    if (a.includeArchived !== false) {
      try {
        const j = await this.api<{ threads?: RawThread[] }>("GET", `/channels/${parent}/threads/archived/public?limit=${archivedLimit}`);
        archived = (j?.threads ?? []).map(project);
      } catch {
        // none
      }
    }
    return {
      channel: ch ? { id: ch.id, name: ch.name, type: ch.type, guildId: gid } : { id: cid },
      parentId: parent,
      activeCount: active.length,
      archivedCount: archived.length,
      threads: { active, archived },
    };
  }

  async findUser(a: Obj): Promise<Obj> {
    let q = String(a.query ?? "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
    if (!q) throw new Error("`query` is required: a username, display name or nickname.");
    const tag = /^(.+)#(\d{4})$/.exec(q);
    if (tag?.[1]) q = tag[1];
    this.needWorld();
    const limit = clamp(a.limit, 1, 25, 10);
    const me = this.l.me()?.id;
    const nicks = new Map<string, { guildId: string; guildName: string | null; nick: string }[]>();
    for (const [uid, gs] of this.w.members) {
      for (const [gid, nick] of gs) {
        if (!nick || !nick.toLowerCase().includes(q)) continue;
        const list = nicks.get(uid) ?? [];
        list.push({ guildId: gid, guildName: this.guildName(gid), nick });
        nicks.set(uid, list);
      }
    }
    const found: { rank: number; u: core.SlimUser; friendNick: string | null; serverNicks: { guildId: string; guildName: string | null; nick: string }[] }[] = [];
    for (const u of this.w.users.values()) {
      if (u.id === me) continue;
      const username = u.username.toLowerCase();
      const global = (u.globalName ?? "").toLowerCase();
      const friendNick = this.w.relationships.get(u.id)?.nickname ?? null;
      const serverNicks = nicks.get(u.id) ?? [];
      let rank: number;
      if (username === q) rank = 0;
      else if (global === q || friendNick?.toLowerCase() === q || serverNicks.some((n) => n.nick.toLowerCase() === q)) rank = 1;
      else if (username.includes(q) || global.includes(q) || friendNick?.toLowerCase().includes(q) || serverNicks.length) rank = 2;
      else continue;
      found.push({ rank, u, friendNick, serverNicks });
    }
    found.sort((x, y) => x.rank - y.rank || x.u.username.localeCompare(y.u.username));
    const matches = found.slice(0, limit).map(({ rank, u, friendNick, serverNicks }) => ({
      id: u.id,
      username: u.username,
      globalName: u.globalName ?? null,
      bot: !!u.bot,
      match: rank === 0 ? "username" : rank === 1 ? "exact name" : "partial",
      relationship: RELATIONSHIP_WORDS[this.w.relationships.get(u.id)?.type ?? 0] ?? "none",
      friendNickname: friendNick,
      serverNicknames: serverNicks.slice(0, 5),
      dmChannelId: this.w.dmWith(u.id)?.id ?? null,
      sharedServers: [...(this.w.members.get(u.id)?.keys() ?? [])]
        .filter((g) => this.w.guilds.has(g))
        .slice(0, 10)
        .map((g) => ({ id: g, name: this.guildName(g) })),
    }));
    return {
      query: a.query,
      matches,
      more: Math.max(0, found.length - matches.length),
      searched: { users: this.w.users.size, servers: this.w.guilds.size },
      note: matches.length
        ? "From people this account already knows. A 1:1 DM with someone listed here can be opened with discord_dm_open."
        : "Nobody by that name among the people this account already knows (friends, DMs, people seen in its servers). Discord's only way to look up a stranger's username is to send them a friend request, and Hub won't do that. Ask the person to send this account a DM or a friend request, or to share a server with it; then search again.",
    };
  }

  async member(a: Obj): Promise<Obj> {
    const uid = str(a.userId);
    if (!uid) throw new Error("`userId` is required.");
    type Profile = { user?: core.RawUser & { accent_color?: number }; user_profile?: { bio?: string; pronouns?: string; accent_color?: number }; mutual_guilds?: { id: string; nick?: string | null }[] };
    let profile: Profile | null = null;
    try {
      profile = await this.api<Profile>("GET", `/users/${uid}/profile?with_mutual_guilds=true`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new Error(`User not found: ${uid}`);
      if (e instanceof ApiError && e.status === 401) throw e;
    }
    const known = this.w.users.get(uid);
    const u: core.RawUser | undefined = profile?.user ?? (known ? { id: known.id, username: known.username, global_name: known.globalName, avatar: known.avatar, bot: known.bot ?? false, ...(known.discriminator ? { discriminator: known.discriminator } : {}) } : undefined);
    if (!u?.id) throw new Error(`User not found via profile API or the users this account has seen: ${uid}. The user may not share any context with you.`);
    const id = String(u.id);
    const created = Number((BigInt(id) >> 22n) + core.DISCORD_EPOCH);
    const mutualGuilds = (profile?.mutual_guilds ?? []).map((g) => ({ id: g.id, nick: g.nick || null }));
    return {
      id,
      username: u.username,
      globalName: ownName(u),
      discriminator: u.discriminator && u.discriminator !== "0" ? u.discriminator : undefined,
      avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=256` : null,
      bot: !!u.bot,
      createdAt: new Date(created).toISOString(),
      bio: profile?.user_profile?.bio || null,
      pronouns: profile?.user_profile?.pronouns || null,
      accentColor: profile?.user_profile?.accent_color ?? null,
      status: this.l.presence(uid),
      activities: this.w.activities.get(uid) ?? [],
      mutualGuilds,
      mutualGuildCount: mutualGuilds.length,
    };
  }

  async resolveMessage(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    const mid = str(a.messageId);
    if (!mid) throw new Error("`messageId` is required.");
    const msg = await this.message(cid, mid);
    if (!msg) throw new Error(`messageId ${mid} not found in channel ${cid}.`);
    const depth = clamp(a.depth, 0, 20, 5);
    const ref = msg.message_reference;
    const chain = ref?.message_id ? await this.replyChain(ref.channel_id || cid, ref.message_id, depth) : [];
    const ch = await this.channel(cid);
    return {
      channel: ch ? { id: ch.id, name: this.dmName(ch), guildId: ch.guildId } : { id: cid },
      message: projectMessage(msg, new Set(["id", "content", "author", "timestamp", "attachments", "replyTo", "mentions", "reactions", "edited"])),
      replyChain: chain,
    };
  }

  /** Where an attachment is (the app fetches its bytes from Discord's CDN). */
  async attachment(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    const mid = str(a.messageId);
    if (!mid) throw new Error("`messageId` is required.");
    const msg = await this.message(cid, mid);
    if (!msg) throw new Error(`messageId ${mid} not found in channel ${cid}.`);
    const list = msg.attachments ?? [];
    if (!list.length) throw new Error(`message ${mid} has no attachments.`);
    const i = clamp(a.index, 0, list.length - 1, 0);
    const x = list[i] as core.RawAttachment;
    return { index: i, attachmentCount: list.length, name: x.filename, url: x.url, proxyUrl: x.proxy_url ?? null, size: x.size, contentType: x.content_type ?? null, width: x.width ?? null, height: x.height ?? null };
  }

  async emoji(a: Obj): Promise<Obj> {
    this.needWorld();
    const q = (str(a.query) ?? "").trim().toLowerCase();
    const limit = clamp(a.limit, 1, 200, 25);
    const score = (name: string): number => {
      if (!q) return 0;
      const lo = name.toLowerCase();
      return lo === q ? 100 : lo.startsWith(q) ? 75 : lo.includes(q) ? 50 : -1;
    };
    const out: (Obj & { _score: number; name: string })[] = [];
    for (const g of this.w.guilds.values()) {
      if (str(a.guildId) && g.id !== a.guildId) continue;
      for (const e of g.emojis) {
        const s = score(e.name);
        if (q && s < 0) continue;
        out.push({ name: e.name, id: e.id, animated: e.animated, guildId: g.id, guildName: g.name, url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "png"}?size=96`, shortcode: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`, _score: s });
      }
    }
    out.sort((x, y) => y._score - x._score || x.name.localeCompare(y.name));
    return { total: out.length, query: q || undefined, emojis: out.slice(0, limit).map(({ _score, ...rest }) => rest) };
  }

  async unread(a: Obj): Promise<Obj> {
    this.needWorld();
    const limit = clamp(a.limit, 1, 500, 100);
    const countTop = clamp(a.countTop, 0, 25, 10);
    const chans: WChannel[] = [...this.w.privateOrder()];
    if (a.includeGuilds === true) for (const g of this.w.guilds.values()) for (const c of g.channels.values()) if (c.type === 0 || c.type === 5) chans.push(c);
    type Row = Obj & { channelId: string; unreadCount: number | null; mentionCount: number; lastReadMessageId: string | null; lastMessageId: string | null; oldestUnreadId: string | null; notCounted?: boolean; unreadCountAtLeast?: boolean };
    const out: Row[] = [];
    let totalMentions = 0;
    for (const ch of chans) {
      const rs = this.w.readStates.get(ch.id);
      const mentions = rs?.mentionCount ?? 0;
      const priv = ch.type === 1 || ch.type === 3;
      // A server channel with no read state yet is one this account never opened: Discord doesn't count those.
      const has = !!ch.lastMessageId && (rs ? core.cmpId(ch.lastMessageId, rs.lastMessageId) > 0 : priv);
      if (!has && !mentions) continue;
      if (a.mentionsOnly === true && !mentions) continue;
      totalMentions += mentions;
      const name = priv ? (this.dmEntry(ch).name as string) : ch.name;
      out.push({
        channelId: ch.id,
        kind: ch.type === 1 ? "dm" : ch.type === 3 ? "group" : "guild",
        name,
        guildId: ch.guildId,
        guildName: this.guildName(ch.guildId),
        unreadCount: null,
        mentionCount: mentions,
        oldestUnreadId: null,
        lastReadMessageId: rs?.lastMessageId ?? null,
        lastMessageId: ch.lastMessageId,
      });
    }
    out.sort((x, y) => y.mentionCount - x.mentionCount || core.cmpId(y.lastMessageId, x.lastMessageId));
    const shown = out.slice(0, limit);
    let asked = 0;
    for (const c of shown) {
      if (asked >= countTop) break;
      if (asked++) await this.tools.wait(300);
      try {
        const msgs = await this.messages(c.channelId, { after: c.lastReadMessageId ?? "0", limit: 100 });
        c.unreadCount = msgs.length;
        if (msgs.length >= 100) c.unreadCountAtLeast = true;
        const oldest = msgs.reduce<string | null>((o, m) => (o === null || core.cmpId(String(m.id), o) < 0 ? String(m.id) : o), null);
        c.oldestUnreadId = oldest;
      } catch {
        // stays unknown: the channel may not be readable
      }
    }
    for (const c of out) if (c.unreadCount === null) c.notCounted = true;
    return {
      channelsScanned: chans.length,
      totalUnread: out.reduce((n, c) => n + (c.unreadCount ?? 0), 0),
      channelsNotCounted: out.filter((c) => c.notCounted).length,
      totalMentions,
      count: out.length,
      channels: shown,
    };
  }

  async ack(a: Obj): Promise<Obj> {
    const cid = str(a.channelId);
    if (!cid) throw new Error("`channelId` is required.");
    const ch = await this.channel(cid);
    let mid = str(a.messageId) ?? ch?.lastMessageId ?? undefined;
    if (!mid) mid = (await this.messages(cid, { limit: 1 }))[0]?.id;
    if (!mid) throw new Error("Could not determine a messageId to ack (channel may be empty).");
    await this.api("POST", `/channels/${cid}/messages/${mid}/ack`, { token: null, last_viewed: Math.floor((Date.now() - Number(core.DISCORD_EPOCH)) / 86_400_000) });
    this.w.apply("MESSAGE_ACK", { channel_id: cid, message_id: mid, mention_count: 0 }, this.l.me()?.id ?? null);
    return { ok: true, channelId: cid, ackedMessageId: mid, channel: ch ? { id: ch.id, name: ch.name, guildId: ch.guildId } : null };
  }

  // ---------- writing ----------
  /** Paces `kind`: waits a short gap, or answers with why it can't go now. */
  private async paced(kind: string): Promise<Obj | null> {
    const p = this.tools.paceLog().check(kind);
    if ("wait" in p) await this.tools.wait(p.wait * 1000);
    else if ("refuse" in p) return { paced: true, note: p.refuse };
    return null;
  }

  async send(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    const ch = await this.channel(cid);
    if (!ch) throw new Error(`Channel not found: ${cid}`);
    const content = typeof a.content === "string" ? a.content : "";
    const files = (Array.isArray(a.files) ? a.files : []) as { name?: string; mime?: string; base64?: string }[];
    if (!files.length && !content.trim()) throw new Error("`content` is required when no `files` are provided.");
    if (content.length > 2000) throw new Error("Discord messages are at most 2000 characters.");
    const ups = core.checkUploads(files.map((f) => ({ name: String(f.name ?? "file"), type: String(f.mime ?? "application/octet-stream"), data: new Uint8Array(Buffer.from(String(f.base64 ?? ""), "base64")) })));
    const reply = str(a.replyToMessageId);
    if (reply && !(await this.message(cid, reply)))
      throw new Error(`replyToMessageId ${reply} not found in channel ${cid}. Discord would reject this reply. Pull message IDs from a fresh discord_view or discord_history result for this channel.`);
    const kind = ups.length ? "upload" : "send";
    const stop = await this.paced(kind);
    if (stop) return stop;
    let typingMs = 0;
    if (typeof a.typingMs === "number" && a.typingMs > 0) typingMs = Math.min(30_000, a.typingMs);
    else if (a.typing === true) typingMs = Math.max(800, Math.min(6000, content.length * 60));
    if (typingMs) {
      const start = Date.now();
      for (;;) {
        await this.api("POST", `/channels/${cid}/typing`).catch(() => {});
        const left = typingMs - (Date.now() - start);
        if (left <= 0) break;
        await this.tools.wait(Math.min(left, 8000));
        if (Date.now() - start >= typingMs) break;
      }
    }
    const tts = a.tts === true;
    const body: Obj = { mobile_network_type: "unknown", content, nonce: core.nowSnowflake(), tts, flags: 0 };
    if (reply) body.message_reference = { channel_id: cid, message_id: reply, ...(ch.guildId ? { guild_id: ch.guildId } : {}) };
    let sent: RawMsg;
    try {
      if (ups.length) Object.assign(body, { channel_id: cid, type: 0, sticker_ids: [], attachments: await this.l.upload(cid, ups) });
      sent = await this.api<RawMsg>("POST", `/channels/${cid}/messages`, body);
    } catch (e) {
      if (e instanceof ApiError && e.captcha) throw new Error("Discord asked for a captcha before this message could go, and only a person can solve one: ask the user to send it from their Discord app. Don't retry.");
      const known = e instanceof ApiError && e.code !== undefined ? core.SEND_ERRORS[e.code] : undefined;
      throw known ? new Error(known) : e;
    }
    this.tools.paceLog().note(kind);
    return { ok: true, channel: { id: ch.id, name: this.dmName(ch), guildId: ch.guildId, guildName: this.guildName(ch.guildId) }, messageId: sent?.id ?? null, content, fileCount: ups.length, replyTo: reply ?? null, tts };
  }

  /** The message, which must be in the channel (a made-up id errors instead of doing nothing). */
  private async mustFind(cid: string, mid: string | undefined): Promise<RawMsg> {
    if (!mid) throw new Error("`messageId` is required.");
    const m = await this.message(cid, mid);
    if (!m) throw new Error(`messageId ${mid} not found in channel ${cid}. Pull message IDs from a fresh discord_view or discord_history result for this channel.`);
    return m;
  }

  async react(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    if (!str(a.emoji)) throw new Error("`emoji` is required.");
    const action = str(a.action) ?? "add";
    if (action !== "add" && action !== "remove") throw new Error("`action` must be 'add' or 'remove'.");
    const emoji = parseEmoji(a.emoji as string);
    const m = await this.mustFind(cid, str(a.messageId));
    const stop = await this.paced("react");
    if (stop) return stop;
    const e = encodeURIComponent(emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name);
    if (action === "add") await this.api("PUT", `/channels/${cid}/messages/${m.id}/reactions/${e}/@me?location=Message&type=0`);
    else await this.api("DELETE", `/channels/${cid}/messages/${m.id}/reactions/${e}/0/@me?location=Message&burst=false`);
    this.tools.paceLog().note("react");
    return { ok: true, channelId: cid, messageId: m.id, emoji: emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.name, action };
  }

  private mine(m: RawMsg, verb: string): void {
    const me = this.l.me();
    if (!me) throw new Error("The account's own user isn't known yet.");
    if (m.author?.id !== me.id) throw new Error(`Cannot ${verb} message ${m.id}: author is ${m.author?.id} but viewer is ${me.id}. Discord only allows ${verb}ing your own messages.`);
  }

  async edit(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    if (typeof a.content !== "string") throw new Error("`content` is required.");
    const m = await this.mustFind(cid, str(a.messageId));
    this.mine(m, "edit");
    await this.api("PATCH", `/channels/${cid}/messages/${m.id}`, { content: a.content });
    return { ok: true, channelId: cid, messageId: m.id, content: a.content };
  }

  async delete(a: Obj): Promise<Obj> {
    const cid = this.channelId(a);
    const m = await this.mustFind(cid, str(a.messageId));
    this.mine(m, "delete");
    await this.api("DELETE", `/channels/${cid}/messages/${m.id}`);
    return { ok: true, channelId: cid, messageId: m.id, deletedContentPreview: (m.content || "").slice(0, 200) };
  }

  async dmOpen(a: Obj): Promise<Obj> {
    const ids = strs(a.userIds).length ? strs(a.userIds) : str(a.userId) ? [a.userId as string] : [];
    if (!ids.length) throw new Error("Provide `userId` or `userIds`.");
    const existing = ids.length === 1 ? this.w.dmWith(ids[0] as string) : undefined;
    if (!existing) {
      // A DM that doesn't exist yet is what the spam filter watches.
      const p = this.tools.paceLog().check("dm");
      if ("refuse" in p) return { paced: true, note: p.refuse };
    }
    let raw: Obj;
    try {
      raw = await this.api<Obj>("POST", "/users/@me/channels", { recipients: ids });
    } catch (e) {
      if (e instanceof ApiError && e.captcha) throw new Error("Discord asked for a captcha before opening this DM, and only a person can solve one: ask the user to message them from their Discord app. Don't retry.");
      throw e;
    }
    const ch = this.w.remember(raw);
    if (!ch) throw new Error("Discord didn't open the DM.");
    const created = !existing && !raw.last_message_id;
    if (created) this.tools.paceLog().note("dm");
    this.tools.setCurrent(this.key, ch.id);
    return { ...this.dmEntry(ch), rendered: true, created, ...(created ? {} : { existed: true }) };
  }

  // ---------- servers ----------
  private async settingsProto(fresh: boolean): Promise<string> {
    if (!fresh && this.w.settingsProto) return this.w.settingsProto;
    const r = await this.api<{ settings?: string }>("GET", "/users/@me/settings-proto/1");
    if (typeof r?.settings !== "string") throw new Error("Discord didn't give its settings.");
    this.w.settingsProto = r.settings;
    return r.settings;
  }

  async guilds(): Promise<Obj> {
    this.needWorld();
    const folders = readFolders(await this.settingsProto(false));
    const all = this.w.guilds;
    const nameOf = (gid: string): string | null => all.get(gid)?.name ?? null;
    const sidebar = folders.map((f) =>
      f.id !== null
        ? { kind: "folder", id: f.id, name: f.name ?? "", color: f.color, expanded: true, guildIds: [...f.guildIds], guilds: f.guildIds.map((g) => ({ id: g, name: nameOf(g) })) }
        : { kind: "guild", guildId: f.guildIds[0], name: f.guildIds[0] ? nameOf(f.guildIds[0]) : null },
    );
    const placed = new Set(folders.flatMap((f) => f.guildIds));
    const unplaced = [...all.keys()].filter((g) => !placed.has(g)).map((g) => ({ kind: "guild", guildId: g, name: nameOf(g), newlyJoined: true }));
    const list = [...unplaced, ...sidebar];
    return { totalGuilds: all.size, entries: list.length, sidebar: list };
  }

  async organize(a: Obj): Promise<Obj> {
    if (!Array.isArray(a.sidebar)) throw new Error("Expected `sidebar: SidebarEntry[]`.");
    this.needWorld();
    const known = new Set(this.w.guilds.keys());
    const seen = new Set<string>();
    const built: Folder[] = [];
    const errors: string[] = [];
    (a.sidebar as Obj[]).forEach((e, i) => {
      const kind = str(e?.kind) ?? (e?.guildIds != null ? "folder" : "guild");
      if (kind === "guild") {
        const gid = str(e.guildId) ?? strs(e.guildIds)[0];
        if (!gid) return void errors.push(`entries[${i}]: missing guildId`);
        if (!known.has(gid)) return void errors.push(`entries[${i}]: unknown guildId ${gid}`);
        if (seen.has(gid)) return void errors.push(`entries[${i}]: duplicate guildId ${gid}`);
        seen.add(gid);
        built.push({ guildIds: [gid], id: null, name: null, color: null });
        return;
      }
      const gids = strs(e.guildIds);
      if (!gids.length) return void errors.push(`entries[${i}]: folder must have ≥1 guildIds`);
      const f: Folder = { guildIds: [], id: null, name: null, color: null };
      for (const gid of gids) {
        if (!known.has(gid)) errors.push(`entries[${i}]: unknown guildId ${gid}`);
        else if (seen.has(gid)) errors.push(`entries[${i}]: duplicate guildId ${gid}`);
        else {
          seen.add(gid);
          f.guildIds.push(gid);
        }
      }
      if (!f.guildIds.length) return;
      try {
        f.id = e.id != null ? BigInt(e.id as string | number).toString() : (BigInt(Date.now()) * 1000n + BigInt(i)).toString();
      } catch {
        errors.push(`entries[${i}]: bad folder id ${String(e.id)}`);
      }
      if (e.name != null) f.name = String(e.name);
      if (e.color != null) {
        const c = Number(e.color);
        if (Number.isInteger(c) && c >= 0) f.color = c;
        else errors.push(`entries[${i}]: bad folder color ${String(e.color)}`);
      }
      built.push(f);
    });
    const missing = [...known].filter((g) => !seen.has(g));
    if (missing.length) errors.push(`missing guilds (must appear exactly once): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` … (+${missing.length - 8})` : ""}`);
    const nameOf = (gid: string): string | null => this.w.guilds.get(gid)?.name ?? null;
    const preview = built.map((b) =>
      b.id === null
        ? { kind: "guild", guildId: b.guildIds[0], name: nameOf(b.guildIds[0] as string) }
        : { kind: "folder", id: b.id, name: b.name ?? "", color: b.color != null ? String(b.color) : null, guildIds: b.guildIds, guilds: b.guildIds.map((g) => ({ id: g, name: nameOf(g) })) },
    );
    if (errors.length) return { applied: false, errors, preview };
    if (a.apply !== true) return { applied: false, dryRun: true, note: "Dry run — no changes applied. Pass `apply: true` to commit.", preview };
    const next = withFolders(await this.settingsProto(true), built);
    const r = await this.api<{ settings?: string }>("PATCH", "/users/@me/settings-proto/1", { settings: next });
    const now = typeof r?.settings === "string" ? r.settings : null;
    if (now) this.w.settingsProto = now;
    const took = now !== null && JSON.stringify(readFolders(now).map((f) => f.guildIds)) === JSON.stringify(built.map((f) => f.guildIds));
    if (!took) return { applied: false, failed: true, note: "Discord didn't take the new layout: its settings don't show it afterwards. Nothing else was tried.", preview };
    return { applied: true, entries: built.length, layout: preview };
  }

  /** Waits (a few seconds at most) for the gateway to say `ok`. */
  private async until(ok: () => boolean): Promise<boolean> {
    const end = Date.now() + this.tools.confirmMs();
    while (!ok()) {
      if (Date.now() > end) return false;
      await this.tools.wait(200);
    }
    return true;
  }

  async join(a: Obj): Promise<Obj> {
    const code = parseInviteCode(a.invite);
    type Invite = { guild?: { id: string; name: string } | null; channel?: { id: string; name: string } | null; approximate_member_count?: number; approximate_presence_count?: number; inviter?: { id: string; username: string } | null };
    let inv: Invite;
    try {
      inv = await this.api<Invite>("GET", `/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.code === 10006)) return { joined: false, code, error: "Invite is invalid, expired, or revoked." };
      throw e;
    }
    const guild = inv?.guild ?? null;
    const preview = {
      code,
      guild: guild ? { id: guild.id, name: guild.name } : null,
      channel: inv?.channel ? { id: inv.channel.id, name: inv.channel.name } : null,
      approxMembers: inv?.approximate_member_count ?? null,
      approxOnline: inv?.approximate_presence_count ?? null,
      inviter: inv?.inviter ? { id: inv.inviter.id, username: inv.inviter.username } : null,
    };
    if (guild && this.w.guilds.has(guild.id)) return { joined: false, alreadyMember: true, ...preview };
    if (a.apply !== true) return { joined: false, dryRun: true, note: "Dry run — invite resolved but not joined. Pass `apply: true` to join.", ...preview };
    let r: { guild?: { id?: string } } | null;
    try {
      r = await this.api("POST", `/invites/${encodeURIComponent(code)}`, {});
    } catch (e) {
      if (e instanceof ApiError && e.captcha)
        return {
          joined: false,
          captchaRequired: true,
          ...preview,
          note: "Discord wants a captcha for this join, and only a person can solve it: Hub has no Discord page to show it in. Ask the user to join this server from their own Discord app; don't retry.",
        };
      return { joined: false, error: e instanceof Error ? e.message : String(e), ...preview };
    }
    const gid = guild?.id ?? r?.guild?.id;
    const memberNow = gid ? await this.until(() => this.w.guilds.has(gid)) : false;
    if (gid && (memberNow || r?.guild?.id)) this.tools.noteJoined(gid);
    if (memberNow) return { joined: true, ...preview };
    return { joined: false, ...preview, note: "Invite accepted but the server isn't visible yet — it may still be loading, or onboarding/rules may be gating entry. Re-check membership shortly (discord_guilds)." };
  }

  async leave(a: Obj): Promise<Obj> {
    const gid = String(a.guildId ?? "").trim();
    if (!snowflakeRe.test(gid)) throw new Error("`guildId` must be a Discord snowflake.");
    this.needWorld();
    const g = this.w.guilds.get(gid);
    const preview = { guild: g ? { id: g.id, name: g.name, ownerId: g.ownerId } : { id: gid, name: null } };
    if (!g) return { left: false, alreadyAbsent: true, ...preview };
    const me = this.l.me();
    if (me && g.ownerId === me.id) return { left: false, ownsGuild: true, note: "You own this guild — transfer ownership before leaving. Discord rejects owner leaves.", ...preview };
    if (a.apply !== true) return { left: false, dryRun: true, note: "Dry run — membership confirmed but not changed. Pass apply: true to leave this guild.", ...preview };
    await this.api("DELETE", `/users/@me/guilds/${gid}`, { lurking: false });
    const gone = await this.until(() => !this.w.guilds.has(gid));
    return {
      left: gone,
      stillMember: !gone,
      ...preview,
      note: gone ? "Left guild and confirmed Discord no longer lists it for this account." : "Discord accepted the leave request, but hasn't confirmed it yet. Re-check shortly.",
    };
  }

  async mute(a: Obj): Promise<Obj> {
    const gid = String(a.guildId ?? "").trim();
    if (!snowflakeRe.test(gid)) throw new Error("`guildId` must be a Discord snowflake.");
    this.needWorld();
    const g = this.w.guilds.get(gid);
    const action = a.action === "unmute" ? "unmute" : "mute";
    const duration = str(a.duration) ?? "forever";
    const window = MUTE_SECONDS[duration] ?? -1;
    const state = (): Obj => {
      const s = this.w.guildSettings.get(gid);
      return { muted: s?.muted === true, muteConfig: s?.muteConfig ?? null };
    };
    const before = state() as { muted: boolean; muteConfig: { end_time: string | null } | null };
    const preview = { guild: g ? { id: g.id, name: g.name, ownerId: g.ownerId } : { id: gid, name: null }, action, duration: action === "mute" ? duration : null, before };
    if (!g) return { applied: false, alreadyAbsent: true, note: "Not a server this account is in.", ...preview };
    const wanted = action === "mute";
    const endless = (c: { end_time: string | null } | null): boolean => !c?.end_time;
    if (before.muted === wanted && (!wanted || window <= 0 === endless(before.muteConfig)))
      return { applied: false, unchanged: true, note: wanted ? "Already muted that way: nothing to change." : "Not muted: nothing to change.", ...preview };
    if (a.apply !== true) return { applied: false, dryRun: true, note: "Dry run - membership confirmed but notification settings were not changed. Pass apply: true to update this guild.", ...preview };
    const patch = wanted ? { muted: true, mute_config: { selected_time_window: window, end_time: window > 0 ? new Date(Date.now() + window * 1000).toISOString() : null } } : { muted: false };
    const r = await this.api<Obj>("PATCH", `/users/@me/guilds/${gid}/settings`, patch);
    if (r && typeof r === "object") this.w.apply("USER_GUILD_SETTINGS_UPDATE", { ...r, guild_id: gid }, this.l.me()?.id ?? null);
    const after = state() as { muted: boolean };
    if (after.muted !== wanted) return { applied: false, failed: true, ...preview, after, note: `Discord didn't take the change: the server still shows as ${after.muted ? "muted" : "not muted"}. Nothing else was tried.` };
    return { applied: true, ...preview, after, note: wanted && window <= 0 ? "Muted until manually turned back on." : wanted ? "Muted for the requested duration." : "Server unmuted." };
  }

  async onboarding(a: Obj): Promise<Obj> {
    const answerOptional = a.answerOptional === true;
    const max = clamp(a.maxQuestions, 1, 100, 40);
    const cur = this.tools.currentOf(this.key);
    const curGuild = cur ? (await this.channel(cur.channelId))?.guildId : null;
    const start = str(a.guildId) ?? curGuild ?? this.tools.joinedGuilds().at(-1) ?? null;
    if (!start) return { completed: false, handled: 0, startGuild: null, finalUrl: null, log: ["No server to onboard: pass `guildId` (or join one with discord_join first)."] };
    const targets = a.allServers === true ? [start, ...this.tools.joinedGuilds().filter((g) => g !== start).reverse()] : [start];
    const log: string[] = [];
    let handled = 0;
    let completed = true;
    const ts = Math.floor(Date.now() / 1000);
    for (const gid of targets) {
      const label = this.guildName(gid) ?? gid;
      type Prompt = { id: string; title?: string; required?: boolean; in_onboarding?: boolean; options?: { id: string; title?: string }[] };
      let ob: { enabled?: boolean; prompts?: Prompt[] } | null = null;
      try {
        ob = await this.api("GET", `/guilds/${gid}/onboarding`);
      } catch (e) {
        log.push(`${label}: couldn't read its onboarding (${e instanceof Error ? e.message : String(e)}).`);
      }
      const prompts = (ob?.enabled === false ? [] : (ob?.prompts ?? [])).filter((p) => p.in_onboarding !== false).slice(0, max - handled);
      if (prompts.length) {
        const responses: string[] = [];
        const seenPrompts: Record<string, number> = {};
        const seenOptions: Record<string, number> = {};
        prompts.forEach((p, i) => {
          seenPrompts[p.id] = ts;
          for (const o of p.options ?? []) seenOptions[o.id] = ts;
          const tag = p.required ? "[required]" : "[optional]";
          const first = p.options?.[0];
          if ((p.required || answerOptional) && first) {
            responses.push(first.id);
            log.push(`Q${i + 1}/${prompts.length} ${tag} -> selected first option ("${first.title ?? first.id}")`);
          } else log.push(`Q${i + 1}/${prompts.length} ${tag} -> skip`);
          handled++;
        });
        try {
          await this.api("POST", `/guilds/${gid}/onboarding-responses`, { onboarding_responses: responses, onboarding_prompts_seen: seenPrompts, onboarding_responses_seen: seenOptions });
          log.push(`${label}: answers sent.`);
        } catch (e) {
          completed = false;
          log.push(`${label}: Discord didn't take the answers (${e instanceof Error ? e.message : String(e)}).`);
        }
      } else if (ob) log.push(`${label}: no onboarding question to answer.`);
      // The rules gate ("Read & Agree to Server Rules"): the server's member verification.
      type FormField = { field_type?: string; label?: string; required?: boolean; values?: string[]; response?: unknown };
      let mv: { version?: string; form_fields?: FormField[] } | null = null;
      try {
        mv = await this.api("GET", `/guilds/${gid}/member-verification?with_guild=false`);
      } catch {
        mv = null; // no rules to agree to
      }
      const fields = mv?.form_fields ?? [];
      if (fields.length) {
        if (fields.every((f) => f.field_type === "TERMS")) {
          try {
            await this.api("PUT", `/guilds/${gid}/requests/@me`, { version: mv?.version, form_fields: fields.map((f) => ({ ...f, response: true })) });
            handled++;
            log.push(`${label}: rules agreed to — onboarding complete.`);
          } catch (e) {
            completed = false;
            log.push(`${label}: Discord didn't take the rules' agreement (${e instanceof Error ? e.message : String(e)}).`);
          }
        } else {
          completed = false;
          log.push(`${label}: the server's entry form asks for written answers — the user has to fill it in their Discord app.`);
        }
      }
    }
    return { completed, handled, startGuild: start, finalUrl: null, log };
  }

  // ---------- waiting ----------
  async waitForMessage(a: Obj): Promise<Obj> {
    const timeoutMs = clamp(a.timeoutMs, 1000, 600_000, 60_000);
    const cap = clamp(a.maxMatches, 1, 50, 1);
    const contains = str(a.contains)?.toLowerCase() ?? null;
    const viewer = this.l.me()?.id ?? null;
    const matches: Obj[] = [];
    const seen = new Set<string>();
    const take = (m: RawMsg): void => {
      const id = String(m.id ?? "");
      if (!id || seen.has(id)) return;
      if (str(a.channelId) && m.channel_id !== a.channelId) return;
      if (str(a.fromUserId) && m.author?.id !== a.fromUserId) return;
      if (a.includeSelf !== true && viewer && m.author?.id === viewer) return;
      if (contains && !(m.content || "").toLowerCase().includes(contains)) return;
      if (a.mentionsViewer === true && viewer && !(m.mentions ?? []).some((u) => u.id === viewer)) return;
      seen.add(id);
      const out: Obj = {
        id,
        channelId: m.channel_id,
        guildId: m.guild_id ?? null,
        content: m.content || "",
        timestamp: m.timestamp ?? null,
        author: m.author ? { id: m.author.id, username: m.author.username, name: ownName(m.author), bot: !!m.author.bot } : null,
      };
      if (m.attachments?.length) out.attachments = m.attachments.map((x) => ({ name: x.filename, url: x.url, contentType: x.content_type, size: x.size }));
      const ref = m.message_reference?.message_id ?? m.referenced_message?.id;
      if (ref) out.replyTo = { id: ref };
      if (m.mentions?.length) out.mentions = m.mentions.map((u) => ({ id: u.id, name: ownName(u) }));
      if (m.mention_everyone) out.mentionEveryone = true;
      matches.push(out);
    };
    return await new Promise<Obj>((resolve) => {
      let done = false;
      const finish = (timedOut: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve({ done: matches.length > 0, timedOut, matches });
      };
      const off = this.l.on((t, d) => {
        if (t !== "MESSAGE_CREATE" || !d || typeof d !== "object") return;
        take(d as RawMsg);
        if (matches.length >= cap) finish(false);
      });
      const timer = setTimeout(() => finish(true), timeoutMs);
    });
  }
}
