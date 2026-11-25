// Creators' social profiles (person.socials) and their latest uploads and pictures, fetched by the
// engine itself (Person Hub asked its Vercel function api/socials.ts; this is that function plus
// Person Hub's src/lib/socials.ts). Ported from the SpokPay CRM's "Most Recent" podium, which reads
// the same public sources without an API key:
//   - YouTube: the channel's Atom feed (`/feeds/videos.xml?channel_id=UC…`, ~15 newest uploads with
//     views); a @handle, /user/ or /c/ URL is turned into its `UC…` id by reading the channel page,
//     which also has the channel's picture and name.
//   - TikTok: the public creator embed (`/embed/@handle`), which server-renders the latest uploads
//     (play counts; dates come from the item ids) and the profile (userInfo). It answers 503
//     "overload-protect" now and then, so it's retried.
//   - Instagram: nothing a logged-out reader can get: a link only.
// Only those fixed youtube.com / tiktok.com URLs are ever fetched. Reads are cached 3 hours (failed
// ones 10 minutes) in memory and in <dir>/socials-cache.json.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SocialPlatform = "youtube" | "tiktok" | "instagram";

export type SocialTarget =
  | { platform: "youtube"; kind: "channelId" | "handle" | "user" | "custom"; value: string; url: string }
  | { platform: "tiktok"; kind: "handle"; value: string; url: string }
  | { platform: "instagram"; kind: "handle"; value: string; url: string };

export const PLATFORM_LABEL: Record<SocialPlatform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };

export interface SocialVideo {
  id: string;
  title: string | null;
  url: string;
  thumbnail: string | null;
  /** ISO 8601. */
  publishedAt: string | null;
  /** null = unknown (not zero). */
  views: number | null;
  short?: boolean;
}

/** The profile itself: its picture (TikTok's is a signed URL that expires in days) and display name. */
export interface SocialProfile {
  avatar: string | null;
  name: string | null;
}

export const RECENT_LIMIT = 3;

// ---------- profile URLs (pure) ----------

// Instagram paths that are pages of the site, not accounts.
const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "explore", "stories", "accounts", "direct", "about", "legal", "developer", "web"]);
const enc = encodeURIComponent;

/**
 * Where a pasted profile link points (no scheme, `m.`/`www.` hosts, trailing slash, query string and
 * a TikTok video URL are all fine), with its canonical profile URL. null when it isn't a TikTok,
 * Instagram or YouTube profile.
 */
export function parseSocialUrl(raw: string): SocialTarget | null {
  const trimmed = String(raw ?? "")
    .trim()
    .replace(/^[<("']+|[>)"',]+$/g, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
  let parts: string[];
  try {
    parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((x) => decodeURIComponent(x));
  } catch {
    return null;
  }
  const [a, b] = parts;

  if (host === "youtube.com") {
    if (!a) return null;
    if (a.startsWith("@") && a.length > 1 && !/[\s/?#&]/.test(a)) return { platform: "youtube", kind: "handle", value: a.slice(1), url: `https://www.youtube.com/@${enc(a.slice(1))}` };
    if (a === "channel" && b && /^UC[\w-]{22}$/.test(b)) return { platform: "youtube", kind: "channelId", value: b, url: `https://www.youtube.com/channel/${b}` };
    if ((a === "user" || a === "c") && b && !/[\s/?#&]/.test(b)) return { platform: "youtube", kind: a === "user" ? "user" : "custom", value: b, url: `https://www.youtube.com/${a}/${enc(b)}` };
    return null;
  }
  if (host === "tiktok.com") {
    if (a?.startsWith("@") && /^@[\w.]{1,40}$/.test(a)) return { platform: "tiktok", kind: "handle", value: a.slice(1), url: `https://www.tiktok.com/@${a.slice(1)}` };
    return null;
  }
  if (host === "instagram.com" || host === "instagr.am") {
    if (!a || IG_RESERVED.has(a.toLowerCase()) || !/^[A-Za-z0-9._]{1,30}$/.test(a)) return null;
    const h = a.toLowerCase();
    return { platform: "instagram", kind: "handle", value: h, url: `https://www.instagram.com/${h}/` };
  }
  return null;
}

/** How a saved profile is labelled: @handle (or the channel id). */
export const socialHandle = (t: SocialTarget): string => (t.kind === "handle" ? `@${t.value}` : t.value);

/** Same profile? (case-insensitive except YouTube channel ids) */
export const socialKey = (t: SocialTarget): string => `${t.platform}|${t.kind}|${t.kind === "channelId" ? t.value : t.value.toLowerCase()}`;

/** A person's saved links, as data.json keeps them: profile URLs, canonical, unique, at most 12. */
export function normalizeSocials(v: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const t = typeof x === "string" ? parseSocialUrl(x) : null;
    if (!t || seen.has(socialKey(t))) continue;
    seen.add(socialKey(t));
    out.push(t.url);
  }
  return out.slice(0, 12);
}

/** "22K", "1.4M", "950". */
export function formatCount(n: number): string {
  const unit = (x: number, s: string): string => `${x >= 10 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, "")}${s}`;
  if (n >= 1e9) return unit(n / 1e9, "B");
  if (n >= 999_500) return unit(n / 1e6, "M");
  if (n >= 1000) return unit(n / 1000, "K");
  return String(n);
}

/** Compact age: "just now", "5h ago", "22d ago", "3mo ago", "1y ago"; null when unknown. */
export function formatAge(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const hours = Math.floor((now - at) / 3600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ---------- YouTube (pure) ----------

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

const first = (s: string, re: RegExp): string | null => s.match(re)?.[1] ?? null;

/** The newest uploads of a channel's Atom feed (only `<entry>` bodies: the feed's own `<published>` is the channel's creation). */
export function parseYoutubeFeed(xml: string, limit = RECENT_LIMIT): SocialVideo[] {
  const out: SocialVideo[] = [];
  for (const chunk of xml.split("<entry>").slice(1)) {
    const id = first(chunk, /<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!id) continue;
    const title = first(chunk, /<title>([\s\S]*?)<\/title>/);
    const href = first(chunk, /<link[^>]+rel="alternate"[^>]+href="([^"]+)"/);
    const views = first(chunk, /<media:statistics[^>]+views="(\d+)"/);
    out.push({
      id,
      title: title ? decodeXml(title).trim() || null : null,
      url: href ? decodeXml(href) : `https://www.youtube.com/watch?v=${id}`,
      thumbnail: first(chunk, /<media:thumbnail[^>]+url="([^"]+)"/),
      publishedAt: first(chunk, /<published>([^<]+)<\/published>/),
      views: views ? Number.parseInt(views, 10) : null,
      short: (href ?? "").includes("/shorts/"),
    });
  }
  out.sort((a, b) => (b.publishedAt ? Date.parse(b.publishedAt) : 0) - (a.publishedAt ? Date.parse(a.publishedAt) : 0));
  return out.slice(0, limit);
}

/** The `UC…` id a channel page declares for itself. */
export function youtubeChannelIdFromHtml(html: string): string | null {
  return (
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
    html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/)?.[1] ??
    null
  );
}

/** A channel page's picture (sized down to 240 px) and name: its avatar thumbnails, else og:image / og:title. */
export function youtubeProfileFromHtml(html: string): SocialProfile {
  const raw =
    html.match(/"avatar":\{"thumbnails":\[\{"url":"(https:\/\/[^"]+)"/)?.[1] ??
    html.match(/<meta property="og:image" content="(https:\/\/[^"]+)"/)?.[1] ??
    html.match(/<link itemprop="thumbnailUrl" href="(https:\/\/[^"]+)"/)?.[1];
  let avatar: string | null = null;
  if (raw) {
    const url = decodeXml(raw.replace(/\\u0026/g, "&"));
    // yt3.ggpht.com / yt3.googleusercontent.com take the size in the path: "=s900-c-k-…" → "=s240-c-k-…"
    avatar = /^https:\/\/yt\d?\.(ggpht|googleusercontent)\.com\//.test(url) ? url.replace(/=s\d+(-|$)/, "=s240$1") : url;
  }
  const name = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  return { avatar, name: name ? decodeXml(name).trim() || null : null };
}

// ---------- TikTok (pure) ----------

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const count = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A TikTok item id carries its creation time in its top 32 bits (Unix seconds). */
export function tiktokTimeFromId(id: string): string | null {
  try {
    const s = Number(BigInt(id) >> 32n);
    return s > 0 ? new Date(s * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export type TiktokRead = { ok: true; videos: SocialVideo[]; profile: SocialProfile } | { ok: false; reason: string; retry?: boolean };

/** A creator's newest uploads from the embed's `__FRONTITY_CONNECT_STATE__` (pinned videos come first there, so sort by id time). */
export function tiktokVideosFromEmbedHtml(html: string, handle: string, limit = RECENT_LIMIT): TiktokRead {
  const m = html.match(/<script[^>]+id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { ok: false, retry: true, reason: "TikTok did not return the creator embed." };
  let page: Record<string, unknown> | null;
  try {
    const data = (JSON.parse(m[1] ?? "")?.source?.data ?? {}) as Record<string, Record<string, unknown>>;
    const key = Object.keys(data).find((k) => k.startsWith("/embed/@"));
    page = key ? (data[key] ?? null) : null;
  } catch {
    return { ok: false, reason: "TikTok returned an unreadable creator embed." };
  }
  if (!page) return { ok: false, reason: "TikTok creator embed had no account data." };
  if (page.isError) return { ok: false, reason: "TikTok account is private or unavailable." };
  const user = (page.userInfo ?? {}) as Record<string, unknown>;
  const uniqueId = clean(user.uniqueId) ?? handle.replace(/^@/, "");
  const avatar =
    [user.avatarLarger, user.avatarMedium, user.avatarThumb, user.avatarLargerUrl, user.avatarMediumUrl, user.avatarThumbUrl].map(clean).find((u) => !!u && u.startsWith("https://")) ?? null;
  const profile: SocialProfile = { avatar, name: clean(user.nickname) };
  const videos: SocialVideo[] = [];
  for (const item of (Array.isArray(page.videoList) ? page.videoList : []) as Record<string, unknown>[]) {
    if (!item?.id || item.privateItem) continue;
    const id = String(item.id);
    videos.push({
      id,
      title: clean(item.desc),
      url: `https://www.tiktok.com/@${uniqueId}/video/${id}`,
      // the cover the creator chose; the first frame is often black
      thumbnail: clean(item.coverUrl) ?? clean(item.originCoverUrl),
      publishedAt: tiktokTimeFromId(id),
      views: count(item.playCount),
    });
  }
  videos.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return { ok: true, videos: videos.slice(0, limit), profile };
}

// ---------- fetching ----------

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9", Cookie: "SOCS=CAI; CONSENT=YES+1" };
const TIMEOUT = 12_000;
const NO_PROFILE: SocialProfile = { avatar: null, name: null };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface Read {
  videos: SocialVideo[];
  profile: SocialProfile;
}

async function page(http: Fetch, url: string): Promise<{ status: number; text: string }> {
  const res = await http(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) });
  return { status: res.status, text: await res.text() };
}

async function youtube(http: Fetch, kind: string, value: string): Promise<Read> {
  let channelId = kind === "channelId" ? value : null;
  let profile: SocialProfile | Promise<SocialProfile> = NO_PROFILE;
  if (!channelId) {
    const path = kind === "handle" ? `@${enc(value)}` : `${kind === "user" ? "user" : "c"}/${enc(value)}`;
    const { status, text } = await page(http, `https://www.youtube.com/${path}`);
    channelId = status === 200 ? youtubeChannelIdFromHtml(text) : null;
    if (!channelId) throw new Error(status === 404 ? "YouTube channel not found" : `YouTube channel page HTTP ${status}`);
    profile = youtubeProfileFromHtml(text);
  } else {
    // the feed has no picture: the channel page, alongside (best effort)
    profile = page(http, `https://www.youtube.com/channel/${enc(channelId)}`).then(
      ({ status, text }) => (status === 200 ? youtubeProfileFromHtml(text) : NO_PROFILE),
      () => NO_PROFILE,
    );
  }
  const { status, text } = await page(http, `https://www.youtube.com/feeds/videos.xml?channel_id=${enc(channelId)}`);
  if (status !== 200) throw new Error(`YouTube feed HTTP ${status}`);
  return { videos: parseYoutubeFeed(text), profile: await profile };
}

async function tiktok(http: Fetch, handle: string, wait: (ms: number) => Promise<void>): Promise<Read> {
  let last: TiktokRead = { ok: false, reason: "TikTok did not answer" };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(1200 * attempt);
    const { status, text } = await page(http, `https://www.tiktok.com/embed/@${enc(handle)}`);
    // 400 is the embed's own error page (private / removed): the parser says so
    if (status === 503 || status === 429) {
      last = { ok: false, retry: true, reason: `TikTok busy (HTTP ${status})` };
      continue;
    }
    if (status !== 200 && status !== 400) throw new Error(`TikTok embed HTTP ${status}`);
    last = tiktokVideosFromEmbedHtml(text, handle);
    if (last.ok || !last.retry) break;
  }
  if (!last.ok) throw new Error(last.reason);
  return { videos: last.videos, profile: last.profile };
}

export interface SocialUpload {
  title: string | null;
  url: string;
  thumb: string | null;
  /** ISO time, or null. */
  at: string | null;
  views: number | null;
}

/** One profile as the panel shows it. */
export interface SocialResult {
  platform: SocialPlatform;
  /** "@handle" (or the channel id). */
  handle: string;
  /** The canonical profile URL. */
  url: string;
  /** The profile's picture URL (https), or null. */
  photo: string | null;
  name: string | null;
  /** The newest (up to 3), newest first. */
  uploads: SocialUpload[];
  /** When it was read (ms). */
  at: number;
  /** The last read failed (uploads and photo are the ones read before, if any). */
  error?: string;
  /** Instagram: nothing to read without a login. */
  unsupported?: boolean;
}

/** Fresh reads are kept 3 hours, failed ones 10 minutes. */
export const FRESH_MS = 3 * 3600_000;
export const ERROR_MS = 10 * 60_000;
export const isFresh = (r: SocialResult | null | undefined, now = Date.now()): boolean => !!r && now - r.at < (r.error && !r.unsupported ? ERROR_MS : FRESH_MS);

const upload = (v: SocialVideo): SocialUpload => ({ title: v.title, url: v.url, thumb: v.thumbnail, at: v.publishedAt, views: v.views });

export interface SocialsOptions {
  /** Where socials-cache.json lives (the persons folder). */
  dir: string;
  fetch?: Fetch;
  now?: () => number;
  log?: (...a: unknown[]) => void;
  /** The pause between TikTok retries (tests: none). */
  wait?: (ms: number) => Promise<void>;
}

export interface Socials {
  /** A profile URL's latest uploads, picture and name (cached; `force` reads it again). Null when it isn't a profile URL. */
  fetchSocial(url: string, force?: boolean): Promise<SocialResult | null>;
  /** What the cache has for it, any age (null: never read). */
  cached(url: string): SocialResult | null;
  /** Writes the cache now (Hub quitting). */
  flush(): Promise<void>;
}

export function createSocials(o: SocialsOptions): Socials {
  const http: Fetch = o.fetch ?? ((u, i) => fetch(u, i));
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const FILE = join(o.dir, "socials-cache.json");
  const cache = new Map<string, SocialResult>();
  try {
    const j = JSON.parse(readFileSync(FILE, "utf8")) as { entries?: Record<string, SocialResult> };
    for (const [k, v] of Object.entries(j.entries ?? {})) if (v && typeof v.at === "number" && Array.isArray(v.uploads)) cache.set(k, v);
  } catch {
    // none yet
  }
  const inflight = new Map<string, Promise<SocialResult>>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  async function write(): Promise<void> {
    // a day's worth at most: older reads are dropped from the file
    const entries = Object.fromEntries([...cache].filter(([, v]) => now() - v.at < 24 * 3600_000));
    const tmp = `${FILE}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      await rename(tmp, FILE);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      log("socials: cache write failed", e instanceof Error ? e.message : String(e));
    }
  }
  const save = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void write();
    }, 1000);
    saveTimer.unref?.();
  };

  async function read(t: SocialTarget, prev: SocialResult | undefined): Promise<SocialResult> {
    const base = { platform: t.platform, handle: socialHandle(t), url: t.url };
    if (t.platform === "instagram") return { ...base, photo: null, name: null, uploads: [], at: now(), unsupported: true };
    try {
      const r = t.platform === "youtube" ? await youtube(http, t.kind, t.value) : await tiktok(http, t.value, wait);
      return { ...base, photo: r.profile.avatar, name: r.profile.name, uploads: r.videos.map(upload), at: now() };
    } catch (e) {
      const error = e instanceof Error ? (e.name === "TimeoutError" ? "Timed out" : e.message) : String(e);
      log(`socials: ${t.platform} read failed:`, error);
      return { ...base, photo: prev?.photo ?? null, name: prev?.name ?? null, uploads: prev?.uploads ?? [], at: now(), error };
    }
  }

  return {
    async fetchSocial(url, force = false) {
      const t = parseSocialUrl(url);
      if (!t) return null;
      const key = socialKey(t);
      const prev = cache.get(key);
      if (!force && prev && isFresh(prev, now())) return prev;
      let p = inflight.get(key);
      if (!p) {
        p = read(t, prev)
          .then((r) => {
            cache.set(key, r);
            save();
            return r;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return p;
    },
    cached(url) {
      const t = parseSocialUrl(url);
      return t ? (cache.get(socialKey(t)) ?? null) : null;
    },
    async flush() {
      if (saveTimer === undefined) return;
      clearTimeout(saveTimer);
      saveTimer = undefined;
      await write();
    },
  };
}
