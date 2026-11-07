// What the WhatsApp host keeps of the account, in SQLite on this PC: chats, contacts and messages
// as the engine (whatsapp/engine.mjs) hands them over, so reads never wait on the network. Each
// message keeps its raw form too: a download or a quoted reply sends it back to the engine.
import { Database } from "bun:sqlite";

export type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `123:4@s.whatsapp.net` (a device) and `123@c.us` are the user `123@s.whatsapp.net`. */
export function normJid(jid: string): string {
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0] ?? "";
  const server = jid.slice(at + 1);
  return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

export const isGroup = (jid: string): boolean => jid.endsWith("@g.us");
export const isLid = (jid: string): boolean => jid.endsWith("@lid");
export const isPhone = (jid: string): boolean => jid.endsWith("@s.whatsapp.net");

/** Chats nobody reads as conversations: status updates, channels, broadcast lists. */
export const skipped = (jid: string): boolean => jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "";

/** The number of a phone jid, as people write it. */
export function phoneOf(jid: string): string | undefined {
  return isPhone(jid) ? `+${jid.slice(0, jid.indexOf("@"))}` : undefined;
}

export interface Media {
  type: string;
  mimetype?: string;
  file_name?: string;
  size?: number;
  seconds?: number;
}

export interface Parsed {
  kind: string;
  text: string;
  media?: Media;
  quoted?: { id: string; text: string };
}

const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage", "editedMessage", "deviceSentMessage", "botInvokeMessage", "groupMentionedMessage"];
const NOT_CONTENT = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);

/** The message inside its wrappers (disappearing, view once, sent from the user's phone…). */
export function unwrap(m: unknown): Raw {
  let c = obj(m);
  for (let i = 0; i < 6; i++) {
    const w = WRAPPERS.find((k) => c[k] !== undefined && obj(c[k]).message !== undefined);
    if (w === undefined) break;
    c = obj(obj(c[w]).message);
  }
  return c;
}

/** Which kind of content `c` is: its first field that is one. */
export function contentType(c: Raw): string | undefined {
  return Object.keys(c).find((k) => !NOT_CONTENT.has(k) && c[k] !== null && c[k] !== undefined);
}

function duration(s: number | undefined): string {
  if (s === undefined) return "";
  return ` ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function media(type: string, m: Raw): Media {
  const v: Media = { type };
  const mime = str(m.mimetype);
  if (mime !== undefined) v.mimetype = mime;
  const name = str(m.fileName);
  if (name !== undefined) v.file_name = name;
  const size = num(m.fileLength);
  if (size !== undefined) v.size = size;
  const secs = num(m.seconds);
  if (secs !== undefined) v.seconds = secs;
  return v;
}

/** What a message says, in text, and what it carries. Undefined: nothing a person would read (keys, receipts, protocol). */
export function parseContent(message: unknown): Parsed | undefined {
  const c = unwrap(message);
  const type = contentType(c);
  if (type === undefined) return undefined;
  const m = obj(c[type]);
  const ctx = obj(m.contextInfo);
  const q = str(ctx.stanzaId);
  const quoted = q !== undefined ? { id: q, text: parseContent(ctx.quotedMessage)?.text ?? "" } : undefined;
  const out = (kind: string, text: string, med?: Media): Parsed => {
    const p: Parsed = { kind, text };
    if (med !== undefined) p.media = med;
    if (quoted !== undefined) p.quoted = quoted;
    return p;
  };
  switch (type) {
    case "conversation":
      return typeof c.conversation === "string" ? out("text", c.conversation) : undefined;
    case "extendedTextMessage":
      return out("text", str(m.text) ?? "");
    case "imageMessage":
      return out("image", str(m.caption) ?? "", media("image", m));
    case "videoMessage":
      return out(m.gifPlayback === true ? "gif" : "video", str(m.caption) ?? "", media(m.gifPlayback === true ? "gif" : "video", m));
    case "ptvMessage":
      return out("video", "", media("video", m));
    case "audioMessage": {
      const voice = m.ptt === true;
      return out(voice ? "voice" : "audio", `[${voice ? "voice note" : "audio"}${duration(num(m.seconds))}]`, media(voice ? "voice" : "audio", m));
    }
    case "documentMessage":
      return out("document", str(m.caption) ?? "", media("document", m));
    case "stickerMessage":
      return out("sticker", "[sticker]", media("sticker", m));
    case "locationMessage":
    case "liveLocationMessage": {
      const where = [str(m.name), str(m.address)].filter((x) => x !== undefined).join(", ");
      return out("location", `[location${where ? `: ${where}` : ""} ${num(m.degreesLatitude) ?? "?"},${num(m.degreesLongitude) ?? "?"}]`);
    }
    case "contactMessage":
      return out("contact", `[contact: ${str(m.displayName) ?? "?"}]`);
    case "contactsArrayMessage":
      return out("contact", `[contacts: ${arr(m.contacts).map((x) => str(obj(x).displayName) ?? "?").join(", ")}]`);
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3":
      return out("poll", `[poll: ${str(m.name) ?? ""} · ${arr(m.options).map((o) => str(obj(o).optionName) ?? "").join(" / ")}]`);
    case "eventMessage":
      return out("event", `[event: ${str(m.name) ?? ""}]`);
    case "buttonsResponseMessage":
      return out("text", str(m.selectedDisplayText) ?? "");
    case "listResponseMessage":
      return out("text", str(m.title) ?? "");
    case "templateButtonReplyMessage":
      return out("text", str(m.selectedDisplayText) ?? "");
    case "reactionMessage":
    case "protocolMessage":
    case "pollUpdateMessage":
    case "keepInChatMessage":
    case "pinInChatMessage":
    case "encReactionMessage":
      return undefined;
    default:
      return out("other", `[${type.replace(/Message$/, "")}]`);
  }
}

export interface Key {
  chat: string;
  id: string;
  fromMe: boolean;
  /** Who wrote it, in a group; the other person (or the user) in a direct chat. */
  sender: string;
  /** The phone jids WhatsApp sent beside a lid. */
  chatAlt?: string;
  senderAlt?: string;
}

export function keyOf(raw: Raw, me: string): Key | undefined {
  const k = obj(raw.key);
  const chat = str(k.remoteJid);
  const id = str(k.id);
  if (chat === undefined || id === undefined) return undefined;
  const fromMe = k.fromMe === true;
  const c = normJid(chat);
  const sender = fromMe ? me : normJid(str(k.participant) ?? str(raw.participant) ?? c);
  const v: Key = { chat: c, id, fromMe, sender };
  const ca = str(k.remoteJidAlt);
  if (ca !== undefined) v.chatAlt = normJid(ca);
  const sa = str(k.participantAlt);
  if (sa !== undefined) v.senderAlt = normJid(sa);
  return v;
}

export interface Msg {
  chat: string;
  id: string;
  from_me: boolean;
  sender: string;
  sender_name: string;
  ts: number;
  kind: string;
  text: string;
  media: Media | null;
  quoted_id: string | null;
  quoted_text: string | null;
  deleted: boolean;
  edited: boolean;
  reactions: Record<string, string>;
}

export interface Chat {
  jid: string;
  name: string;
  unread: number;
  last_ts: number;
  archived: boolean;
  group: boolean;
}

export interface Contact {
  jid: string;
  name: string;
  notify: string;
  phone: string;
}

type Row = Record<string, string | number | null>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', unread INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages (chat TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', media TEXT, quoted_id TEXT, quoted_text TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0, reactions TEXT, raw TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat, id));
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat, ts);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS messages_seq ON messages (seq);
CREATE TABLE IF NOT EXISTS contacts (jid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', notify TEXT NOT NULL DEFAULT '', verified TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS lids (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sends (at INTEGER NOT NULL, chat TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', fresh INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/** A new message the store took in: what a wait_for_message looks at. */
export type Listener = (m: Msg) => void;

export class Store {
  readonly db: Database;
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  /** The user's own jids (phone and lid): their messages are `from_me` wherever they show up. */
  me = "";
  meLid = "";

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    this.seq = (this.db.query("SELECT MAX(seq) AS s FROM messages").get() as { s: number | null }).s ?? 0;
  }

  close(): void {
    this.db.close();
  }

  listen(f: Listener): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  getMeta(k: string): string | undefined {
    return (this.db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null)?.v;
  }

  setMeta(k: string, v: string): void {
    this.db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  /** The phone jid a lid stands for, when known. */
  pnOf(lid: string): string | undefined {
    return (this.db.query("SELECT pn FROM lids WHERE lid = ?").get(lid) as { pn: string } | null)?.pn;
  }

  lidOf(pn: string): string | undefined {
    return (this.db.query("SELECT lid FROM lids WHERE pn = ?").get(pn) as { lid: string } | null)?.lid;
  }

  /** A direct chat goes by the phone jid once it's known: messages filed under the lid move over. */
  learnLid(lid: string, pn: string): void {
    lid = normJid(lid);
    pn = normJid(pn);
    if (!isLid(lid) || !isPhone(pn) || this.pnOf(lid) === pn) return;
    this.db.transaction(() => {
      this.db.query("INSERT INTO lids (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn").run(lid, pn);
      this.db.query("UPDATE OR IGNORE messages SET chat = ? WHERE chat = ?").run(pn, lid);
      this.db.query("DELETE FROM messages WHERE chat = ?").run(lid);
      this.db.query("UPDATE messages SET sender = ? WHERE sender = ?").run(pn, lid);
      const old = this.db.query("SELECT * FROM chats WHERE jid = ?").get(lid) as Row | null;
      if (old) {
        this.db.query("INSERT INTO chats (jid, name, unread, last_ts, archived) VALUES (?, ?, ?, ?, ?) ON CONFLICT(jid) DO UPDATE SET name = CASE WHEN chats.name = '' THEN excluded.name ELSE chats.name END, unread = chats.unread + excluded.unread, last_ts = MAX(chats.last_ts, excluded.last_ts)").run(
          pn,
          old.name ?? "",
          old.unread ?? 0,
          old.last_ts ?? 0,
          old.archived ?? 0,
        );
        this.db.query("DELETE FROM chats WHERE jid = ?").run(lid);
      }
      const c = this.db.query("SELECT * FROM contacts WHERE jid = ?").get(lid) as Row | null;
      if (c) {
        this.contact(pn, { name: String(c.name ?? ""), notify: String(c.notify ?? ""), verified: String(c.verified ?? "") });
        this.db.query("DELETE FROM contacts WHERE jid = ?").run(lid);
      }
    })();
  }

  /** The jid a chat or person is filed under: a lid's phone jid when known. */
  canon(jid: string): string {
    const j = normJid(jid);
    if (isLid(j)) {
      if (this.meLid !== "" && j === this.meLid && this.me !== "") return this.me;
      return this.pnOf(j) ?? j;
    }
    return j;
  }

  contact(jid: string, c: { name?: string; notify?: string; verified?: string }): void {
    const j = this.canon(jid);
    if (skipped(j) || isGroup(j)) return;
    this.db
      .query(
        "INSERT INTO contacts (jid, name, notify, verified) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(jid) DO UPDATE SET name = CASE WHEN ?2 = '' THEN contacts.name ELSE ?2 END, notify = CASE WHEN ?3 = '' THEN contacts.notify ELSE ?3 END, verified = CASE WHEN ?4 = '' THEN contacts.verified ELSE ?4 END",
      )
      .run(j, c.name ?? "", c.notify ?? "", c.verified ?? "");
  }

  /** A chat as WhatsApp describes it (history sync, chats.upsert/update). */
  chat(raw: Raw): void {
    const id = str(raw.id);
    if (id === undefined) return;
    const pn = str(raw.pnJid);
    const lid = str(raw.lidJid);
    if (pn !== undefined && lid !== undefined) this.learnLid(lid, pn);
    else if (pn !== undefined && isLid(normJid(id))) this.learnLid(id, pn);
    else if (lid !== undefined && isPhone(normJid(id))) this.learnLid(lid, id);
    const j = this.canon(id);
    if (skipped(j)) return;
    this.db.query("INSERT INTO chats (jid) VALUES (?) ON CONFLICT(jid) DO NOTHING").run(j);
    const name = str(raw.name) ?? str(raw.subject);
    if (name !== undefined) this.db.query("UPDATE chats SET name = ? WHERE jid = ?").run(name, j);
    const unread = num(raw.unreadCount);
    if (unread !== undefined) this.db.query("UPDATE chats SET unread = ? WHERE jid = ?").run(Math.max(0, unread), j);
    if (raw.markedAsUnread === true) this.db.query("UPDATE chats SET unread = MAX(unread, 1) WHERE jid = ?").run(j);
    const ts = num(raw.conversationTimestamp) ?? num(raw.lastMessageRecvTimestamp);
    if (ts !== undefined) this.db.query("UPDATE chats SET last_ts = MAX(last_ts, ?) WHERE jid = ?").run(ts, j);
    if (typeof raw.archived === "boolean") this.db.query("UPDATE chats SET archived = ? WHERE jid = ?").run(raw.archived ? 1 : 0, j);
    for (const m of arr(raw.messages)) {
      const inner = obj(obj(m).message);
      if (inner.key !== undefined) this.message(inner, "history");
    }
  }

  dropChat(jid: string): void {
    const j = this.canon(jid);
    this.db.query("DELETE FROM chats WHERE jid = ?").run(j);
    this.db.query("DELETE FROM messages WHERE chat = ?").run(j);
  }

  groupName(jid: string, subject: string): void {
    const j = normJid(jid);
    if (!isGroup(j) || subject === "") return;
    this.db.query("INSERT INTO chats (jid, name) VALUES (?1, ?2) ON CONFLICT(jid) DO UPDATE SET name = ?2").run(j, subject);
  }

  /**
   * One message from the engine. `how`: "notify" is new (counts as unread, wakes waiters),
   * "append"/"history" is older or the user's own. Returns what was stored, if anything.
   */
  message(raw: Raw, how: "notify" | "append" | "history"): Msg | undefined {
    const key = keyOf(raw, this.me);
    if (key === undefined) return undefined;
    if (key.chatAlt !== undefined) {
      if (isLid(key.chat) && isPhone(key.chatAlt)) this.learnLid(key.chat, key.chatAlt);
      else if (isPhone(key.chat) && isLid(key.chatAlt)) this.learnLid(key.chatAlt, key.chat);
    }
    if (key.senderAlt !== undefined) {
      if (isLid(key.sender) && isPhone(key.senderAlt)) this.learnLid(key.sender, key.senderAlt);
      else if (isPhone(key.sender) && isLid(key.senderAlt)) this.learnLid(key.senderAlt, key.sender);
    }
    const chat = this.canon(key.chat);
    if (skipped(chat)) return undefined;
    const content = unwrap(raw.message);
    // Edits, deletions and reactions change another message.
    const proto = obj(content.protocolMessage);
    if (Object.keys(proto).length > 0) {
      const target = str(obj(proto.key).id);
      const t = proto.type;
      if (target !== undefined && (t === 0 || t === "REVOKE")) this.db.query("UPDATE messages SET deleted = 1 WHERE chat = ? AND id = ?").run(chat, target);
      if (target !== undefined && (t === 14 || t === "MESSAGE_EDIT")) {
        const p = parseContent(proto.editedMessage);
        if (p !== undefined) this.db.query("UPDATE messages SET text = ?, edited = 1 WHERE chat = ? AND id = ?").run(p.text, chat, target);
      }
      return undefined;
    }
    const reaction = obj(content.reactionMessage);
    if (Object.keys(reaction).length > 0) {
      const target = str(obj(reaction.key).id);
      if (target !== undefined) this.react(chat, target, this.canon(key.sender), typeof reaction.text === "string" ? reaction.text : "");
      return undefined;
    }
    const p = parseContent(raw.message);
    if (p === undefined) return undefined;
    const ts = num(raw.messageTimestamp) ?? Math.floor(Date.now() / 1000);
    const sender = key.fromMe ? this.me : this.canon(key.sender);
    const push = str(raw.pushName) ?? "";
    if (!key.fromMe && push !== "" && !isGroup(sender)) this.contact(sender, { notify: push });
    const fresh = (this.db.query("SELECT 1 AS x FROM messages WHERE chat = ? AND id = ?").get(chat, key.id) as { x: number } | null) === null;
    this.seq++;
    this.db
      .query(
        `INSERT INTO messages (chat, id, from_me, sender, sender_name, ts, kind, text, media, quoted_id, quoted_text, raw, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat, id) DO UPDATE SET text = excluded.text, kind = excluded.kind, media = excluded.media, raw = excluded.raw, sender_name = CASE WHEN excluded.sender_name = '' THEN messages.sender_name ELSE excluded.sender_name END`,
      )
      .run(chat, key.id, key.fromMe ? 1 : 0, sender, push, ts, p.kind, p.text, p.media ? JSON.stringify(p.media) : null, p.quoted?.id ?? null, p.quoted?.text ?? null, JSON.stringify(raw), this.seq);
    this.db.query("INSERT INTO chats (jid, last_ts) VALUES (?1, ?2) ON CONFLICT(jid) DO UPDATE SET last_ts = MAX(chats.last_ts, ?2)").run(chat, ts);
    if (isGroup(chat) === false && !key.fromMe && push !== "") this.db.query("UPDATE chats SET name = ? WHERE jid = ? AND name = ''").run(push, chat);
    const m = this.get(chat, key.id);
    if (how === "notify" && fresh && m !== undefined) {
      if (!key.fromMe) this.db.query("UPDATE chats SET unread = unread + 1 WHERE jid = ?").run(chat);
      for (const f of [...this.listeners]) f(m);
    }
    return m;
  }

  private react(chat: string, id: string, who: string, emoji: string): void {
    const row = this.db.query("SELECT reactions FROM messages WHERE chat = ? AND id = ?").get(chat, id) as { reactions: string | null } | null;
    if (row === null) return;
    const r = obj(row.reactions === null ? {} : JSON.parse(row.reactions)) as Record<string, string>;
    if (emoji === "") delete r[who];
    else r[who] = emoji;
    this.db.query("UPDATE messages SET reactions = ? WHERE chat = ? AND id = ?").run(JSON.stringify(r), chat, id);
  }

  /** messages.update: an edit or a deletion that came as an update. */
  update(u: Raw): void {
    const key = keyOf({ key: u.key }, this.me);
    if (key === undefined) return;
    const chat = this.canon(key.chat);
    const up = obj(u.update);
    if (up.message !== undefined && up.message !== null) {
      const inner = unwrap(up.message);
      const p = parseContent(Object.keys(obj(inner.protocolMessage)).length > 0 ? obj(inner.protocolMessage).editedMessage : up.message);
      if (p !== undefined) this.db.query("UPDATE messages SET text = ?, edited = 1 WHERE chat = ? AND id = ?").run(p.text, chat, key.id);
    }
    if (up.messageStubType === 1 || up.messageStubType === "REVOKE") this.db.query("UPDATE messages SET deleted = 1 WHERE chat = ? AND id = ?").run(chat, key.id);
  }

  private row(r: Row): Msg {
    return {
      chat: String(r.chat),
      id: String(r.id),
      from_me: r.from_me === 1,
      sender: String(r.sender),
      sender_name: String(r.sender_name ?? ""),
      ts: Number(r.ts),
      kind: String(r.kind),
      text: String(r.text ?? ""),
      media: typeof r.media === "string" ? (JSON.parse(r.media) as Media) : null,
      quoted_id: typeof r.quoted_id === "string" ? r.quoted_id : null,
      quoted_text: typeof r.quoted_text === "string" ? r.quoted_text : null,
      deleted: r.deleted === 1,
      edited: r.edited === 1,
      reactions: typeof r.reactions === "string" ? (JSON.parse(r.reactions) as Record<string, string>) : {},
    };
  }

  get(chat: string, id: string): Msg | undefined {
    const r = this.db.query("SELECT * FROM messages WHERE chat = ? AND id = ?").get(this.canon(chat), id) as Row | null;
    return r === null ? undefined : this.row(r);
  }

  /** A message by id alone (ids are unique enough across chats). */
  find(id: string, chat?: string): Msg | undefined {
    if (chat !== undefined) return this.get(chat, id);
    const r = this.db.query("SELECT * FROM messages WHERE id = ? ORDER BY ts DESC LIMIT 1").get(id) as Row | null;
    return r === null ? undefined : this.row(r);
  }

  raw(chat: string, id: string): Raw | undefined {
    const r = this.db.query("SELECT raw FROM messages WHERE chat = ? AND id = ?").get(this.canon(chat), id) as { raw: string } | null;
    return r === null ? undefined : obj(JSON.parse(r.raw));
  }

  /** The newest `limit` messages before `before` (a message's ts and id), oldest first. */
  history(chat: string, limit: number, before?: { ts: number; id: string }): Msg[] {
    const c = this.canon(chat);
    const rows = (
      before === undefined
        ? this.db.query("SELECT * FROM messages WHERE chat = ? ORDER BY ts DESC, seq DESC LIMIT ?").all(c, limit)
        : this.db.query("SELECT * FROM messages WHERE chat = ? AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, seq DESC LIMIT ?").all(c, before.ts, before.ts, before.id, limit)
    ) as Row[];
    return rows.map((r) => this.row(r)).reverse();
  }

  oldest(chat: string): Msg | undefined {
    const r = this.db.query("SELECT * FROM messages WHERE chat = ? ORDER BY ts ASC LIMIT 1").get(this.canon(chat)) as Row | null;
    return r === null ? undefined : this.row(r);
  }

  /** Messages whose text has every word of `query`, newest first. */
  search(o: { query: string; chat?: string; from?: string; after?: number; before?: number; limit: number }): Msg[] {
    const where: string[] = ["deleted = 0"];
    const args: (string | number)[] = [];
    for (const w of o.query.toLowerCase().split(/\s+/).filter((x) => x !== "")) {
      where.push("(lower(text) LIKE ? ESCAPE '\\' OR lower(COALESCE(json_extract(media, '$.file_name'), '')) LIKE ? ESCAPE '\\')");
      const like = `%${w.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
      args.push(like, like);
    }
    if (o.chat !== undefined) {
      where.push("chat = ?");
      args.push(this.canon(o.chat));
    }
    if (o.from !== undefined) {
      where.push("sender = ?");
      args.push(this.canon(o.from));
    }
    if (o.after !== undefined) {
      where.push("ts >= ?");
      args.push(o.after);
    }
    if (o.before !== undefined) {
      where.push("ts < ?");
      args.push(o.before);
    }
    args.push(o.limit);
    return (this.db.query(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`).all(...args) as Row[]).map((r) => this.row(r));
  }

  /** New messages since `seq` (what a wait looks back at). */
  since(seq: number): Msg[] {
    return (this.db.query("SELECT * FROM messages WHERE seq > ? ORDER BY seq").all(seq) as Row[]).map((r) => this.row(r));
  }

  seqOf(chat: string, id: string): number | undefined {
    return (this.db.query("SELECT seq FROM messages WHERE chat = ? AND id = ?").get(this.canon(chat), id) as { seq: number } | null)?.seq;
  }

  lastSeq(): number {
    return this.seq;
  }

  chats(o: { query?: string; unreadOnly?: boolean; archived?: boolean; limit: number; offset?: number }): Chat[] {
    const rows = this.db.query("SELECT * FROM chats WHERE last_ts > 0 OR unread > 0 OR name != '' ORDER BY last_ts DESC").all() as Row[];
    const q = o.query?.trim().toLowerCase() ?? "";
    const qd = q.replace(/\D/g, "");
    const out: Chat[] = [];
    for (const r of rows) {
      const c: Chat = { jid: String(r.jid), name: this.nameOf(String(r.jid)), unread: Number(r.unread), last_ts: Number(r.last_ts), archived: r.archived === 1, group: isGroup(String(r.jid)) };
      if (o.unreadOnly === true && c.unread === 0) continue;
      if (o.archived !== true && c.archived && q === "") continue;
      if (q !== "" && !c.name.toLowerCase().includes(q) && !(qd.length >= 4 && c.jid.includes(qd)) && c.jid !== q) continue;
      out.push(c);
    }
    return out.slice(o.offset ?? 0, (o.offset ?? 0) + o.limit);
  }

  chatRow(jid: string): Chat | undefined {
    const j = this.canon(jid);
    const r = this.db.query("SELECT * FROM chats WHERE jid = ?").get(j) as Row | null;
    return r === null ? undefined : { jid: j, name: this.nameOf(j), unread: Number(r.unread), last_ts: Number(r.last_ts), archived: r.archived === 1, group: isGroup(j) };
  }

  setUnread(jid: string, n: number): void {
    this.db.query("UPDATE chats SET unread = ? WHERE jid = ?").run(n, this.canon(jid));
  }

  /** Incoming messages since the user's own last one, newest last: what a read receipt covers. */
  unreadIncoming(jid: string, n: number): Msg[] {
    const c = this.canon(jid);
    const rows = this.db.query("SELECT * FROM messages WHERE chat = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?").all(c, Math.max(1, Math.min(n, 100))) as Row[];
    return rows.map((r) => this.row(r)).reverse();
  }

  /** How people see `jid`: their saved name, their business name, the name they gave, the chat's name, their number. */
  nameOf(jid: string): string {
    const j = this.canon(jid);
    if (j === this.me && j !== "") return "You";
    const c = this.db.query("SELECT name, notify, verified FROM contacts WHERE jid = ?").get(j) as Row | null;
    const chat = this.db.query("SELECT name FROM chats WHERE jid = ?").get(j) as Row | null;
    const pick = [c?.name, c?.verified, isGroup(j) ? chat?.name : undefined, c?.notify, chat?.name].find((x) => typeof x === "string" && x !== "");
    return typeof pick === "string" ? pick : (phoneOf(j) ?? j.slice(0, j.indexOf("@")));
  }

  contacts(query: string, limit: number): Contact[] {
    const q = query.trim().toLowerCase();
    const qd = q.replace(/\D/g, "");
    const seen = new Set<string>();
    const out: Contact[] = [];
    const rows = this.db.query("SELECT c.jid, c.name, c.notify, c.verified, COALESCE(h.last_ts, 0) AS last FROM contacts c LEFT JOIN chats h ON h.jid = c.jid ORDER BY last DESC").all() as Row[];
    const chats = this.db.query("SELECT jid, name, last_ts AS last FROM chats ORDER BY last_ts DESC").all() as Row[];
    for (const r of [...rows, ...chats]) {
      const jid = String(r.jid);
      if (seen.has(jid) || skipped(jid)) continue;
      const names = [r.name, r.notify, r.verified].filter((x): x is string => typeof x === "string" && x !== "");
      const hit = q === "" || names.some((n) => n.toLowerCase().includes(q)) || (qd.length >= 4 && jid.includes(qd));
      if (!hit) continue;
      seen.add(jid);
      out.push({ jid, name: this.nameOf(jid), notify: typeof r.notify === "string" ? r.notify : "", phone: phoneOf(jid) ?? "" });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Whether the user has written with `jid` before, or has them saved: a chat an agent may write to. */
  known(jid: string): boolean {
    const j = this.canon(jid);
    if ((this.db.query("SELECT 1 AS x FROM messages WHERE chat = ? LIMIT 1").get(j) as { x: number } | null) !== null) return true;
    const c = this.db.query("SELECT name FROM contacts WHERE jid = ?").get(j) as { name: string } | null;
    return c !== null && c.name !== "";
  }

  counts(): { chats: number; messages: number; contacts: number } {
    const n = (sql: string): number => (this.db.query(sql).get() as { n: number }).n;
    return { chats: n("SELECT COUNT(*) AS n FROM chats"), messages: n("SELECT COUNT(*) AS n FROM messages"), contacts: n("SELECT COUNT(*) AS n FROM contacts") };
  }

  /** Sends since `at` (seconds), for pacing. */
  sendsSince(at: number): { at: number; chat: string; text: string; fresh: boolean }[] {
    return (this.db.query("SELECT at, chat, text, fresh FROM sends WHERE at >= ? ORDER BY at").all(at) as Row[]).map((r) => ({ at: Number(r.at), chat: String(r.chat), text: String(r.text), fresh: r.fresh === 1 }));
  }

  noteSend(at: number, chat: string, text: string, fresh: boolean): void {
    this.db.query("INSERT INTO sends (at, chat, text, fresh) VALUES (?, ?, ?, ?)").run(at, this.canon(chat), text, fresh ? 1 : 0);
    this.db.query("DELETE FROM sends WHERE at < ?").run(at - 2 * 86400);
  }
}
