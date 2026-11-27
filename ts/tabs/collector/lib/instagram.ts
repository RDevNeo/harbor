// Instagram, as the userscript reads it (lead-collector.user.js, "Instagram creator collection"), from Hub's engine.
// With a signed-in session (sessionid + ds_user_id from the browser's cookies) it talks to Instagram's app API on
// i.instagram.com the way the Android app does: the session as an `IGT:2` bearer token, the app's UA and app id.
// (The web app's JSON on www.instagram.com answers a non-browser client as if signed out: 302 / 404 / 429, even
// with every cookie, so it isn't used.) Profile = usernameinfo + the user's feed; discovery = the search page's
// TopSerpQuery (GraphQL: the reels and posts Instagram's search shows for the term as typed, paged), whose authors are
// the creators (reels first: a page's posts only when it has no reel). Without a session
// every JSON endpoint answers 404, so a profile is read the way link previews are: the page served to Facebook's
// crawler UA (og:title / og:description: rounded counts, a bio excerpt, the avatar and the profile id; no posts).
// Reads only; every call goes through one throttle (a gap between any two calls).
import { decodeXmlText, ytParseCount, type Fetch } from "./youtube.ts";
import type { RecentVideo } from "./types.ts";
import type { DiscoverOpts, Hit, Profile } from "./tiktok.ts";

export type { DiscoverOpts, Hit, Profile } from "./tiktok.ts";

export const IG_ORIGIN = "https://www.instagram.com";
export const IG_API = "https://i.instagram.com";
/** The Android app's app id and UA. */
export const IG_ANDROID_APP_ID = "567067343352427";
const IG_ANDROID_UA = "Instagram 361.0.0.46.88 Android (34/14; 420dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; pt_BR; 674675155)";
/** The search page's GraphQL query (Android app), as instagrapi sends it. */
export const IG_TOP_SERP_DOC = "418531681916451609839969517761";
export const IG_RECENT_LIMIT = 3;
/** Least time between two calls to Instagram from this PC (all clients share it). */
export const IG_GAP_MS = 2500;
/** After a 429: how long the search waits before asking once more. */
export const IG_BACKOFF_MS = 60_000;
const CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

type Obj = Record<string, unknown>;
const isObj = (n: unknown): n is Obj => !!n && typeof n === "object" && !Array.isArray(n);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
};
const idOf = (v: unknown): string | null => (typeof v === "number" ? String(v) : str(v));
const bare = (u: string): string => u.trim().replace(/^@/, "").replace(/\/+$/, "");

/** A link as Instagram hands it out: `l.instagram.com/?u=` unwrapped, `fbclid` dropped, scheme added. Null when not a URL. */
export function igCleanLink(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() === "l.instagram.com") {
    const target = u.searchParams.get("u");
    return target ? igCleanLink(target) : null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
  u.searchParams.delete("fbclid");
  return u.toString();
}

/** A shortcode's post time (ms): the first 11 base64url chars are the media id, whose top bits are ms since IG's epoch. */
export function igTimeFromShortcode(code: string): number | null {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const s = (code ?? "").slice(0, 11);
  if (s.length < 11) return null;
  let v = 0n;
  for (const ch of s) {
    const i = A.indexOf(ch);
    if (i < 0) return null;
    v = v * 64n + BigInt(i);
  }
  const ms = Number((v >> 23n) + 1314220021721n);
  return ms > Date.UTC(2010, 0, 1) && ms < Date.now() + 86_400_000 ? ms : null;
}

const captionOf = (node: Obj): string | null => {
  const c = isObj(node.edge_media_to_caption) && Array.isArray(node.edge_media_to_caption.edges) ? node.edge_media_to_caption.edges[0] : null;
  return isObj(c) && isObj(c.node) ? str(c.node.text) : null;
};

/** `web_profile_info` (the whole answer or its `data.user`) as a Profile; null when there's no user in it. */
export function igParseProfileJson(json: unknown): Profile | null {
  const user = isObj(json) && isObj(json.data) && isObj(json.data.user) ? json.data.user : isObj(json) && isObj(json.user) ? json.user : isObj(json) && (json.username || json.full_name) ? json : null;
  if (!user) return null;
  const username = str(user.username);
  if (!username) return null;
  const links: Profile["links"] = [];
  const push = (raw: unknown, label: unknown): void => {
    const url = typeof raw === "string" ? igCleanLink(raw) : null;
    if (url && !links.some((l) => l.url === url)) links.push({ label: str(label), url });
  };
  for (const b of Array.isArray(user.bio_links) ? user.bio_links : []) if (isObj(b)) push(b.url ?? b.lynx_url, b.title);
  push(user.external_url, null);
  const media = isObj(user.edge_owner_to_timeline_media) ? user.edge_owner_to_timeline_media : {};
  let newest = 0;
  const videos: (RecentVideo & { t: number })[] = [];
  for (const e of Array.isArray(media.edges) ? media.edges : []) {
    const n = isObj(e) && isObj(e.node) ? e.node : null;
    if (!n) continue;
    const code = str(n.shortcode);
    const t = (num(n.taken_at_timestamp) ?? 0) * 1000 || (code ? igTimeFromShortcode(code) ?? 0 : 0);
    if (t > newest) newest = t;
    // The CRM's podium is videos (reels), as the userscript keeps them; freshness counts every post.
    if (!code || n.is_video !== true) continue;
    videos.push({
      t,
      video_id: code,
      title: captionOf(n),
      url: `${IG_ORIGIN}/reel/${code}/`,
      thumbnail_url: str(n.thumbnail_src) ?? str(n.display_url),
      published_at: t ? new Date(t).toISOString() : null,
      view_count: num(n.video_view_count),
      is_short: true,
    });
  }
  videos.sort((a, b) => b.t - a.t);
  const followers = isObj(user.edge_followed_by) ? num(user.edge_followed_by.count) : num(user.follower_count);
  return {
    platform: "instagram",
    platform_id: idOf(user.id) ?? idOf(user.pk) ?? "",
    name: str(user.full_name) ?? username,
    handle: `@${username}`,
    profile_url: `${IG_ORIGIN}/${username}/`,
    avatar_url: str(user.profile_pic_url_hd) ?? (isObj(user.hd_profile_pic_url_info) ? str(user.hd_profile_pic_url_info.url) : null) ?? str(user.profile_pic_url),
    followers,
    posts: num(media.count) ?? num(user.media_count),
    likes: null,
    bio: str(user.biography),
    links,
    email: str(user.business_email) ?? str(user.public_email),
    country: null,
    last_post_at: newest ? new Date(newest).toISOString() : null,
    recent: videos.slice(0, IG_RECENT_LIMIT).map(({ t: _t, ...v }) => v),
    private: user.is_private === true,
    precision: "exact",
  };
}

/** A `<meta>`'s content by property or name, either attribute order. */
function meta(html: string, key: string): string | null {
  const k = key.replace(/[.:]/g, "\\$&");
  const m = html.match(new RegExp(`<meta[^>]*(?:property|name)="${k}"[^>]*content="([^"]*)"`, "i")) ?? html.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*(?:property|name)="${k}"`, "i"));
  return m ? decodeXmlText(m[1]!) : null;
}

const COUNT = String.raw`(\d[\d.,]*(?:\s?(?:[KkMmBb]|mil|mi|bi|mln|tsd))?)`;
const countBefore = (text: string, words: string): number | null => {
  const m = text.match(new RegExp(`${COUNT}\\s+(?:${words})\\b`, "iu"));
  return m ? ytParseCount(m[1]!) : null;
};

/** The page Instagram serves Facebook's crawler: name, rounded counts, bio excerpt, avatar, id. Null when it isn't a profile. */
export function igParseCrawlerHtml(html: string, username: string): Profile | null {
  const u = bare(username);
  const title = meta(html, "og:title") ?? "";
  const desc = meta(html, "og:description") ?? "";
  const pid = html.match(/"profile_id"\s*:\s*"(\d+)"/)?.[1] ?? null;
  const followers = countBefore(desc, "followers?|seguidores?|seguidor");
  if (!pid && followers === null) return null;
  const handle = title.match(/\(@([\w.]+)\)/)?.[1] ?? desc.match(/\(@([\w.]+)\)/)?.[1] ?? u;
  const name = title.match(/^(.*?)\s*\(@[\w.]+\)/)?.[1]?.trim() || null;
  const full = meta(html, "description") ?? "";
  const bio = full.match(/(?:on|no|en|su|sur|auf) Instagram:\s*"([\s\S]*)"\s*$/)?.[1]?.trim() || null;
  return {
    platform: "instagram",
    platform_id: pid ?? "",
    name: name ?? handle,
    handle: `@${handle}`,
    profile_url: `${IG_ORIGIN}/${handle}/`,
    avatar_url: meta(html, "og:image"),
    followers,
    posts: countBefore(desc, "posts?|publicações|publicação|publicacoes|publicaciones|publicación"),
    likes: null,
    bio,
    links: [],
    email: null,
    country: null,
    last_post_at: null,
    recent: [],
    private: false,
    precision: "rounded",
  };
}

const hitOfUser = (user: Obj, latestAt: number | null): Hit | null => {
  const handle = str(user.username);
  if (!handle) return null;
  const hit: Hit = { handle, avatarUrl: str(user.profile_pic_url), followers: num(user.follower_count), latestAt };
  const id = idOf(user.pk) ?? idOf(user.pk_id) ?? idOf(user.id);
  if (id) hit.id = id;
  const name = str(user.full_name);
  if (name) hit.name = name;
  return hit;
};

const isVideo = (o: Obj): boolean => o.media_type === 2 || o.product_type === "clips" || Array.isArray(o.video_versions);

/**
 * Every media's author in any layout (`medias`, `fill_items`, clips): objects with `taken_at` and `user.username`; one
 * Hit per author in the order they first show (the search's ranking), newest post kept, with the media that led to
 * them. `videos`: reels and videos only.
 */
export function igCollectMedia(json: unknown, videos = false): Hit[] {
  const out = new Map<string, Hit>();
  const walk = (n: unknown, depth: number): void => {
    if (!n || typeof n !== "object" || depth > 40) return;
    if (Array.isArray(n)) {
      for (const v of n) walk(v, depth + 1);
      return;
    }
    const o = n as Obj;
    const t = num(o.taken_at);
    if (t !== null && isObj(o.user) && str(o.user.username) && (!videos || isVideo(o))) {
      const hit = hitOfUser(o.user, t * 1000);
      const code = str(o.code);
      if (hit && code) hit.videoUrl = `${IG_ORIGIN}/${isVideo(o) ? "reel" : "p"}/${code}/`;
      if (hit) {
        const k = hit.handle.toLowerCase();
        const had = out.get(k);
        if (!had) out.set(k, hit);
        else if ((had.latestAt ?? 0) < (hit.latestAt ?? 0)) out.set(k, { ...had, latestAt: hit.latestAt ?? null });
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(json, 0);
  return [...out.values()];
}

/** The userscript's tag rule: no '#', no spaces, lowercase, letters/digits/underscore only. */
export function igHashtagFromQuery(q: string): string | null {
  const t = q.trim().replace(/^#+/, "").replace(/\s+/g, "").toLowerCase();
  return t && /^[\p{L}\p{N}_]+$/u.test(t) ? t : null;
}

/** The newest posts from the app's `feed/user/<id>/` (`items`): the reels podium and the newest post's time (pinned ones too). */
export function igRecentFromFeed(json: unknown): { recent: RecentVideo[]; lastPostAt: string | null } {
  let newest = 0;
  const videos: (RecentVideo & { t: number })[] = [];
  for (const m of isObj(json) && Array.isArray(json.items) ? json.items : []) {
    if (!isObj(m)) continue;
    const code = str(m.code);
    const t = (num(m.taken_at) ?? 0) * 1000 || (code ? igTimeFromShortcode(code) ?? 0 : 0);
    if (t > newest) newest = t;
    if (!code || (m.media_type !== 2 && m.product_type !== "clips")) continue;
    const cands = isObj(m.image_versions2) && Array.isArray(m.image_versions2.candidates) ? m.image_versions2.candidates : [];
    videos.push({
      t,
      video_id: code,
      title: isObj(m.caption) ? str(m.caption.text) : null,
      url: `${IG_ORIGIN}/reel/${code}/`,
      thumbnail_url: isObj(cands[0]) ? str(cands[0].url) : null,
      published_at: t ? new Date(t).toISOString() : null,
      view_count: num(m.play_count) ?? num(m.ig_play_count) ?? num(m.view_count),
      is_short: true,
    });
  }
  videos.sort((a, b) => b.t - a.t);
  return { recent: videos.slice(0, IG_RECENT_LIMIT).map(({ t: _t, ...v }) => v), lastPostAt: newest ? new Date(newest).toISOString() : null };
}

/** A GraphQL answer delivered in chunks (one JSON document per line); one document when it's plain JSON. Bad lines skipped. */
export function igParseChunks(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    const out: unknown[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    return out;
  }
}

/** TopSerpQuery's next-page cursor (`page_info` arrives in its own chunk); null when there's no next page. */
export function igTopSerpCursor(docs: unknown[]): string | null {
  let found: string | null = null;
  const walk = (n: unknown, depth: number): void => {
    if (found || !n || typeof n !== "object" || depth > 12) return;
    if (Array.isArray(n)) {
      for (const v of n) walk(v, depth + 1);
      return;
    }
    const o = n as Obj;
    if (isObj(o.page_info) && o.page_info.has_next_page === true && str(o.page_info.end_cursor)) {
      found = o.page_info.end_cursor as string;
      return;
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(docs, 0);
  return found;
}

/** TopSerpQuery's fixed variables (the app's search page, "Top" tab), as instagrapi sends them. */
const TOP_SERP_VARS = {
  turn_id: 0,
  skip_over_fetched_user_fields: false,
  should_include_media_overlay_info_in_lightweight: true,
  in_serp_interacted_media_ids: [],
  should_fetch_timeline_in_skw: false,
  serp_origination_context: { serp_origination: "keyboard", session_state: "typeahead", keyword_context: "null", cdd_ranking_token: null },
  is_incremental_delivery_enabled: false,
  enable_clips_metadata_in_light_media: false,
  include_profile_update_info: true,
  search_type: "SEARCH",
  remove_view_count_from_lightweight: true,
  remove_unused_video_subtitles_status: true,
  include_journey_header: false,
  is_page_info_fetched_in_separate_chunk: true,
  remove_unused_deprecated_owner_counts: true,
  exclude_main_user_field: false,
  enable_pando_connection: false,
  num_media_to_fetch: 10,
  remove_unused_video_subtitles_confidence: true,
  lightweight_carousel_type: "DELAYED_METADATA",
  delay_clips_viewer_fragment: true,
  search_surface: "TOP_SERP",
  enable_tentpole_story_previews: true,
  exclude_pinned_posts: true,
  is_discovery_grid_enabled: true,
  exclude_caption_user_field: false,
  hcm_entrypoint: "IG_SEARCH_TYPEAHEAD_KEYBOARD_SEND",
  lightweight_carousel_count: 1,
  include_clips_viewer_fragment: true,
  remove_unused_carousel_pending_post_count: true,
  remove_paid_partnership_and_subtitles_from_lightweight: true,
  enable_thumbnails_in_light_media: false,
  include_search_engine_attributes: false,
  remove_unused_views_on_grid_status: false,
  include_search_social_context: false,
  enable_serp_clips_viewer_deduplication: true,
};

/** Most search pages one discovery reads (10 posts a page). */
const MAX_SERP_PAGES = 50;

type Api = { status: number; json: unknown; docs: unknown[]; refused: boolean; html: boolean };

export interface InstagramOptions {
  /** Least ms between two calls (IG_GAP_MS); 0 in tests. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** When the next call may go, across every client in this process. */
let nextCallAt = 0;

export class Instagram {
  private readonly gapMs: number;
  private readonly pause: (ms: number) => Promise<void>;

  constructor(
    private readonly fetchFn: Fetch = fetch,
    private readonly session: { cookie: string } | null = null,
    opts: InstagramOptions = {},
  ) {
    this.gapMs = opts.gapMs ?? IG_GAP_MS;
    this.pause = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private cookie(name: string): string | null {
    const m = this.session?.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? m[1]!.trim() || null : null;
  }

  /** The session as the app sends it: `Bearer IGT:2:` + base64 of {ds_user_id, sessionid}. Null without both. */
  private auth(): { bearer: string; userId: string } | null {
    const raw = this.cookie("sessionid");
    if (!raw) return null;
    let sessionid = raw;
    try {
      sessionid = decodeURIComponent(raw);
    } catch {
      // keep it as given
    }
    const userId = this.cookie("ds_user_id") ?? sessionid.match(/^(\d+):/)?.[1] ?? null;
    if (!userId || !/^\d+$/.test(userId)) return null;
    return { bearer: `Bearer IGT:2:${btoa(JSON.stringify({ ds_user_id: userId, sessionid }))}`, userId };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const a = this.auth();
    const h: Record<string, string> = {
      "User-Agent": IG_ANDROID_UA,
      Accept: "*/*",
      // Searches run as Brazil: the app's locale is pt_BR (as a phone set to Português (Brasil)).
      "Accept-Language": "pt-BR,pt;q=0.9",
      "X-IG-App-ID": IG_ANDROID_APP_ID,
      "X-IG-App-Locale": "pt_BR",
      "X-IG-Device-Locale": "pt_BR",
      "X-IG-Mapped-Locale": "pt_BR",
      "X-IG-Capabilities": "3brTv10=",
      "X-IG-Connection-Type": "WIFI",
      "X-FB-HTTP-Engine": "Liger",
    };
    if (a) {
      h.Authorization = a.bearer;
      h["IG-U-DS-USER-ID"] = a.userId;
    }
    const mid = this.cookie("mid");
    if (mid) h["X-MID"] = mid;
    return { ...h, ...extra };
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, nextCallAt);
    nextCallAt = at + this.gapMs;
    if (at > now) await this.pause(at - now);
  }

  /**
   * One app-API call. `refused` = 400/401/403/429, a redirect, HTML (the login wall, "Page Not Found"), no JSON,
   * `status: "fail"` (login_required, challenge_required, "please wait") or GraphQL `errors`.
   */
  private async api(path: string, form?: Record<string, string>, extra: Record<string, string> = {}): Promise<Api> {
    await this.throttle();
    const r = await this.fetchFn(IG_API + path, {
      method: form ? "POST" : "GET",
      headers: this.headers(form ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...extra } : extra),
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    // GraphQL answers JSON labelled text/html: the body decides.
    const html = /^\s*</.test(text) || ((r.headers.get("content-type") ?? "").includes("text/html") && !/^\s*[{[]/.test(text));
    const docs = html ? [] : igParseChunks(text);
    const json = docs[0] ?? null;
    const failed = isObj(json) && (json.status === "fail" || (Array.isArray(json.errors) && json.errors.length > 0));
    return { status: r.status, json, docs, html, refused: [400, 401, 403, 429].includes(r.status) || (r.status >= 300 && r.status < 400) || html || json === null || failed };
  }

  /** The crawler page (no session needed). */
  async crawlerProfile(username: string): Promise<Profile> {
    const u = bare(username);
    const r = await this.fetchFn(`${IG_ORIGIN}/${encodeURIComponent(u)}/`, {
      headers: { "User-Agent": CRAWLER_UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 404) throw new Error("not found");
    if (!r.ok) throw new Error(`Instagram HTTP ${r.status}`);
    const p = igParseCrawlerHtml(await r.text(), u);
    if (!p) throw new Error("not found");
    return p;
  }

  /** With a session: usernameinfo (exact counts, bio, links, email) + the newest posts from the user's feed. Else, or refused: the crawler page. */
  async profile(username: string): Promise<Profile> {
    const u = bare(username);
    if (!u) throw new Error("not found");
    if (this.auth()) {
      try {
        const r = await this.api(`/api/v1/users/${encodeURIComponent(u)}/usernameinfo/`);
        if (r.status === 404 && !r.html && isObj(r.json)) throw new Error("not found");
        const p = r.refused ? null : igParseProfileJson(r.json);
        if (p) {
          if (!p.private && p.posts !== 0 && p.platform_id) {
            try {
              const f = await this.api(`/api/v1/feed/user/${encodeURIComponent(p.platform_id)}/?count=12`);
              if (!f.refused) {
                const { recent, lastPostAt } = igRecentFromFeed(f.json);
                p.recent = recent;
                p.last_post_at = lastPostAt;
              }
            } catch {
              // the profile without its posts
            }
          }
          return p;
        }
      } catch (e) {
        if ((e as Error).message === "not found") throw e;
        // network trouble: the crawler page below
      }
    }
    return this.crawlerProfile(u);
  }

  /** Whose session this is; null without one or when Instagram won't say. */
  async whoami(): Promise<{ username: string } | null> {
    const a = this.auth();
    if (!this.session || !a) return null;
    const read = (j: unknown): string | null => {
      if (!isObj(j)) return null;
      const user = isObj(j.user) ? j.user : isObj(j.data) && isObj(j.data.user) ? j.data.user : null;
      return user ? str(user.username) : null;
    };
    try {
      const r = await this.api("/api/v1/accounts/current_user/?edit=true");
      const name = r.refused ? null : read(r.json);
      if (name) return { username: name };
    } catch {
      // next
    }
    try {
      const r = await this.api(`/api/v1/users/${encodeURIComponent(a.userId)}/info/`);
      const name = r.refused ? null : read(r.json);
      return name ? { username: name } : null;
    } catch {
      return null;
    }
  }

  /**
   * Creators for a query: the authors of the reels Instagram's search shows for the term exactly as typed (a `#tag`
   * when the user typed one, else the keywords), paged (`maxQueries` pages, 40 by default, at most 50); a page with no
   * reel gives its posts' authors. Each batch holds only handles not yielded before. A refusal (401/403/429, HTML,
   * `fail`) ends the search.
   */
  async *discover(query: string, o: DiscoverOpts): AsyncGenerator<Hit[]> {
    if (!this.session || !this.auth()) throw new Error("Instagram search needs a signed-in session");
    const seen = new Set<string>();
    const fresh = (hits: Hit[]): Hit[] =>
      hits.filter((h) => {
        const k = h.handle.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    let calls = 0;
    const call = async (path: string, form?: Record<string, string>, extra?: Record<string, string>): Promise<Api | null> => {
      if (calls++ > 0) await o.sleep(1500);
      if (o.stopped()) return null;
      return this.api(path, form, extra);
    };
    const words = query.trim().replace(/\s+/g, " ");
    const tag = words.startsWith("#") ? igHashtagFromQuery(words) : null;
    const q = tag ? `#${tag}` : words.replace(/^#+/, "").trim();
    const label = tag ? `#${tag}` : `"${q}"`;
    const maxPages = Math.min(MAX_SERP_PAGES, o.maxQueries ?? 40);
    if (q) {
      try {
        const ids = { search_session_id: crypto.randomUUID(), serp_session_id: crypto.randomUUID(), journey_session_id: crypto.randomUUID() };
        let after: string | null = null;
        let dry = 0;
        for (let page = 0; page < maxPages && dry < 3 && !o.stopped(); page++) {
          const variables = { ...TOP_SERP_VARS, query: q, ...ids, is_pagination_request: after !== null, ...(after ? { after } : {}) };
          let r = await call(
            "/graphql/query",
            { method: "post", format: "json", locale: "user", server_timestamps: "true", fb_api_req_friendly_name: "TopSerpQuery", client_doc_id: IG_TOP_SERP_DOC, variables: JSON.stringify(variables) },
            { "X-FB-Friendly-Name": "TopSerpQuery", "X-Root-Field-Name": "xdt_fbsearch__top_serp_graphql" },
          );
          if (!r) break;
          if (r.status === 429 && !o.stopped()) {
            // Instagram's "slow down": one long pause, then the same page once more.
            o.log(`Instagram asked to slow down: waiting ${Math.round(IG_BACKOFF_MS / 1000)} s.`);
            await o.sleep(IG_BACKOFF_MS);
            if (o.stopped()) break;
            r = await call(
              "/graphql/query",
              { method: "post", format: "json", locale: "user", server_timestamps: "true", fb_api_req_friendly_name: "TopSerpQuery", client_doc_id: IG_TOP_SERP_DOC, variables: JSON.stringify(variables) },
              { "X-FB-Friendly-Name": "TopSerpQuery", "X-Root-Field-Name": "xdt_fbsearch__top_serp_graphql" },
            );
            if (!r) break;
          }
          if (r.refused) {
            o.log(`Instagram ${label} posts: refused (HTTP ${r.status}), posts pass stopped`);
            break;
          }
          const reels = igCollectMedia(r.docs, true);
          const hits = fresh(reels.length ? reels : igCollectMedia(r.docs));
          dry = hits.length ? 0 : dry + 1;
          if (hits.length) yield hits;
          const next = igTopSerpCursor(r.docs);
          if (!next || next === after) break;
          after = next;
        }
      } catch (e) {
        o.log(`Instagram ${label} posts: ${(e as Error).message}`);
      }
    }
  }
}
