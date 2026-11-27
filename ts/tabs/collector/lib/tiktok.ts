// TikTok, as the userscript reads it (lead-collector.user.js, "TikTok creator collection"), from Hub's engine instead of
// a tiktok.com tab. Anonymous: the profile page's rehydration blob (`webapp.user-detail`), the embed page's video list
// (the 3 newest videos) and, to find creators, the VIDEOS under the term's hashtag (what tiktok.com/tag/<tag> shows:
// `/api/challenge/detail/` for its id, unsigned; `/api/challenge/item_list/`, 30 a page, signed with X-Bogus, TikTok's
// public request checksum). TikTok's keyword search (`/api/search/item/full/`, `/general/full/`) answers an empty body
// unless it also carries X-Gnarly, its page code's newer signature, which Hub doesn't forge: so a term is searched as
// its hashtag ("dress to impress" → #dresstoimpress), then as the hashtags of the search box's suggestions
// (`/api/search/general/preview/`, unsigned). TikTok's WAF answers the first page with a proof-of-work challenge (its
// own `waf-aiso` script): solved here, the cookies kept for the session.
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
  /** The search result (video or post) that led to them. */
  videoUrl?: string;
  /** TikTok: how Portuguese that video is (`ttPtSignal`); absent = nothing Portuguese about it. */
  pt?: PtSignal;
}

/** What `discover()` needs from its caller. */
export interface DiscoverOpts {
  stopped(): boolean;
  sleep(ms: number): Promise<void>;
  log(t: string): void;
  maxQueries?: number;
}

export const TT_RECENT_LIMIT = 3;
/** How TikTok searches, for the form. */
export const TT_NOTE = "Searches the videos under the term's hashtag (dress to impress → #dresstoimpress, as tiktok.com/tag shows them) and keeps only Brazilian creators: a video in Portuguese, made in Brazil. No login needed.";
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
 * 10221 or no user = not found. Null when the page has no rehydration data (a challenge, a layout change) or no
 * `webapp.user-detail` at all: TikTok sends the page without it for a while after many reads (a missing account still
 * gets one, with 10221).
 */
export function ttParseUserDetail(html: string): TtDetail | null {
  const blob = scriptJson(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const scope = isObj(blob) && isObj(blob.__DEFAULT_SCOPE__) ? blob.__DEFAULT_SCOPE__ : null;
  if (!scope) return null;
  const d = scope["webapp.user-detail"];
  if (!isObj(d)) return null;
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
  /** The account as the embed shows it (rounded counts, no video count or bio link); null without a user. */
  profile: Profile | null;
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
  const user: Obj = isObj(page.userInfo) ? page.userInfo : {};
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
  const recent = videos.slice(0, TT_RECENT_LIMIT).map(({ t: _t, ...v }) => v);
  const newest = videos[0]?.t ?? null;
  const uid = str(user.uniqueId);
  const profile: Profile | null = uid
    ? {
        ...emptyProfile(uid),
        platform_id: str(user.id) ?? "",
        name: str(user.nickname) ?? uid,
        avatar_url: str(user.avatarThumbUrl) ?? str(user.avatarMediumUrl) ?? str(user.avatarLargerUrl),
        followers: num(user.followerCount),
        likes: num(user.heartCount),
        bio: str(user.signature),
        last_post_at: newest ? new Date(newest).toISOString() : null,
        recent,
        private: user.privateAccount === true,
        precision: "rounded",
      }
    : null;
  return { error: page.isError === true, recent, newest, followers: num(user.followerCount), profile };
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
const JSON_ACCEPT = "application/json, text/plain, */*";

/** A term as TikTok's hashtag: "dress to impress" → "dresstoimpress", "#Fit Check" → "fitcheck"; "" when nothing's left. */
export const ttTagOf = (term: string): string =>
  term
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}_]/gu, "");

const XB_CHARS = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=";
const md5 = (b: Uint8Array | string): Uint8Array => new Uint8Array(createHash("md5").update(b).digest());
function rc4(key: ArrayLike<number>, data: ArrayLike<number>): number[] {
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i]! + key[i % key.length]!) & 255;
    [S[i], S[j]] = [S[j]!, S[i]!];
  }
  const out: number[] = [];
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]!) & 255;
    [S[i], S[j]] = [S[j]!, S[i]!];
    out.push(data[k]! ^ S[(S[i]! + S[j]!) & 255]!);
  }
  return out;
}

/**
 * X-Bogus, the web app's request checksum (a public algorithm: md5s of the query, body and UA, a timestamp, RC4, a
 * custom base64), for a query string (no "?", without X-Bogus), the body ("" for a GET) and the exact UA sent.
 */
export function xBogus(query: string, ua: string, body = "", now = Math.floor(Date.now() / 1000)): string {
  const uaArr = md5(Buffer.from(rc4([0, 1, 12], Buffer.from(ua, "latin1"))).toString("base64"));
  const bodyArr = md5(md5(body));
  const qArr = md5(md5(query));
  const ct = 536919696;
  const a = [64, 0, 1, 12, qArr[14]!, qArr[15]!, bodyArr[14]!, bodyArr[15]!, uaArr[14]!, uaArr[15]!, (now >>> 24) & 255, (now >>> 16) & 255, (now >>> 8) & 255, now & 255, (ct >>> 24) & 255, (ct >>> 16) & 255, (ct >>> 8) & 255, ct & 255];
  a.push(a.reduce((x, y) => x ^ y));
  const m = [...a.filter((_, i) => i % 2 === 0), ...a.filter((_, i) => i % 2 === 1)];
  const y = [m[0], m[10], m[1], m[11], m[2], m[12], m[3], m[13], m[4], m[14], m[5], m[15], m[6], m[16], m[7], m[17], m[8], m[18], m[9]] as number[];
  const g = [2, 255, ...rc4([255], y)];
  let s = "";
  for (let i = 0; i < g.length; i += 3) {
    const x = (g[i]! << 16) | (g[i + 1]! << 8) | g[i + 2]!;
    s += XB_CHARS[(x >> 18) & 63]! + XB_CHARS[(x >> 12) & 63]! + XB_CHARS[(x >> 6) & 63]! + XB_CHARS[x & 63]!;
  }
  return s;
}

/** The web app's usual query parameters (a Linux Chrome visitor in Brazil, pt-BR: searches run as Brazil). */
export function ttWebParams(deviceId: string, extra: Record<string, string>): Record<string, string> {
  return {
    aid: "1988",
    app_language: "pt-BR",
    app_name: "tiktok_web",
    browser_language: "pt-BR",
    browser_name: "Mozilla",
    browser_online: "true",
    browser_platform: "Linux x86_64",
    browser_version: UA.slice("Mozilla/".length),
    channel: "tiktok_web",
    cookie_enabled: "true",
    device_id: deviceId,
    device_platform: "web_pc",
    focus_state: "true",
    history_len: "2",
    is_fullscreen: "false",
    is_page_visible: "true",
    language: "pt-BR",
    os: "linux",
    region: "BR",
    screen_height: "1080",
    screen_width: "1920",
    tz_name: "America/Sao_Paulo",
    webcast_language: "pt-BR",
    ...extra,
  };
}

/**
 * How Portuguese a found video is, from what the hashtag page already sends (no request): "clear" when TikTok tags its
 * caption `pt` (`textLanguage`) or its speech Portuguese (`claInfo.originalLanguageInfo`, the original-audio caption,
 * the ASR subtitles); "caption" when the caption reads Portuguese by its words (`ptCaption`: TikTok often tags a short
 * Portuguese caption "en" or "un"); null when nothing is Portuguese (the creator is skipped unread).
 */
export type PtSignal = "clear" | "caption";

/** Words only Portuguese uses (2 points) and common Portuguese words other languages rarely share (1 point). */
const PT_STRONG = new Set("você vocês voce voces vc vcs não nao tô tá né também tambem então entao obrigado obrigada brasil brasileiro brasileira brasileiros brasileiras fypbrasil viralbrasil foryoubrasil paravoce pravoce".split(" "));
const PT_WEAK = new Set("muito muita muitos muitas pra pro gente agora isso esse essa esses essas com meu minha meus minhas sou estou quero já vou vamos ficou fiz nós hoje ontem melhor pior coisa coisas tudo quando onde quem bem foi fazer olha nossa demais nunca sempre br novo nova".split(" "));

/** Whether a caption reads Portuguese: ã/õ (-ção, -ões), "kkk", or Portuguese words scoring 2 (links left out). */
export function ptCaption(text: string): boolean {
  const t = text.toLowerCase().replace(/https?:\/\/\S+|\S+\.(com|net|br)\S*/g, " ");
  let score = 0;
  for (const w of t.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    if (/[ãõ]|^k{3,}$|^(rs){2,}$/.test(w) || PT_STRONG.has(w)) score += 2;
    else if (PT_WEAK.has(w)) score += 1;
    if (score >= 2) return true;
  }
  return false;
}

const isPt = (code: unknown): boolean => typeof code === "string" && /^(pt|por)(\b|[-_])/i.test(code);

/** A hashtag-page video's Portuguese signal (see `PtSignal`). */
export function ttPtSignal(it: Obj): PtSignal | null {
  if (isPt(it.textLanguage)) return "clear";
  const v = isObj(it.video) ? it.video : {};
  const cla = isObj(v.claInfo) ? v.claInfo : {};
  const orig = isObj(cla.originalLanguageInfo) ? cla.originalLanguageInfo : {};
  if (isPt(orig.languageCode) || isPt(orig.language)) return "clear";
  for (const c of Array.isArray(cla.captionInfos) ? cla.captionInfos : []) if (isObj(c) && c.isOriginalCaption === true && (isPt(c.languageCode) || isPt(c.language))) return "clear";
  for (const sub of Array.isArray(v.subtitleInfos) ? v.subtitleInfos : []) if (isObj(sub) && sub.Source === "ASR" && isPt(sub.LanguageCodeName)) return "clear";
  return ptCaption(str(it.desc) ?? "") ? "caption" : null;
}

const PT_RANK = { clear: 2, caption: 1 } as const;

/**
 * A hashtag page's videos (`itemList`) as creators, in TikTok's order: one per creator (their most Portuguese video on
 * the page, else the first), with the video, its time and its Portuguese signal.
 */
export function ttParseItemList(json: unknown): Hit[] {
  const out: Hit[] = [];
  for (const it of isObj(json) && Array.isArray(json.itemList) ? json.itemList : []) {
    if (!isObj(it) || !isObj(it.author)) continue;
    const a = it.author;
    const handle = str(a.uniqueId);
    const vid = str(it.id) ?? (typeof it.id === "number" ? String(it.id) : null);
    if (!handle || !vid) continue;
    const pt = ttPtSignal(it);
    const t = (num(it.createTime) ?? 0) * 1000 || ttTimeFromId(vid);
    const prev = out.find((h) => h.handle.toLowerCase() === handle.toLowerCase());
    if (prev) {
      if (pt && PT_RANK[pt] > (prev.pt ? PT_RANK[prev.pt] : 0)) {
        prev.pt = pt;
        prev.videoUrl = `${TT_ORIGIN}/@${handle}/video/${vid}`;
      }
      if (t && t > (prev.latestAt ?? 0)) prev.latestAt = t;
      continue;
    }
    const hit: Hit = { handle, avatarUrl: str(a.avatarLarger) ?? str(a.avatarMedium) ?? str(a.avatarThumb), videoUrl: `${TT_ORIGIN}/@${handle}/video/${vid}` };
    const id = str(a.id);
    if (id) hit.id = id;
    const name = str(a.nickname);
    if (name) hit.name = name;
    const st = isObj(it.authorStats) ? it.authorStats : {};
    const f = num(st.followerCount);
    if (f !== null) hit.followers = f;
    if (t) hit.latestAt = t;
    if (pt) hit.pt = pt;
    out.push(hit);
  }
  return out;
}

/**
 * Where a video was made: its page's `webapp.video-detail` → `itemStruct.locationCreated` (an ISO country, "BR").
 * `undefined` when the page has no video data (a challenge, a layout change), null when the video doesn't say.
 */
export function ttParseVideoCountry(html: string): string | null | undefined {
  const blob = scriptJson(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const scope = isObj(blob) && isObj(blob.__DEFAULT_SCOPE__) ? blob.__DEFAULT_SCOPE__ : null;
  const d = scope ? scope["webapp.video-detail"] : null;
  if (!isObj(d)) return undefined;
  const it = isObj(d.itemInfo) && isObj(d.itemInfo.itemStruct) ? d.itemInfo.itemStruct : null;
  const loc = it ? str(it.locationCreated) : null;
  return loc ? loc.toUpperCase() : null;
}

/** TikTok over plain HTTPS: browser UA, Brazil (pt-BR), one cookie jar (WAF + ttwid) for the session. */
export class TikTok {
  private readonly jar = new Map<string, string>();
  /** A visitor's device id for this session (19 digits), as the web app sends it. */
  private readonly deviceId = `73${String(Date.now()).padStart(13, "0")}${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
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

  private async once(url: string, accept: string, extra: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      const headers: Record<string, string> = { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9", Accept: accept, ...extra };
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
  private async get(url: string, accept = "text/html,application/xhtml+xml,*/*;q=0.8", extra: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    let res = await this.once(url, accept, extra);
    if (!isChallenge(res.body)) return res;
    const cookies = solveWaf(res.body);
    if (!cookies) throw new Error("TikTok challenge could not be solved");
    for (const [k, v] of Object.entries(cookies)) this.jar.set(k, v);
    await this.sleep(1500);
    res = await this.once(url, accept, extra);
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

  /** Where the video at `videoUrl` was made ("BR"); null when its page doesn't say. */
  async madeIn(videoUrl: string): Promise<string | null> {
    const u = new URL(videoUrl, TT_ORIGIN);
    if (u.origin !== TT_ORIGIN || !/^\/@[^/]+\/video\/\d+$/.test(u.pathname)) throw new Error("not a TikTok video link");
    const r = await this.get(u.toString());
    if (r.status === 404) return null;
    if (r.status >= 400) throw new Error(`TikTok video HTTP ${r.status}`);
    const c = ttParseVideoCountry(r.body);
    if (c === undefined) throw new Error("could not read the TikTok video page");
    return c;
  }

  async profile(handle: string): Promise<Profile> {
    const h = bare(handle);
    if (!h) throw new Error("not found");
    const r = await this.get(`${TT_ORIGIN}/@${encodeURIComponent(h)}?lang=en`);
    if (r.status === 404) throw new Error("not found");
    if (r.status >= 400) throw new Error(`TikTok HTTP ${r.status}`);
    const d = ttParseUserDetail(r.body);
    if (!d) {
      // The page came without the account (TikTok holds it back for a while after many reads, while its embed and
      // video pages still answer): the embed page has the rest (bio, rounded counts, the newest videos).
      const e = await this.embed(h).catch(() => null);
      if (e?.profile && !e.error) return e.profile;
      throw new Error("could not read TikTok profile data");
    }
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

  /** A hashtag's id (`/api/challenge/detail/`, unsigned); null when TikTok has no such tag. */
  async tagId(tag: string): Promise<string | null> {
    const r = await this.get(`${TT_ORIGIN}/api/challenge/detail/?aid=1988&challengeName=${encodeURIComponent(tag)}`, JSON_ACCEPT, { Referer: `${TT_ORIGIN}/tag/${encodeURIComponent(tag)}` });
    if (r.status >= 400) throw new Error(`TikTok hashtag HTTP ${r.status}`);
    if (!r.body.trim()) throw new Error("TikTok hashtag refused (empty answer)");
    let j: unknown;
    try {
      j = JSON.parse(r.body);
    } catch {
      throw new Error("TikTok hashtag: not JSON");
    }
    const ch = isObj(j) && isObj(j.challengeInfo) && isObj(j.challengeInfo.challenge) ? j.challengeInfo.challenge : null;
    return ch ? (str(ch.id) ?? (typeof ch.id === "number" ? String(ch.id) : null)) : null;
  }

  /** One page (30) of a hashtag's videos, signed with X-Bogus; the next cursor (null at the end). */
  async tagPage(tag: string, id: string, cursor: string): Promise<{ hits: Hit[]; next: string | null }> {
    const p = ttWebParams(this.deviceId, { challengeID: id, count: "30", coverFormat: "2", cursor, from_page: "hashtag" });
    const ms = this.jar.get("msToken");
    if (ms) p.msToken = ms;
    const q = new URLSearchParams(p).toString();
    const r = await this.get(`${TT_ORIGIN}/api/challenge/item_list/?${q}&X-Bogus=${xBogus(q, UA)}`, JSON_ACCEPT, { Referer: `${TT_ORIGIN}/tag/${encodeURIComponent(tag)}` });
    if (r.status === 429) throw new Error("TikTok asked to slow down (429)");
    if (r.status >= 400) throw new Error(`TikTok videos HTTP ${r.status}`);
    if (!r.body.trim()) throw new Error("TikTok videos refused (empty answer)");
    let j: unknown;
    try {
      j = JSON.parse(r.body);
    } catch {
      throw new Error("TikTok videos: not JSON");
    }
    const code = isObj(j) ? (num(j.statusCode) ?? num(j.status_code)) : null;
    if (code) throw new Error(`TikTok videos status ${code}`);
    const o = isObj(j) ? j : {};
    const next = o.hasMore === true && (str(o.cursor) ?? (typeof o.cursor === "number" ? String(o.cursor) : null));
    return { hits: ttParseItemList(j), next: next || null };
  }

  /**
   * Creators through videos: the term's hashtag (#dresstoimpress for "dress to impress"), page by page in TikTok's
   * order, then the hashtags of the search box's suggestions that contain the term's first word. Yields each page's
   * creators not seen before (one per creator, with the video that led there). `maxQueries` caps the pages (40).
   */
  async *discover(query: string, o: DiscoverOpts): AsyncGenerator<Hit[]> {
    const q0 = query.trim().replace(/\s+/g, " ");
    const first = ttTagOf(q0);
    if (!first) return;
    const max = o.maxQueries ?? 40;
    const seen = new Set<string>();
    const tags = [first];
    let pages = 0;
    let failures = 0;
    let suggested = false;
    for (let t = 0; t < tags.length && pages < max && !o.stopped(); t++) {
      const tag = tags[t]!;
      try {
        // The tag's page first, as a visitor would: the jar gets its cookies (msToken comes with the API answers).
        if (!this.jar.has("ttwid")) await this.get(`${TT_ORIGIN}/tag/${encodeURIComponent(tag)}`);
        const id = await this.tagId(tag);
        if (!id) o.log(`TikTok has no #${tag}.`);
        let cursor: string | null = id ? "0" : null;
        while (cursor !== null && pages < max && !o.stopped()) {
          await o.sleep(2000);
          if (o.stopped()) return;
          pages++;
          const { hits, next } = await this.tagPage(tag, id!, cursor);
          failures = 0;
          const fresh = hits.filter((h) => {
            const k = h.handle.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          o.log(`TikTok #${tag}, page ${pages}: ${hits.length} creators, ${fresh.length} new, ${fresh.filter((h) => h.pt).length} in Portuguese.`);
          if (fresh.length) yield fresh;
          cursor = next;
        }
      } catch (e) {
        o.log(`TikTok #${tag}: ${(e as Error).message}`);
        if (++failures >= 3) return;
      }
      if (t === tags.length - 1 && !suggested && !o.stopped()) {
        suggested = true;
        try {
          const word = q0.split(" ")[0]!.toLowerCase();
          for (const w of (await this.suggest(q0)).words) {
            const tg = ttTagOf(w);
            if (tg && w.toLowerCase().includes(word) && !tags.includes(tg) && tags.length < 4) tags.push(tg);
          }
        } catch (e) {
          o.log(`TikTok suggestions: ${(e as Error).message}`);
        }
      }
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
