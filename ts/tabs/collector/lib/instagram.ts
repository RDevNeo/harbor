// Instagram, as the userscript reads it (lead-collector.user.js, "Instagram creator collection"), from Hub's engine.
// With a signed-in session (its Cookie header): the web app's JSON (`web_profile_info`, tag sections, topsearch), with
// the headers the web app sends. Without one, every JSON endpoint answers 404 to a logged-out client, so a profile is
// read the way link previews are: the page served to Facebook's crawler UA (og:title / og:description: rounded counts,
// a bio excerpt, the avatar and the profile id; no posts). Discovery needs the session.
import { decodeXmlText, ytParseCount, type Fetch } from "./youtube.ts";
import type { RecentVideo } from "./types.ts";
import type { DiscoverOpts, Hit, Profile } from "./tiktok.ts";

export type { DiscoverOpts, Hit, Profile } from "./tiktok.ts";

export const IG_ORIGIN = "https://www.instagram.com";
export const IG_APP_ID = "936619743392459";
export const IG_RECENT_LIMIT = 3;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
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
    avatar_url: str(user.profile_pic_url_hd) ?? str(user.profile_pic_url),
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

/** Every media's author in any layout (`medias`, `fill_items`, clips): objects with `taken_at` and `user.username`; one Hit per author, newest post kept. */
export function igCollectMedia(json: unknown): Hit[] {
  const out = new Map<string, Hit>();
  const walk = (n: unknown, depth: number): void => {
    if (!n || typeof n !== "object" || depth > 40) return;
    if (Array.isArray(n)) {
      for (const v of n) walk(v, depth + 1);
      return;
    }
    const o = n as Obj;
    const t = num(o.taken_at);
    if (t !== null && isObj(o.user) && str(o.user.username)) {
      const hit = hitOfUser(o.user, t * 1000);
      if (hit) {
        const k = hit.handle.toLowerCase();
        const had = out.get(k);
        if (!had || (had.latestAt ?? 0) < (hit.latestAt ?? 0)) out.set(k, had ? { ...had, ...hit } : hit);
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(json, 0);
  return [...out.values()];
}

/** topsearch's `users[].user`. */
export function igUsersFromSearch(json: unknown): Hit[] {
  const out: Hit[] = [];
  for (const e of isObj(json) && Array.isArray(json.users) ? json.users : []) {
    const hit = isObj(e) && isObj(e.user) ? hitOfUser(e.user, null) : null;
    if (hit && !out.some((h) => h.handle.toLowerCase() === hit.handle.toLowerCase())) out.push(hit);
  }
  return out;
}

/** The userscript's tag rule: no '#', no spaces, lowercase, letters/digits/underscore only. */
export function igHashtagFromQuery(q: string): string | null {
  const t = q.trim().replace(/^#+/, "").replace(/\s+/g, "").toLowerCase();
  return t && /^[\p{L}\p{N}_]+$/u.test(t) ? t : null;
}

type Api = { status: number; json: unknown; refused: boolean };

export class Instagram {
  constructor(
    private readonly fetchFn: Fetch = fetch,
    private readonly session: { cookie: string } | null = null,
  ) {}

  private cookie(name: string): string | null {
    const m = this.session?.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? m[1]!.trim() : null;
  }

  private headers(form = false): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "*/*",
      "X-IG-App-ID": IG_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${IG_ORIGIN}/`,
      Origin: IG_ORIGIN,
    };
    if (this.session) h.Cookie = this.session.cookie;
    const csrf = this.cookie("csrftoken");
    if (csrf) h["X-CSRFToken"] = csrf;
    if (form) h["Content-Type"] = "application/x-www-form-urlencoded";
    return h;
  }

  /** One JSON call; `refused` = 401/403/429 or an HTML answer (the login wall, "Page Not Found"). */
  private async api(path: string, body?: string): Promise<Api> {
    const r = await this.fetchFn(IG_ORIGIN + path, {
      method: body === undefined ? "GET" : "POST",
      headers: this.headers(body !== undefined),
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    const html = /^\s*</.test(text) || (r.headers.get("content-type") ?? "").includes("text/html");
    let json: unknown = null;
    if (!html) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: r.status, json, refused: [401, 403, 429].includes(r.status) || (r.status >= 300 && r.status < 400) || html || json === null };
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

  async profile(username: string): Promise<Profile> {
    const u = bare(username);
    if (!u) throw new Error("not found");
    if (this.session) {
      try {
        const r = await this.api(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`);
        if (!r.refused && r.status < 300) {
          const p = igParseProfileJson(r.json);
          if (p) return p;
          if (isObj(r.json) && isObj(r.json.data) && r.json.data.user === null) throw new Error("not found");
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
    if (!this.session) return null;
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
    const id = this.cookie("ds_user_id");
    if (!id) return null;
    try {
      const r = await this.api(`/api/v1/users/${encodeURIComponent(id)}/info/`);
      const name = r.refused ? null : read(r.json);
      return name ? { username: name } : null;
    } catch {
      return null;
    }
  }

  /**
   * Accounts for a query: the hashtag's recent posts (paged, `maxQueries` pages, 40 by default) and then the blended
   * account search. Each batch holds only handles not yielded before. A refusal (401/403/429, HTML) ends that pass.
   */
  async *discover(query: string, o: DiscoverOpts): AsyncGenerator<Hit[]> {
    if (!this.session) throw new Error("Instagram search needs a signed-in session");
    const seen = new Set<string>();
    const fresh = (hits: Hit[]): Hit[] =>
      hits.filter((h) => {
        const k = h.handle.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    let calls = 0;
    const call = async (path: string, body?: string): Promise<Api | null> => {
      if (calls++ > 0) await o.sleep(1500);
      if (o.stopped()) return null;
      return this.api(path, body);
    };
    const maxPages = o.maxQueries ?? 40;
    const tag = igHashtagFromQuery(query);
    if (tag) {
      try {
        let r = await call(`/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`);
        if (r && r.refused) o.log(`Instagram #${tag}: refused (HTTP ${r.status})`);
        else if (r) {
          const first = fresh(igCollectMedia(r.json));
          if (first.length) yield first;
          let cursor: string | null = "";
          let dry = 0;
          for (let page = 1; page < maxPages && cursor !== null && dry < 3 && !o.stopped(); page++) {
            const form = new URLSearchParams({ tab: "recent", page: "0" });
            if (cursor) form.set("max_id", cursor);
            r = await call(`/api/v1/tags/${encodeURIComponent(tag)}/sections/`, form.toString());
            if (!r) break;
            if (r.refused) {
              o.log(`Instagram #${tag}: refused (HTTP ${r.status}), hashtag pass stopped`);
              break;
            }
            const hits = fresh(igCollectMedia(r.json));
            dry = hits.length ? 0 : dry + 1;
            if (hits.length) yield hits;
            const j = isObj(r.json) ? r.json : {};
            const next = idOf(j.next_max_id);
            cursor = j.more_available === true && next && next !== cursor ? next : null;
          }
        }
      } catch (e) {
        o.log(`Instagram #${tag}: ${(e as Error).message}`);
      }
    }
    if (o.stopped()) return;
    try {
      const r = await call(`/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(query.trim())}&include_reel=true`);
      if (r && r.refused) o.log(`Instagram account search: refused (HTTP ${r.status})`);
      else if (r) {
        const hits = fresh(igUsersFromSearch(r.json));
        if (hits.length) yield hits;
      }
    } catch (e) {
      o.log(`Instagram account search: ${(e as Error).message}`);
    }
  }
}
