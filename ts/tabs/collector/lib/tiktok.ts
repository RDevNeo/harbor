// TikTok, as the userscript reads it (lead-collector.user.js, "TikTok creator collection"), from Hub's engine instead of
// a tiktok.com tab. Anonymous, no signing SDK: the profile page's rehydration blob (`webapp.user-detail`), the embed
// page's video list (the userscript's pre-check, and its recent videos here) and the search box's suggestions
// (`/api/search/general/preview/`, the one search endpoint that answers unsigned). TikTok's WAF answers the first page
// with a proof-of-work challenge (its own `waf-aiso` script): solved here, the cookies kept for the session.
import { createHash } from "node:crypto";
import { normalizeUrl } from "./links.ts";
import type { RecentVideo } from "./types.ts";
import type { Fetch } from "./youtube.ts";

/** A TikTok or Instagram profile, read once (Instagram imports this shape). */
export interface Profile {
  platform: "tiktok" | "instagram";
  /** TikTok user.id; Instagram pk/id (numeric string). "" when a private TikTok page gave no user. */
  platform_id: string;
  name: string;
  /** "@uniqueid". */
  handle: string;
  /** https://www.tiktok.com/@x  /  https://www.instagram.com/x/ */
  profile_url: string;
  avatar_url: string | null;
  /** Exact when available; null when unknown (never 0 for unknown). */
  followers: number | null;
  /** TikTok videoCount; Instagram total posts. */
  posts: number | null;
  /** TikTok heartCount; Instagram null. */
  likes: number | null;
  bio: string | null;
  links: { label: string | null; url: string }[];
  /** Instagram business_email / public_email when the JSON has it; else null. */
  email: string | null;
  country: string | null;
  /** ISO, the newest post/video. */
  last_post_at: string | null;
  /** Up to 3 newest; [] when unknown. */
  recent: RecentVideo[];
  private: boolean;
  /** "exact" | "rounded": Instagram's anonymous reads (and TikTok's old `stats`) give rounded counts. */
  precision: "exact" | "rounded";
}

/** One account a discovery pass surfaced. `handle` is the bare username (no "@"), what `profile()` takes. */
export interface Hit {
  handle: string;
  id?: string;
  name?: string;
  avatarUrl?: string | null;
  followers?: number | null;
  /** ms; the newest post seen in discovery (a floor). */
  latestAt?: number | null;
}

/** What `discover()` needs from its caller. */
export interface DiscoverOpts {
  stopped(): boolean;
  sleep(ms: number): Promise<void>;
  log(t: string): void;
  maxQueries?: number;
}

export const TT_RECENT_LIMIT = 3;
export const TT_ORIGIN = "https://www.tiktok.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

type Obj = Record<string, unknown>;
const isObj = (n: unknown): n is Obj => !!n && typeof n === "object" && !Array.isArray(n);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** A count as TikTok sends it (number or digit string); null when absent. */
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
};
const bare = (handle: string): string => handle.trim().replace(/^@/, "");

/** The JSON inside `<script id="…">`; null when absent or unreadable. */
export function scriptJson(html: string, id: string): unknown {
  const m = html.match(new RegExp(`<script[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

/** A video id's upload time (ms): the top 32 bits are the Unix second. Null for anything that isn't a plausible id. */
export function ttTimeFromId(id: string | number | null | undefined): number | null {
  const s = String(id ?? "");
  if (!/^\d{15,20}$/.test(s)) return null;
  const ms = Number(BigInt(s) >> 32n) * 1000;
  if (ms < Date.UTC(2016, 0, 1) || ms > Date.now() + 86_400_000) return null;
  return ms;
}

export type TtDetail = { status: "ok" | "private" | "not_found"; profile: Profile | null };

/**
 * A profile page's `webapp.user-detail`. statusCode 10222 = private (the profile, when the page still carries the user),
 * 10221 or no user = not found. Null when the page has no rehydration data (a challenge, a layout change).
 */
export function ttParseUserDetail(html: string): TtDetail | null {
  const blob = scriptJson(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const scope = isObj(blob) && isObj(blob.__DEFAULT_SCOPE__) ? blob.__DEFAULT_SCOPE__ : null;
  if (!scope) return null;
  const d = scope["webapp.user-detail"];
  if (!isObj(d)) return { status: "not_found", profile: null };
  const code = num(d.statusCode) ?? 0;
  const info = isObj(d.userInfo) ? d.userInfo : null;
  const u = info && isObj(info.user) ? info.user : null;
  const uniqueId = u ? str(u.uniqueId) : null;
  if (code === 10222) return { status: "private", profile: u && uniqueId ? ttProfileFromUser(u, info!, true) : null };
  if (code !== 0 || !u || !uniqueId) return { status: "not_found", profile: null };
  return { status: "ok", profile: ttProfileFromUser(u, info!, u.privateAccount === true || u.secret === true) };
}

function ttProfileFromUser(u: Obj, info: Obj, priv: boolean): Profile {
  const s2 = isObj(info.statsV2) ? info.statsV2 : {};
  const s1 = isObj(info.stats) ? info.stats : {};
  const exact = num(s2.followerCount) !== null;
  const uniqueId = str(u.uniqueId)!;
  const links: Profile["links"] = [];
  const bio = isObj(u.bioLink) ? str(u.bioLink.link) : null;
  if (bio) {
    const url = normalizeUrl(bio) ?? (/^https?:\/\//i.test(bio) ? bio : `https://${bio}`);
    links.push({ label: null, url });
  }
  return {
    platform: "tiktok",
    platform_id: str(u.id) ?? "",
    name: str(u.nickname) ?? uniqueId,
    handle: `@${uniqueId}`,
    profile_url: `${TT_ORIGIN}/@${uniqueId}`,
    avatar_url: str(u.avatarLarger) ?? str(u.avatarMedium) ?? str(u.avatarThumb),
    followers: num(s2.followerCount) ?? num(s1.followerCount),
    posts: num(s2.videoCount) ?? num(s1.videoCount),
    likes: num(s2.heartCount) ?? num(s2.heart) ?? num(s1.heartCount) ?? num(s1.heart),
    bio: str(u.signature),
    links,
    email: null,
    country: str(u.region),
    last_post_at: null,
    recent: [],
    private: priv,
    precision: exact ? "exact" : "rounded",
  };
}

export interface TtEmbed {
  /** The embed says the account is private, banned or gone. */
  error: boolean;
  /** Newest first, up to 3. */
  recent: RecentVideo[];
  /** ms, the newest public video; null when none. */
  newest: number | null;
  /** Rounded. */
  followers: number | null;
}

/** `/embed/@<handle>`'s `__FRONTITY_CONNECT_STATE__` → `source.data["/embed/@<handle>"]`; null when it isn't there. */
export function ttParseEmbed(html: string, handle: string): TtEmbed | null {
  const state = scriptJson(html, "__FRONTITY_CONNECT_STATE__");
  const data = isObj(state) && isObj(state.source) && isObj(state.source.data) ? state.source.data : null;
  if (!data) return null;
  const h = bare(handle);
  const key = Object.keys(data).find((k) => k.toLowerCase() === `/embed/@${h}`.toLowerCase());
  const page = key ? data[key] : null;
  if (!isObj(page)) return null;
  const user = isObj(page.userInfo) ? page.userInfo : {};
  const videos: (RecentVideo & { t: number })[] = [];
  for (const v of Array.isArray(page.videoList) ? page.videoList : []) {
    if (!isObj(v) || v.privateItem === true) continue;
    const id = str(v.id) ?? (typeof v.id === "number" ? String(v.id) : null);
    const t = ttTimeFromId(id);
    if (!id || t === null) continue;
    const author = str(v.authorUniqueId) ?? h;
    videos.push({
      t,
      video_id: id,
      title: str(v.desc),
      url: `${TT_ORIGIN}/@${author}/video/${id}`,
      thumbnail_url: str(v.coverUrl) ?? str(v.originCoverUrl),
      published_at: new Date(t).toISOString(),
      view_count: num(v.playCount),
      is_short: true,
    });
  }
  videos.sort((a, b) => b.t - a.t);
  return {
    error: page.isError === true,
    recent: videos.slice(0, TT_RECENT_LIMIT).map(({ t: _t, ...v }) => v),
    newest: videos[0]?.t ?? null,
    followers: num(user.followerCount),
  };
}

/** The search box's suggestions: accounts (`sug_type` "account" / "certified_account") and the other phrases. */
export function ttParseSuggest(json: unknown): { accounts: Hit[]; words: string[] } {
  const accounts: Hit[] = [];
  const words: string[] = [];
  const list = isObj(json) && Array.isArray(json.sug_list) ? json.sug_list : [];
  for (const s of list) {
    if (!isObj(s)) continue;
    const type = str(s.sug_type) ?? "";
    const x = isObj(s.extra_info) ? s.extra_info : {};
    if (/account/.test(type)) {
      const handle = str(x.unique_id) ?? str(x.sug_uniq_id);
      if (!handle || accounts.some((a) => a.handle.toLowerCase() === handle.toLowerCase())) continue;
      const hit: Hit = { handle, avatarUrl: str(x.rich_sug_avatar_uri) };
      const id = str(x.sug_user_id);
      if (id) hit.id = id;
      const name = str(x.rich_sug_nickname) ?? str(x.nickname);
      if (name) hit.name = name;
      accounts.push(hit);
      continue;
    }
    const w = str(s.content)?.trim();
    if (w && !words.includes(w)) words.push(w);
  }
  return { accounts, words };
}

/**
 * TikTok's WAF proof of work (`waf-aiso`): the page carries `<p id="wci" class="<cookie name>">` and `<p id="cs"
 * class="<base64 JSON {v:{a,b,c},s}>">`; find i with sha256(b64(a) ++ String(i)) == b64(c), set `d = btoa(i)` and store
 * the JSON (base64) under the cookie name, plus `<rci>=<rs>` and `waforigin_id=<rs_id>`. Null when it isn't a challenge.
 */
export function solveWaf(html: string): Record<string, string> | null {
  const cls = (id: string): string => html.match(new RegExp(`id="${id}" class="([^"]*)"`))?.[1] ?? "";
  const wci = cls("wci");
  const cs = cls("cs");
  if (!wci || !cs) return null;
  let c: { v?: { a?: string; c?: string }; d?: string };
  try {
    c = JSON.parse(Buffer.from(cs, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!c.v?.a || !c.v.c) return null;
  const prefix = Buffer.from(c.v.a, "base64");
  const expect = Buffer.from(c.v.c, "base64").toString("hex");
  for (let i = 0; i <= 1_000_000; i++) {
    if (createHash("sha256").update(prefix).update(String(i)).digest("hex") !== expect) continue;
    c.d = Buffer.from(String(i)).toString("base64");
    const out: Record<string, string> = { [wci]: Buffer.from(JSON.stringify(c)).toString("base64") };
    const rci = cls("rci");
    const rs = cls("rs");
    const rsId = cls("rs_id");
    if (rci && rs) out[rci] = rs;
    if (rsId) out.waforigin_id = rsId;
    return out;
  }
  return null;
}

const isChallenge = (body: string): boolean => body.includes("_wafchallengeid");

/** TikTok over plain HTTPS: browser UA, English, one cookie jar (WAF + ttwid) for the session. */
export class TikTok {
  private readonly jar = new Map<string, string>();
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    private readonly fetchFn: Fetch = fetch,
    opts: { sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private absorb(r: Response): void {
    const set = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
    for (const sc of set) {
      const kv = sc.split(";")[0] ?? "";
      const i = kv.indexOf("=");
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  private async once(url: string, accept: string): Promise<{ status: number; body: string }> {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      const headers: Record<string, string> = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: accept };
      if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const r = await this.fetchFn(target, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
      this.absorb(r);
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) {
        target = new URL(loc, target).toString();
        continue;
      }
      return { status: r.status, body: await r.text() };
    }
    throw new Error("TikTok: too many redirects");
  }

  /** One GET; a WAF challenge is solved and the request retried once. */
  private async get(url: string, accept = "text/html,application/xhtml+xml,*/*;q=0.8"): Promise<{ status: number; body: string }> {
    let res = await this.once(url, accept);
    if (!isChallenge(res.body)) return res;
    const cookies = solveWaf(res.body);
    if (!cookies) throw new Error("TikTok challenge could not be solved");
    for (const [k, v] of Object.entries(cookies)) this.jar.set(k, v);
    await this.sleep(1500);
    res = await this.once(url, accept);
    if (isChallenge(res.body)) throw new Error("TikTok challenge not accepted");
    return res;
  }

  /** The newest videos (embed page); null when the embed can't be read. */
  async embed(handle: string): Promise<TtEmbed | null> {
    const h = bare(handle);
    const r = await this.get(`${TT_ORIGIN}/embed/@${encodeURIComponent(h)}`);
    if (r.status >= 400) return null;
    return ttParseEmbed(r.body, h);
  }

  async profile(handle: string): Promise<Profile> {
    const h = bare(handle);
    if (!h) throw new Error("not found");
    const r = await this.get(`${TT_ORIGIN}/@${encodeURIComponent(h)}?lang=en`);
    if (r.status === 404) throw new Error("not found");
    if (r.status >= 400) throw new Error(`TikTok HTTP ${r.status}`);
    const d = ttParseUserDetail(r.body);
    if (!d) throw new Error("could not read TikTok profile data");
    if (d.status === "not_found") throw new Error("not found");
    if (d.status === "private") return d.profile ?? { ...emptyProfile(h), private: true };
    const p = d.profile!;
    if (p.private) return p;
    try {
      const e = await this.embed(p.handle);
      if (e && !e.error) {
        p.recent = e.recent;
        p.last_post_at = e.newest ? new Date(e.newest).toISOString() : null;
      }
    } catch {
      // the profile stands without its videos
    }
    return p;
  }

  async suggest(query: string): Promise<{ accounts: Hit[]; words: string[] }> {
    const r = await this.get(`${TT_ORIGIN}/api/search/general/preview/?aid=1988&keyword=${encodeURIComponent(query)}`, "application/json, text/plain, */*");
    if (r.status >= 400) throw new Error(`TikTok suggest HTTP ${r.status}`);
    if (!r.body.trim()) throw new Error("TikTok suggest refused (empty answer)");
    let json: unknown;
    try {
      json = JSON.parse(r.body);
    } catch {
      throw new Error("TikTok suggest: not JSON");
    }
    const code = isObj(json) ? num(json.status_code) : null;
    if (code) throw new Error(`TikTok suggest status ${code}`);
    return ttParseSuggest(json);
  }

  /**
   * Accounts through the suggestions, breadth-first: the query, then the suggested phrases that contain its first word,
   * then `query a` … `query z`, each query once, up to `maxQueries` (40). Yields each batch of handles not seen before.
   */
  async *discover(query: string, o: DiscoverOpts): AsyncGenerator<Hit[]> {
    const q0 = query.trim().replace(/\s+/g, " ");
    if (!q0) return;
    const first = q0.split(" ")[0]!.toLowerCase();
    const max = o.maxQueries ?? 40;
    const queue = [q0];
    const queued = new Set([q0.toLowerCase()]);
    const seen = new Set<string>();
    const add = (q: string): void => {
      const k = q.trim().replace(/\s+/g, " ");
      if (!k || queued.has(k.toLowerCase())) return;
      queued.add(k.toLowerCase());
      queue.push(k);
    };
    let asked = 0;
    let failures = 0;
    let expanded = false;
    const expand = (): void => {
      if (expanded) return;
      expanded = true;
      for (const c of "abcdefghijklmnopqrstuvwxyz") add(`${q0} ${c}`);
    };
    while (queue.length && asked < max && !o.stopped()) {
      const q = queue.shift()!;
      if (asked > 0) {
        await o.sleep(1800);
        if (o.stopped()) return;
      }
      asked++;
      let res: { accounts: Hit[]; words: string[] };
      try {
        res = await this.suggest(q);
        failures = 0;
      } catch (e) {
        o.log(`TikTok suggestions for "${q}": ${(e as Error).message}`);
        if (++failures >= 3) return;
        expand();
        continue;
      }
      const fresh = res.accounts.filter((a) => {
        const k = a.handle.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (fresh.length) yield fresh;
      for (const w of res.words) if (w.toLowerCase().includes(first)) add(w);
      expand();
    }
  }
}

function emptyProfile(h: string): Profile {
  return {
    platform: "tiktok",
    platform_id: "",
    name: h,
    handle: `@${h}`,
    profile_url: `${TT_ORIGIN}/@${h}`,
    avatar_url: null,
    followers: null,
    posts: null,
    likes: null,
    bio: null,
    links: [],
    email: null,
    country: null,
    last_post_at: null,
    recent: [],
    private: false,
    precision: "exact",
  };
}
