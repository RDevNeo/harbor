// What Collector's screens draw, computed once for the PC window and the phone (GET v1/collector): the settings, the
// sources (with why one isn't available), the run's progress, the log's tail and the result rows, newest first.
import { avatarKey } from "./avatar-key.ts";
import { CREATOR_SOURCES, GAP_CHOICES, SERVER_MODES, type CollectorData, type CreatorRecord, type ServerRecord } from "./lib/types.ts";

export interface DiscordInfo {
  connected: boolean;
  /** Who's signed in (the Stores Discord account, as Persons shows it). */
  account: string | null;
}

export interface RowView {
  /** creators: "<platform>:<platform_id>"; servers: the invite URL. */
  id: string;
  name: string;
  sub: string;
  stats: string;
  meta: string;
  url: string;
  /** The picture on the internet; `avatarPath` the cached copy on the PC (null until fetched), `avatarId` for the phone. */
  avatarUrl: string | null;
  avatarPath: string | null;
  avatarId: string | null;
  /** The creator links to a Discord server (a stronger lead, as the CRM flags it). */
  discord: boolean;
  links: number;
  platform: string;
}

const LOG_TAIL = 120;
const ROWS_MAX = 1000;

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const a = Math.abs(n);
  const f = (v: number, s: string): string => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${s}`;
  if (a >= 1e9) return f(n / 1e9, "B");
  if (a >= 1e6) return f(n / 1e6, "M");
  if (a >= 1e3) return f(n / 1e3, "K");
  return String(n);
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = (now - t) / 86_400_000;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 60) return `${Math.round(d)} days ago`;
  return `${Math.round(d / 30)} months ago`;
}

const PLATFORM_LABEL: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };

export function creatorRow(c: CreatorRecord, pic: (url: string | null) => string | null, now = Date.now()): RowView {
  const stats = [
    c.subscriber_count === null ? "hidden subs" : `${compact(c.subscriber_count)} ${c.platform === "youtube" ? "subs" : "followers"}`,
    c.video_count === null ? "" : `${compact(c.video_count)} videos`,
    c.view_count === null ? "" : `${compact(c.view_count)} views`,
  ].filter(Boolean);
  const last = c.recent_videos?.[0]?.published_at ?? null;
  const discord = c.links.some((l) => /discord\.(gg|com\/invite)/i.test(l.url)) || /discord\.gg\//i.test(c.description ?? "");
  return {
    id: `${c.platform}:${c.platform_id}`,
    name: c.name,
    sub: [c.handle ?? "", c.country ?? ""].filter(Boolean).join(" · "),
    stats: stats.join(" · "),
    meta: [last ? `uploaded ${ago(last, now)}` : "", c.links.length ? `${c.links.length} link${c.links.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "),
    url: c.profile_url ?? "",
    avatarUrl: c.avatar_url,
    avatarPath: pic(c.avatar_url),
    avatarId: c.avatar_url ? avatarKey(c.avatar_url) : null,
    discord,
    links: c.links.length,
    platform: PLATFORM_LABEL[c.platform] ?? c.platform,
  };
}

export function serverRow(s: ServerRecord, pic: (url: string | null) => string | null): RowView {
  return {
    id: s.invite,
    name: s.name ?? s.invite.replace(/^https:\/\//, ""),
    sub: s.invite.replace(/^https:\/\//, ""),
    stats: [s.members === null ? "" : `${compact(s.members)} members`, s.online === null ? "" : `${compact(s.online)} online`].filter(Boolean).join(" · "),
    meta: s.source,
    url: s.invite,
    avatarUrl: s.icon_url,
    avatarPath: pic(s.icon_url),
    avatarId: s.icon_url ? avatarKey(s.icon_url) : null,
    discord: true,
    links: 0,
    platform: "Discord",
  };
}

export function buildView(d: CollectorData, rev: number, discord: DiscordInfo, pic: (url: string | null) => string | null, now = Date.now()): unknown {
  const s = d.settings;
  const run = d.run;
  return {
    rev,
    settings: s,
    sources: CREATOR_SOURCES,
    modes: SERVER_MODES,
    gaps: GAP_CHOICES,
    discord: { connected: discord.connected, account: discord.account },
    run: run
      ? {
          ...run,
          elapsed: Math.max(0, Math.round(((run.running ? now : run.endedAt || now) - run.startedAt) / 1000)),
        }
      : null,
    log: d.log.slice(-LOG_TAIL),
    counts: { creators: d.creators.length, servers: d.servers.length },
    creators: d.creators.slice(-ROWS_MAX).reverse().map((c) => creatorRow(c, pic, now)),
    servers: d.servers.slice(-ROWS_MAX).reverse().map((x) => serverRow(x, pic)),
  };
}
