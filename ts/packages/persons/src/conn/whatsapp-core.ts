// Pure helpers for the WhatsApp connection (ported from Person Hub's shell/whatsapp-core.cjs, itself
// after Hub's mcp/src/whatsappstore.ts): jids, unwrapping, what a message says and carries, the chat
// shape the Persons tab shows, ticks, presence, the profile photo cache, pacing and upload checks.
import type { Attachment, Message, MessageStatus, OutgoingFile } from "../model/types.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
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
export const skipped = (jid: string): boolean => jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "";

/** A phone number as the app keeps it: digits only, with the country code (8–15 digits). */
export function normPhone(s: unknown): string {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : "";
}

/**
 * What someone typed as a WhatsApp number, normalized: digits with the country code. Brazilian
 * numbers typed without it (DDD + 8/9 digits) get 55; mobiles get their 9th digit
 * (55 DDD 9XXXX-XXXX), the form people write. '' when it isn't a number.
 */
export function normWhatsApp(s: unknown): string {
  const raw = String(s ?? "").trim();
  let d = raw.replace(/\D/g, "");
  if (!raw.startsWith("+") && d.startsWith("0")) d = d.replace(/^0+/, ""); // 0 + DDD, or 00 + country
  if (!raw.startsWith("+") && /^[1-9][1-9](?:9\d{8}|[2-9]\d{7})$/.test(d)) d = `55${d}`;
  if (/^55[1-9][1-9][6-9]\d{7}$/.test(d)) d = `${d.slice(0, 4)}9${d.slice(4)}`; // a mobile without its 9th digit
  return normPhone(d);
}

/**
 * The forms a number may have on WhatsApp: Brazilian mobiles from before the 9th digit are often
 * still registered without it (55 DDD XXXX-XXXX), so both are asked.
 */
export function phoneVariants(digits: string): string[] {
  const d = normPhone(digits);
  if (!d) return [];
  const m = /^55([1-9][1-9])9(\d{8})$/.exec(d);
  return m && /^[6-9]/.test(m[2] ?? "") ? [d, `55${m[1]}${m[2]}`] : [d];
}

export const jidOfPhone = (digits: string): string => `${digits}@s.whatsapp.net`;
export const digitsOf = (jid: string): string => (isPhone(jid) ? jid.slice(0, jid.indexOf("@")) : "");

const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage", "editedMessage", "deviceSentMessage", "botInvokeMessage", "groupMentionedMessage"];
const NOT_CONTENT = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);

/** The message inside its wrappers (disappearing, view once, sent from the user's phone…). */
export function unwrap(m: unknown): Json {
  let c = obj(m);
  for (let i = 0; i < 6; i++) {
    const w = WRAPPERS.find((k) => c[k] !== undefined && obj(c[k]).message !== undefined);
    if (w === undefined) break;
    c = obj(obj(c[w]).message);
  }
  return c;
}
const contentType = (c: Json): string | undefined => Object.keys(c).find((k) => !NOT_CONTENT.has(k) && c[k] !== null && c[k] !== undefined);

export interface Media {
  type: string;
  mimetype?: string;
  file_name?: string;
  size?: number;
  seconds?: number;
  width?: number;
  height?: number;
}

function media(type: string, m: Json): Media {
  const v: Media = { type };
  const mt = str(m.mimetype);
  if (mt !== undefined) v.mimetype = mt;
  const fn = str(m.fileName);
  if (fn !== undefined) v.file_name = fn;
  const size = num(m.fileLength);
  if (size !== undefined) v.size = size;
  const secs = num(m.seconds);
  if (secs !== undefined) v.seconds = secs;
  // a picture's or a video's size: its tile in the chat keeps the ratio before it's downloaded
  const w = num(m.width);
  const h = num(m.height);
  if (w && h) {
    v.width = w;
    v.height = h;
  }
  return v;
}

export interface Parsed {
  kind: string;
  text: string;
  media?: Media;
  quoted?: { id: string; text: string };
}

/** A file's extension for a mimetype's subtype when they differ (video/quicktime is a .mov). */
const EXT_OF: Record<string, string> = { jpeg: "jpg", quicktime: "mov", "3gpp": "3gp", "x-matroska": "mkv", "x-m4v": "m4v" };

/** What a message says and carries (Hub's parseContent). Undefined: nothing a person would read. */
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
    if (med) p.media = med;
    if (quoted) p.quoted = quoted;
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
      return out("video", str(m.caption) ?? "", media("video", m));
    case "ptvMessage":
      return out("video", "", media("video", m));
    case "audioMessage":
      return out(m.ptt === true ? "voice" : "audio", "", media(m.ptt === true ? "voice" : "audio", m));
    case "documentMessage":
      return out("document", str(m.caption) ?? "", media("document", m));
    case "stickerMessage":
      return out("sticker", "", media("sticker", m));
    case "locationMessage":
    case "liveLocationMessage": {
      const where = [str(m.name), str(m.address)].filter((x) => x !== undefined).join(", ");
      return out("location", `📍 ${where || `${num(m.degreesLatitude) ?? "?"},${num(m.degreesLongitude) ?? "?"}`}`);
    }
    case "contactMessage":
      return out("contact", `👤 ${str(m.displayName) ?? "contact"}`);
    case "contactsArrayMessage":
      return out("contact", `👤 ${arr(m.contacts)
        .map((x) => str(obj(x).displayName) ?? "?")
        .join(", ")}`);
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3":
      return out("poll", `📊 ${str(m.name) ?? ""}`);
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

/** The raw voice waveform (bytes or {$b}) as base64, like Discord's. */
export function waveformB64(w: unknown): string | undefined {
  if (!w) return undefined;
  if (typeof w === "object" && typeof (w as Json).$b === "string") return (w as Json).$b as string;
  if (w instanceof Uint8Array) return Buffer.from(w).toString("base64");
  if (typeof w === "string") return w;
  return undefined;
}

/** The chwa://<connection>/<message id>?name=&type= URL of a message's media: what fetchAttachment takes back. */
export const mediaUrl = (connId: string, msgId: string, name: string, type: string): string =>
  `chwa://${encodeURIComponent(connId)}/${encodeURIComponent(msgId)}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;

/** A chwa:// URL → the message id and the file's name (checked). */
export function parseMediaUrl(url: string): { msgId: string; name: string; type: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Not a WhatsApp attachment");
  }
  if (u.protocol !== "chwa:") throw new Error("Not a WhatsApp attachment");
  const msgId = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  if (!/^[\w-]{1,128}$/.test(msgId)) throw new Error("Not a WhatsApp attachment");
  return { msgId, name: u.searchParams.get("name") || "file", type: u.searchParams.get("type") || "" };
}

/**
 * A Baileys message (as the engine hands it over, bytes as {$b}) → the chat shape the app uses.
 * `chat` is the direct chat's phone jid (lids resolved by the caller). Media gets a chwa:// URL.
 */
export function slimWa(rawv: unknown, chat: string, connId: string): Message | undefined {
  const raw = obj(rawv);
  const k = obj(raw.key);
  const id = str(k.id);
  const p = parseContent(raw.message);
  if (!id || !p) return undefined;
  const ts = num(raw.messageTimestamp);
  const out: Message = {
    id,
    channelId: chat,
    authorId: k.fromMe ? "me" : chat,
    fromMe: k.fromMe === true,
    content: p.text,
    timestamp: new Date((ts ?? 0) * 1000).toISOString(),
  };
  if (p.kind === "voice") out.voice = true;
  const st = k.fromMe ? waStatus(raw.status) : undefined;
  if (st) out.status = st;
  if (p.media) {
    const c = unwrap(raw.message);
    const m = obj(c[contentType(c) ?? ""]);
    const ext = (p.media.mimetype ?? "").split("/")[1]?.split(";")[0] || "bin";
    const name = p.media.file_name ?? `${p.kind}-${id.slice(0, 6)}.${EXT_OF[ext] ?? ext}`;
    const a: Attachment = { name, type: p.media.mimetype ?? "application/octet-stream", url: mediaUrl(connId, id, name, p.media.mimetype ?? "") };
    if (p.media.size) a.size = p.media.size;
    if (p.media.seconds) a.duration = p.media.seconds;
    if (p.media.width && p.media.height) {
      a.width = p.media.width;
      a.height = p.media.height;
    }
    const wf = waveformB64(m.waveform);
    if (wf) a.waveform = wf;
    out.attachments = [a];
  }
  if (p.quoted) out.reply = { id: p.quoted.id, content: p.quoted.text };
  return out;
}

/** A file to send, as checkUploads leaves it. */
export interface Upload {
  name: string;
  type: string;
  data: Uint8Array;
  voice?: { duration: number; waveform: string };
}

/** What to send for a file (Baileys content), bytes as {$b} for the engine's reviver. */
export function contentFor(f: Upload, caption?: string): Json {
  const b = { $b: Buffer.from(f.data).toString("base64") };
  const t = String(f.type || "application/octet-stream");
  const cap = caption ? { caption } : {};
  if (f.voice) return { audio: b, ptt: true, mimetype: "audio/ogg; codecs=opus", seconds: Math.round(f.voice.duration), ...(f.voice.waveform ? { waveform: { $b: f.voice.waveform } } : {}) };
  if (t.startsWith("image/") && !t.includes("svg")) return { image: b, mimetype: t, ...cap };
  if (t.startsWith("video/")) return { video: b, mimetype: t, ...cap };
  if (t.startsWith("audio/")) return { audio: b, mimetype: t };
  return { document: b, mimetype: t, fileName: f.name, ...cap };
}

export interface PresenceRead {
  online: boolean;
  activity: "typing" | "recording" | null;
  lastSeen: number | undefined;
}

/**
 * A Baileys presence.update for a direct chat ({ id, presences: { [jid]: { lastKnownPresence,
 * lastSeen } } }): whether they're online, what they're doing (typing / recording / nothing) and
 * when they were last seen (ms; only when their privacy shows it). Null when it says nothing.
 */
export function parsePresence(data: unknown): PresenceRead | null {
  const all = Object.values(obj(obj(data).presences)).map(obj);
  const p = all.find((x) => str(x.lastKnownPresence));
  if (!p) return null;
  const st = p.lastKnownPresence;
  const secs = num(p.lastSeen);
  return {
    online: st !== "unavailable",
    activity: st === "composing" ? "typing" : st === "recording" ? "recording" : null,
    lastSeen: secs && secs > 0 ? (secs < 1e12 ? secs * 1000 : secs) : undefined,
  };
}

// ---------- message status (ticks on the user's own messages) ----------
// Baileys' WAMessageStatus: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED.
const STATUS_BY_NUM: MessageStatus[] = ["error", "pending", "sent", "delivered", "read", "read"];
const STATUS_BY_NAME: Record<string, MessageStatus> = { ERROR: "error", PENDING: "pending", SERVER_ACK: "sent", DELIVERY_ACK: "delivered", READ: "read", PLAYED: "read" };
const STATUS_RANK: Record<MessageStatus, number> = { error: 0, pending: 1, sent: 2, delivered: 3, read: 4 };
const isStatus = (s: unknown): s is MessageStatus => typeof s === "string" && s in STATUS_RANK;

/** A Baileys status (number, or its enum name in some history payloads) → 'pending' | 'sent' | 'delivered' | 'read' | 'error'; played counts as read. */
export function waStatus(v: unknown): MessageStatus | undefined {
  if (typeof v === "string" && STATUS_BY_NAME[v]) return STATUS_BY_NAME[v];
  const n = num(v);
  return n !== undefined ? STATUS_BY_NUM[n] : undefined;
}

/**
 * Status only moves forward (read never goes back to delivered). An error replaces only pending /
 * sent (a failed send); a later delivered / read receipt wins over an error (it got there).
 */
export function mergeStatus(prev: MessageStatus | undefined, next: MessageStatus | undefined): MessageStatus | undefined {
  if (!isStatus(next)) return prev;
  if (!isStatus(prev)) return next;
  if (next === "error") return prev === "pending" || prev === "sent" ? "error" : prev;
  if (prev === "error") return STATUS_RANK[next] >= STATUS_RANK.delivered ? next : prev;
  return STATUS_RANK[next] > STATUS_RANK[prev] ? next : prev;
}

/** Profile photos are asked of WhatsApp at most once a day per person (and size). */
export const PHOTO_TTL = 24 * 3600_000;

/**
 * What the disk cache says about someone's profile photo, from the mtimes (ms, or undefined) of the
 * photo file and of its "none" marker (hidden by their privacy, or no photo): the newer one wins
 * while it's younger than `ttl`. 'photo': serve the file; 'none': no photo; 'ask': ask WhatsApp.
 */
export function photoCache(fileMs: number | undefined, noneMs: number | undefined, now = Date.now(), ttl = PHOTO_TTL): "photo" | "none" | "ask" {
  const f = typeof fileMs === "number" ? fileMs : -Infinity;
  const n = typeof noneMs === "number" ? noneMs : -Infinity;
  const newest = Math.max(f, n);
  if (newest === -Infinity || now - newest >= ttl) return "ask";
  return n > f ? "none" : "photo";
}

// ---------- pacing and uploads ----------

/** Sends a few seconds apart, at a random gap (Person Hub's createPacer). */
export function createPacer({ minGap = 1800, maxGap = 4200, now = () => Date.now(), random = Math.random } = {}): { reserve(): number } {
  let next = 0;
  return {
    /** ms to wait before this send, and books the slot. */
    reserve() {
      const t = now();
      const wait = Math.max(0, next - t);
      next = t + wait + minGap + Math.round(random() * (maxGap - minGap));
      return wait;
    },
  };
}

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

export const MAX_FILES = 10;
/** Our cap per message (Person Hub's, the same as Discord's without Nitro). */
export const MAX_UPLOAD = 10 * 1024 * 1024;

/** Files for a message: names, types and sizes checked. */
export function checkUploads(files: readonly OutgoingFile[] | undefined): Upload[] {
  if (!files || files.length === 0) return [];
  if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files per message`);
  let total = 0;
  return files.map((f, i) => {
    const data = f?.data;
    if (!(data instanceof Uint8Array)) throw new Error("Invalid file");
    total += data.byteLength;
    if (data.byteLength === 0) throw new Error(`${safeFileName(f.name)} is empty`);
    if (total > MAX_UPLOAD) throw new Error("Files are over the 10 MB limit");
    const out: Upload = { name: safeFileName(f.name, `file-${i + 1}`), type: typeof f.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? f.type : "application/octet-stream", data };
    if (f.voice) {
      const duration = Number(f.voice.duration);
      const waveform = String(f.voice.waveform ?? "");
      if (!Number.isFinite(duration) || duration <= 0 || duration > 1200 || !/^[A-Za-z0-9+/=]{0,400}$/.test(waveform)) throw new Error("Invalid voice message");
      out.voice = { duration: Math.round(duration * 100) / 100, waveform };
    }
    return out;
  });
}
