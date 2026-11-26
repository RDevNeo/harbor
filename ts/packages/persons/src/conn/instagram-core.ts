// Instagram direct messages, the pure parts: the session as Instagram's Android app sends it (as Collector's Instagram
// source does, ts/tabs/collector/lib/instagram.ts), and the app API's inbox / thread / user JSON turned into Persons'
// messages and users. No I/O here (instagram.ts does it), so it is unit tested.
import type { Attachment, ChannelUser, Message, ReplyRef } from "../model/types.ts";

export const IG_API = "https://i.instagram.com/api/v1";
export const IG_APP_ID = "567067343352427";
export const IG_UA = "Instagram 361.0.0.46.88 Android (34/14; 420dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; en_US; 674675155)";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);

/** One cookie's value from a pasted cookie string ("sessionid=…; ds_user_id=…"). */
export function cookieValue(cookie: string, name: string): string | null {
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** A pasted session cleaned up: "Cookie: " dropped, a bare sessionid accepted. Null when it has no sessionid. */
export function normCookie(raw: string): string | null {
  const c = raw.trim().replace(/^cookie:\s*/i, "");
  const parts = c.includes("=") ? c : `sessionid=${c}`;
  return /(^|;\s*)sessionid=[^;]{10,}/.test(parts) ? parts : null;
}

/** The session as the app sends it: `Bearer IGT:2:` + base64 of {ds_user_id, sessionid}, and the account's id. */
export function igAuth(cookie: string): { bearer: string; userId: string } | null {
  const raw = cookieValue(cookie, "sessionid");
  if (!raw) return null;
  let sessionid = raw;
  try {
    sessionid = decodeURIComponent(raw);
  } catch {
    // as given
  }
  const userId = cookieValue(cookie, "ds_user_id") ?? sessionid.match(/^(\d+):/)?.[1] ?? null;
  if (!userId || !/^\d+$/.test(userId)) return null;
  return { bearer: `Bearer IGT:2:${btoa(JSON.stringify({ ds_user_id: userId, sessionid }))}`, userId };
}

export function igHeaders(cookie: string, deviceId: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": IG_UA,
    Accept: "*/*",
    "Accept-Language": "en-US",
    "X-IG-App-ID": IG_APP_ID,
    "X-IG-App-Locale": "en_US",
    "X-IG-Device-Locale": "en_US",
    "X-IG-Capabilities": "3brTv10=",
    "X-IG-Connection-Type": "WIFI",
    "X-IG-Device-ID": deviceId,
    "X-FB-HTTP-Engine": "Liger",
  };
  const a = igAuth(cookie);
  if (a) {
    h.Authorization = a.bearer;
    h["IG-U-DS-USER-ID"] = a.userId;
  }
  const mid = cookieValue(cookie, "mid");
  if (mid) h["X-MID"] = mid;
  return { ...h, ...extra };
}

/** Whether an answer means the session is gone (sign in again), not just a refusal for now. */
export function signedOut(status: number, body: unknown): boolean {
  const b = obj(body);
  return status === 401 || b.message === "login_required" || b.logout_reason !== undefined || (status === 403 && b.require_login === true);
}

/** A user of the app API (users/…/info, usernameinfo, a thread's users) as Persons' channel user. */
export function igUser(u: unknown): ChannelUser | null {
  const x = obj(u);
  const id = str(x.pk_id) || str(x.pk) || str(x.id);
  const username = str(x.username);
  if (!/^\d+$/.test(id) || !username) return null;
  return { id, username, globalName: str(x.full_name) || null, avatar: null, avatarUrl: str(x.profile_pic_url) };
}

/** An item's time: the API's microseconds since the epoch. */
export function itemTime(ts: unknown): string {
  const n = num(ts);
  if (!n) return new Date(0).toISOString();
  const ms = n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000;
  return new Date(Math.floor(ms)).toISOString();
}

const best = (cands: unknown): Obj | null => {
  const list = arr(cands).map(obj).filter((c) => str(c.url));
  return list.sort((a, b) => (num(b.width) ?? 0) - (num(a.width) ?? 0))[0] ?? null;
};

/** The pictures, videos and voice of an item's media. */
function mediaFiles(m: Obj, voice: boolean): Attachment[] {
  const out: Attachment[] = [];
  const audio = obj(m.audio);
  if (voice || str(audio.audio_src)) {
    const src = str(audio.audio_src);
    if (src) {
      const a: Attachment = { name: "voice.m4a", url: src, type: "audio/mp4" };
      const d = num(audio.duration) ?? (num(audio.audio_src_duration_ms) !== undefined ? num(audio.audio_src_duration_ms)! / 1000 : undefined);
      if (d) a.duration = d > 1000 ? d / 1000 : d;
      out.push(a);
    }
    return out;
  }
  const video = best(m.video_versions);
  if (video) {
    const a: Attachment = { name: "video.mp4", url: str(video.url), type: "video/mp4" };
    if (num(video.width)) a.width = num(video.width)!;
    if (num(video.height)) a.height = num(video.height)!;
    out.push(a);
    return out;
  }
  const img = best(obj(m.image_versions2).candidates);
  if (img) {
    const a: Attachment = { name: "photo.jpg", url: str(img.url), type: "image/jpeg" };
    if (num(img.width)) a.width = num(img.width)!;
    if (num(img.height)) a.height = num(img.height)!;
    out.push(a);
  }
  for (const c of arr(m.carousel_media)) out.push(...mediaFiles(obj(c), false));
  return out;
}

const shareText = (what: string, m: Obj): string => {
  const user = str(obj(m.user).username);
  const code = str(m.code);
  const cap = str(obj(m.caption).text);
  const link = code ? `https://www.instagram.com/${what === "reel" ? "reel" : "p"}/${code}/` : "";
  return [`[${what}${user ? ` by @${user}` : ""}]`, cap.slice(0, 200), link].filter(Boolean).join("\n");
};

/** What an item says and carries, by its type (text, a link, a like, a photo, a voice message, a shared post…). */
export function itemBody(it: Obj): { content: string; attachments: Attachment[]; voice: boolean; embed: boolean } {
  const type = str(it.item_type);
  const none = { attachments: [] as Attachment[], voice: false, embed: false };
  switch (type) {
    case "text":
      return { ...none, content: str(it.text) };
    case "link":
      return { ...none, content: str(obj(it.link).text) || str(obj(obj(it.link).link_context).link_url), embed: true };
    case "like":
      return { ...none, content: str(it.like) || "❤️" };
    case "media":
      return { ...none, content: "", attachments: mediaFiles(obj(it.media), false) };
    case "voice_media":
      return { ...none, content: "", attachments: mediaFiles(obj(obj(it.voice_media).media), true), voice: true };
    case "animated_media":
      return { ...none, content: "", attachments: [{ name: "gif.gif", url: str(obj(obj(obj(it.animated_media).images).fixed_height).url), type: "image/gif" }].filter((a) => a.url) };
    case "raven_media":
    case "visual_media": {
      const vm = obj(it.visual_media ?? it.raven_media);
      const files = mediaFiles(obj(vm.media ?? vm), false);
      return { ...none, content: files.length ? "" : "[a photo or video that disappears]", attachments: files };
    }
    case "media_share":
      return { ...none, content: shareText("post", obj(it.media_share)), embed: true };
    case "clip":
      return { ...none, content: shareText("reel", obj(obj(it.clip).clip)), embed: true };
    case "story_share": {
      const s = obj(it.story_share);
      return { ...none, content: str(s.message) || (isObj(s.media) ? shareText("story", obj(s.media)) : "[a story that is no longer available]"), embed: true };
    }
    case "reel_share": {
      const r = obj(it.reel_share);
      return { ...none, content: [str(r.text), r.type === "reaction" ? "(reacted to your story)" : "(replied to a story)"].filter(Boolean).join(" ") };
    }
    case "profile":
      return { ...none, content: `[profile @${str(obj(it.profile).username)}]`, embed: true };
    case "action_log":
      return { ...none, content: str(obj(it.action_log).description) };
    case "placeholder":
      return { ...none, content: str(obj(it.placeholder).message) || "[a message Instagram doesn't show here]" };
    default: {
      // xma_* (shared links, reels, posts in the newer shape) and whatever comes next: their title, else the type
      const x = obj(arr(it[type])[0] ?? it[type]);
      const t = [str(x.title_text) || str(x.header_title_text), str(x.target_url)].filter(Boolean).join("\n");
      return { ...none, content: t || str(it.text) || `[${type.replace(/_/g, " ") || "message"}]`, embed: !!t };
    }
  }
}

/** One thread item as a Persons message (`me` = the account's own user id). Null for items with nothing to show. */
export function itemMessage(it: unknown, threadId: string, me: string): Message | null {
  const x = obj(it);
  const id = str(x.item_id);
  if (!id) return null;
  const author = str(x.user_id);
  const body = itemBody(x);
  if (!body.content && !body.attachments.length) return null;
  const m: Message = { id, channelId: threadId, authorId: author, fromMe: !!me && author === me, content: body.content, timestamp: itemTime(x.timestamp) };
  if (body.attachments.length) m.attachments = body.attachments;
  if (body.voice) m.voice = true;
  if (body.embed) m.embed = true;
  const rep = obj(x.replied_to_message);
  if (str(rep.item_id)) {
    const rb = itemBody(rep);
    const r: ReplyRef = { id: str(rep.item_id), authorId: str(rep.user_id), fromMe: !!me && str(rep.user_id) === me, content: rb.content };
    if (rb.attachments.length) r.attachments = rb.attachments.length;
    m.reply = r;
  }
  if (x.is_sent_by_viewer === true) m.fromMe = true;
  return m;
}

export interface IgThread {
  id: string;
  /** The other person's user id (one-to-one threads only; groups are left out). */
  peer: string;
  user: ChannelUser | null;
  messages: Message[];
  /** For the page before the oldest message read. */
  oldestCursor: string | null;
  hasOlder: boolean;
  /** When the other person last saw the thread (their read mark), ISO. */
  peerSeenAt: string | null;
}

/** A thread of the inbox or of threads/{id}: its id, the person, the messages oldest first. Null for groups. */
export function igThread(t: unknown, me: string): IgThread | null {
  const x = obj(t);
  const id = str(x.thread_id);
  const users = arr(x.users).map(igUser).filter((u): u is ChannelUser => !!u && u.id !== me);
  if (!id || x.is_group === true || users.length !== 1) return null;
  const user = users[0]!;
  const messages = arr(x.items).map((i) => itemMessage(i, id, me)).filter((m): m is Message => !!m).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const seen = obj(obj(x.last_seen_at)[user.id]);
  return {
    id,
    peer: user.id,
    user,
    messages,
    oldestCursor: str(x.oldest_cursor) || null,
    hasOlder: x.has_older === true,
    peerSeenAt: seen.timestamp ? itemTime(seen.timestamp) : null,
  };
}

/** The inbox's one-to-one threads, and the cursor of the next (older) page. */
export function igInbox(body: unknown, me: string): { threads: IgThread[]; viewer: string | null } {
  const b = obj(body);
  const inbox = obj(b.inbox);
  const viewer = str(obj(b.viewer).pk) || null;
  return { threads: arr(inbox.threads).map((t) => igThread(t, me || viewer || "")).filter((t): t is IgThread => !!t), viewer };
}

/** Own messages the other person has seen get read ticks (WhatsApp's way: delivered, then read). */
export function withTicks(messages: Message[], peerSeenAt: string | null): Message[] {
  return messages.map((m) => (m.fromMe ? { ...m, status: peerSeenAt && m.timestamp <= peerSeenAt ? "read" : "sent" } : m));
}
