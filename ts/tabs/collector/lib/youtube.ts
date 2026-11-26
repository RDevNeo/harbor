// YouTube, as the userscript reads it (lead-collector.user.js, "YouTube creator collection"), from Hub's engine instead of
// a youtube.com tab: the search pages' `ytInitialData`, innertube's search continuations, each channel's Atom feed (the
// freshness gate: absolute ISO dates, ~21KB) and its About data (stats and profile links). Public data, no login.
// The parsing is the userscript's, line for line where it could be; only the transport changed (no `window.ytcfg`: the
// innertube key and client version come from the first search page's HTML).
import type { CreatorLink, RecentVideo } from "./types.ts";

export const YT_SORT = { RELEVANCE: 0, DATE: 1, RATING: 2, VIEWS: 3 } as const;
export const YT_UPLOADED = { TODAY: 1, WEEK: 3, MONTH: 4 } as const;
export const YT_TYPE = { VIDEO: 1, CHANNEL: 2 } as const;

export interface SearchFilter {
  sort?: number;
  uploaded?: number;
  type?: number;
}

/** The `sp` param: a 4-byte protobuf (field 1 sort; field 2 {1 upload date, 2 type}), base64'd. `{type: CHANNEL}` → `EgIQAg%3D%3D`. */
export function ytSearchParam({ sort, uploaded, type }: SearchFilter = {}): string {
  const bytes: number[] = [];
  if (sort) bytes.push(0x08, sort);
  const filters: number[] = [];
  if (uploaded) filters.push(0x08, uploaded);
  if (type) filters.push(0x10, type);
  if (filters.length) bytes.push(0x12, filters.length, ...filters);
  return encodeURIComponent(btoa(String.fromCharCode(...bytes)));
}

type Node = unknown;
const isObj = (n: Node): n is Record<string, unknown> => !!n && typeof n === "object";

/** Depth-first: the first value under `key` (renderer names are stable, their nesting isn't). */
export function ytFind(node: Node, key: string, depth = 0): unknown {
  if (!isObj(node) || depth > 45) return null;
  if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const f = ytFind(v, key, depth + 1);
    if (f) return f;
  }
  return null;
}

export function ytCollect(node: Node, key: string, out: unknown[] = [], depth = 0): unknown[] {
  if (!isObj(node) || depth > 45) return out;
  if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
  for (const v of Array.isArray(node) ? node : Object.values(node)) ytCollect(v, key, out, depth + 1);
  return out;
}

/** {simpleText}, {runs:[{text}]}, {content} or a bare string. */
export function ytText(node: Node): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (!isObj(node)) return "";
  if (typeof node.simpleText === "string") return node.simpleText;
  if (typeof node.content === "string") return node.content;
  if (Array.isArray(node.runs)) return node.runs.map((r) => (isObj(r) && typeof r.text === "string" ? r.text : "")).join("");
  return "";
}

/** "mil" is a thousand (pt/es) and must win over the million prefixes; "3.15 million" and "3.15M" both read. */
export function ytMultiplier(suffix: string): number {
  if (!suffix) return 1;
  if (suffix === "mil" || suffix === "k" || suffix === "tsd") return 1e3;
  if (suffix.startsWith("thousand")) return 1e3;
  if (suffix === "b" || suffix === "bn" || suffix === "mrd") return 1e9;
  if (suffix.startsWith("bi") || suffix.startsWith("bill") || suffix.startsWith("bilh")) return 1e9;
  if (suffix === "m" || suffix === "mi" || suffix === "mio") return 1e6;
  if (suffix.startsWith("mill") || suffix.startsWith("milh") || suffix.startsWith("mio")) return 1e6;
  return 1;
}

/** A localized compact count ("3.15M subscribers", "1,2 mi de inscritos", "440,004,410 views"); null (not 0) when absent. */
export function ytParseCount(raw: Node): number | null {
  const text = ytText(raw).trim();
  if (!text) return null;
  const m = text.match(/([\d][\d.,\s ]*)\s*([a-zA-Zµ]*)/);
  if (!m) return null;
  let digits = (m[1] ?? "").replace(/[\s ]/g, "");
  const suffix = (m[2] ?? "").toLowerCase();
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const at = Math.max(lastComma, lastDot);
    digits = digits.slice(0, at).replace(/[.,]/g, "") + "." + digits.slice(at + 1);
  } else if (lastComma >= 0 || lastDot >= 0) {
    const at = Math.max(lastComma, lastDot);
    const tail = digits.length - at - 1;
    digits = tail <= 2 ? digits.slice(0, at) + "." + digits.slice(at + 1) : digits.replace(/[.,]/g, "");
  }
  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * ytMultiplier(suffix));
}

/** YouTube's `/redirect?q=<target>` wrapper, unwrapped. */
export function ytUnwrapRedirect(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url, "https://www.youtube.com");
    if (u.pathname === "/redirect") {
      const q = u.searchParams.get("q");
      if (q) return q;
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** One About link's real URL: the tap command's, not `link.content` (display text only). */
export function ytLinkUrl(entry: Node): string {
  const link = isObj(entry) && isObj(entry.link) ? entry.link : null;
  const run = link && Array.isArray(link.commandRuns) ? link.commandRuns[0] : null;
  const cmd = isObj(run) && isObj(run.onTap) && isObj(run.onTap.innertubeCommand) ? run.onTap.innertubeCommand : null;
  const urlEndpoint = cmd && isObj(cmd.urlEndpoint) ? cmd.urlEndpoint : null;
  const meta = cmd && isObj(cmd.commandMetadata) && isObj(cmd.commandMetadata.webCommandMetadata) ? cmd.commandMetadata.webCommandMetadata : null;
  const raw = (urlEndpoint && typeof urlEndpoint.url === "string" && urlEndpoint.url) || (meta && typeof meta.url === "string" && meta.url) || "";
  if (raw) return ytUnwrapRedirect(raw);
  const shown = link && typeof link.content === "string" ? link.content : "";
  if (!shown) return "";
  return shown.includes("://") ? shown : `https://${shown}`;
}

export function ytExtractInitialData(html: string): unknown {
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) ?? html.match(/ytInitialData"\]\s*=\s*(\{.+?\});/s) ?? html.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

/** The page's innertube settings (what `window.ytcfg` gives the userscript). */
export interface YtConfig {
  apiKey: string | null;
  clientVersion: string;
  hl: string;
  gl: string;
  visitorData: string | null;
}

export function ytExtractConfig(html: string): YtConfig {
  const get = (k: string): string | null => html.match(new RegExp(`"${k}":"([^"]+)"`))?.[1] ?? null;
  return { apiKey: get("INNERTUBE_API_KEY"), clientVersion: get("INNERTUBE_CLIENT_VERSION") ?? "2.20261125.00.00", hl: get("HL") ?? "en", gl: get("GL") ?? "US", visitorData: get("VISITOR_DATA") };
}

export interface ChannelHit {
  channelId: string;
  name: string;
  handle: string | null;
  profileUrl: string;
  avatarUrl: string | null;
  subscribers: number | null;
  description: string;
}

/** A channel's @handle out of a URL or path; handles may carry accents (percent-encoded in canonical URLs). */
export const handleOf = (s: string): string | null => {
  let t = s;
  try {
    t = decodeURIComponent(s);
  } catch {
    // keep as is
  }
  return t.match(/@[\p{L}\p{N}\p{M}_.·-]+/u)?.[0] ?? null;
};
const httpsOf = (u: string | null): string | null => (u ? (u.startsWith("//") ? `https:${u}` : u) : null);
const lastThumb = (n: Node): string | null => {
  const t = isObj(n) && Array.isArray(n.thumbnails) ? n.thumbnails : [];
  const l = t[t.length - 1];
  return isObj(l) && typeof l.url === "string" ? l.url : null;
};

/**
 * Channel results. The field names lie (checked against live HTML): `subscriberCountText` holds the @handle and
 * `videoCountText` the subscriber count.
 */
export function ytChannelsFromSearch(data: Node): ChannelHit[] {
  const out: ChannelHit[] = [];
  for (const r of ytCollect(data, "channelRenderer")) {
    if (!isObj(r) || typeof r.channelId !== "string") continue;
    const nav = isObj(r.navigationEndpoint) && isObj(r.navigationEndpoint.browseEndpoint) ? r.navigationEndpoint.browseEndpoint : null;
    const canonical = nav && typeof nav.canonicalBaseUrl === "string" ? nav.canonicalBaseUrl : "";
    const handleText = ytText(r.subscriberCountText).trim();
    const vct = isObj(r.videoCountText) ? r.videoCountText : null;
    const acc = vct && isObj(vct.accessibility) && isObj(vct.accessibility.accessibilityData) ? vct.accessibility.accessibilityData.label : null;
    out.push({
      channelId: r.channelId,
      name: ytText(r.title),
      handle: handleOf(canonical) ?? (handleText.startsWith("@") ? handleText : null),
      profileUrl: canonical ? `https://www.youtube.com${canonical}` : `https://www.youtube.com/channel/${r.channelId}`,
      avatarUrl: httpsOf(lastThumb(r.thumbnail)),
      subscribers: ytParseCount(r.videoCountText) ?? ytParseCount(acc),
      description: ytText(r.descriptionSnippet),
    });
  }
  return out;
}

/** Channels through video results' uploaders (videos and Shorts): a different, larger set than the channel filter. */
export function ytUploadersFromSearch(data: Node): ChannelHit[] {
  const out: ChannelHit[] = [];
  const push = (channelId: unknown, name: string, canonical: string | null): void => {
    if (typeof channelId !== "string" || !channelId.startsWith("UC")) return;
    if (out.some((e) => e.channelId === channelId)) return;
    out.push({
      channelId,
      name,
      handle: canonical ? handleOf(canonical) : null,
      profileUrl: canonical ? `https://www.youtube.com${canonical}` : `https://www.youtube.com/channel/${channelId}`,
      avatarUrl: null,
      subscribers: null,
      description: "",
    });
  };
  for (const v of ytCollect(data, "videoRenderer")) {
    if (!isObj(v)) continue;
    const runsOf = (t: unknown): unknown => (isObj(t) && Array.isArray(t.runs) ? t.runs[0] : null);
    const run = runsOf(v.ownerText) ?? runsOf(v.longBylineText);
    const browse = isObj(run) && isObj(run.navigationEndpoint) && isObj(run.navigationEndpoint.browseEndpoint) ? run.navigationEndpoint.browseEndpoint : null;
    push(browse?.browseId, isObj(run) && typeof run.text === "string" ? run.text : "", browse && typeof browse.canonicalBaseUrl === "string" ? browse.canonicalBaseUrl : null);
  }
  for (const s of ytCollect(data, "shortsLockupViewModel")) push(ytFind(s, "browseId"), "", null);
  return out;
}

export interface ChannelAbout {
  name: string | null;
  handle: string | null;
  profileUrl: string | null;
  avatarUrl: string | null;
  subscribers: number | null;
  videos: number | null;
  views: number | null;
  description: string | null;
  country: string | null;
  links: CreatorLink[];
}

/** A channel's About data (`aboutChannelViewModel` + `microformatDataRenderer`) out of its ytInitialData. */
export function ytParseAbout(data: Node): ChannelAbout {
  const about = (ytFind(data, "aboutChannelViewModel") ?? {}) as Record<string, unknown>;
  const micro = (ytFind(data, "microformatDataRenderer") ?? {}) as Record<string, unknown>;
  const links: CreatorLink[] = [];
  for (const w of Array.isArray(about.links) ? about.links : []) {
    const e = isObj(w) ? w.channelExternalLinkViewModel : null;
    if (!e) continue;
    const url = ytLinkUrl(e);
    if (!url || links.some((l) => l.url === url)) continue;
    links.push({ label: ytText(isObj(e) ? e.title : null) || null, url });
  }
  const canonical = String(about.canonicalChannelUrl ?? micro.urlCanonical ?? "").replace(/^http:\/\//, "https://");
  return {
    name: typeof micro.title === "string" ? micro.title : null,
    handle: handleOf(canonical),
    profileUrl: canonical || null,
    avatarUrl: lastThumb(micro.thumbnail),
    subscribers: ytParseCount(about.subscriberCountText),
    videos: ytParseCount(about.videoCountText),
    views: ytParseCount(about.viewCountText),
    description: ytText(about.description) || (typeof micro.description === "string" ? micro.description : null) || null,
    country: typeof about.country === "string" ? about.country : null,
    links,
  };
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXmlText(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e] ?? m;
  });
}

export const YT_RECENT_VIDEO_LIMIT = 3;

/** The Atom feed: the newest entry's time (null: no uploads) and the newest three (the CRM's podium). */
export function ytParseFeed(xml: string): { newest: number | null; videos: RecentVideo[] } {
  let newest = 0;
  const videos: RecentVideo[] = [];
  // Entries only: the document's first <published> is the channel's creation date.
  for (const chunk of xml.split("<entry>").slice(1)) {
    const published = chunk.match(/<published>([^<]+)<\/published>/);
    const time = published ? Date.parse(published[1]!) : NaN;
    if (Number.isFinite(time) && time > newest) newest = time;
    const id = chunk.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!id) continue;
    const title = chunk.match(/<title>([\s\S]*?)<\/title>/);
    const href = chunk.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/);
    const thumb = chunk.match(/<media:thumbnail[^>]+url="([^"]+)"/);
    const views = chunk.match(/<media:statistics[^>]+views="(\d+)"/);
    const url = href ? decodeXmlText(href[1]!) : `https://www.youtube.com/watch?v=${id[1]}`;
    videos.push({
      video_id: id[1]!,
      title: title ? decodeXmlText(title[1]!).trim() || null : null,
      url,
      thumbnail_url: thumb ? thumb[1]! : null,
      published_at: published ? published[1]! : null,
      view_count: views ? Number.parseInt(views[1]!, 10) : null,
      is_short: url.includes("/shorts/"),
    });
  }
  videos.sort((a, b) => (b.published_at ? Date.parse(b.published_at) : 0) - (a.published_at ? Date.parse(a.published_at) : 0));
  return { newest: newest > 0 ? newest : null, videos: videos.slice(0, YT_RECENT_VIDEO_LIMIT) };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const ORIGIN = "https://www.youtube.com";

/** YouTube over plain HTTPS from the engine: no cookies, English UI (counts parse the same everywhere). */
export class YouTube {
  private cfg: YtConfig | null = null;
  constructor(
    private readonly fetchFn: Fetch = fetch,
    private readonly origin = ORIGIN,
  ) {}

  private headers(json = false): Record<string, string> {
    // CONSENT: skips the EU cookie wall, which otherwise answers every page with a consent form.
    const h: Record<string, string> = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async html(path: string): Promise<string> {
    const r = await this.fetchFn(this.origin + path, { headers: this.headers(), signal: AbortSignal.timeout(25_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }

  /** One search page for a pass (`filter` its sp spec). */
  async search(query: string, filter: SearchFilter): Promise<unknown> {
    const sp = ytSearchParam(filter);
    const html = await this.html(`/results?search_query=${encodeURIComponent(query)}&hl=en${sp ? `&sp=${sp}` : ""}`);
    this.cfg ??= ytExtractConfig(html);
    const data = ytExtractInitialData(html);
    if (!data) throw new Error("could not read YouTube search data");
    return data;
  }

  /** The next page of a search (innertube); null when the page gave no key to ask with. */
  async continuation(token: string): Promise<unknown> {
    const c = this.cfg;
    if (!c) return null;
    const r = await this.fetchFn(`${this.origin}/youtubei/v1/search${c.apiKey ? `?key=${c.apiKey}&prettyPrint=false` : "?prettyPrint=false"}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: c.clientVersion, hl: "en", gl: c.gl, ...(c.visitorData ? { visitorData: c.visitorData } : {}) } }, continuation: token }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!r.ok) throw new Error(`continuation HTTP ${r.status}`);
    return r.json();
  }

  async feed(channelId: string): Promise<{ newest: number | null; videos: RecentVideo[] }> {
    const r = await this.fetchFn(`${this.origin}/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
    return ytParseFeed(await r.text());
  }

  async about(channelId: string): Promise<ChannelAbout> {
    const data = ytExtractInitialData(await this.html(`/channel/${channelId}/about?hl=en`));
    if (!data) throw new Error("could not read channel data");
    return ytParseAbout(data);
  }
}
