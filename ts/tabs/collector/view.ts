// What Collector's screens draw, computed once for the PC window and the phone (GET v1/collector): the settings, the
// sources (with why one can't run), the run (one line while it goes, its leads), and every lead as a simple card:
// picture, name and handle, platform, profile link, email (and where it came from), the 3 newest videos, Restricted.
import { avatarKey } from "./avatar-key.ts";
import { compactCount, dayAgo } from "./lib/format.ts";
import { brandOf, linkTitle, linksText, REACH_META, reachDrafts, reachHref, reachStart } from "./lib/reach.ts";
import { GAP_CHOICES, PLATFORM_LABEL, type CollectorData, type CreatorPlatform, type CreatorRecord, type ReachKind } from "./lib/types.ts";

export { compactCount as compact } from "./lib/format.ts";

export interface SourceInfo {
  value: CreatorPlatform;
  label: string;
  available: boolean;
  /** Why not, when it isn't; how it searches, when it is. */
  why: string;
  note: string;
}

export interface SessionInfo {
  platform: "instagram";
  label: string;
  connected: boolean;
  account: string | null;
  savedAt: number;
  /** What it's for and how to get it. */
  help: string;
}

export interface VideoView {
  url: string;
  title: string;
  /** The thumbnail's cached copy on the PC (null until fetched); `thumbId` for the phone. */
  thumbPath: string | null;
  thumbId: string | null;
}

export interface RowView {
  /** "<platform>:<platform_id>". */
  id: string;
  name: string;
  /** "@handle" (or "" when the platform gave none). */
  handle: string;
  platform: string;
  url: string;
  /** The profile URL without its scheme ("youtube.com/@x"). */
  short: string;
  /** The picture's cached copy on the PC (null until fetched), `avatarId` for the phone. */
  avatarPath: string | null;
  avatarId: string | null;
  email: string;
  /** "typed", "YouTube About", "linktr.ee/x"… */
  emailSource: string;
  videos: VideoView[];
  restricted: boolean;
  /** The Reach kind picked in the detail ("email", "discord", "whatsapp", "instagram"), "" when none: its icon on the card. */
  reach: string;
  reachValue: string;
}

const ROWS_MAX = 2000;

export function creatorRow(c: CreatorRecord, pic: (url: string | null) => string | null): RowView {
  const handle = c.handle ? (c.handle.startsWith("@") ? c.handle : `@${c.handle}`) : "";
  const url = c.profile_url ?? "";
  return {
    id: `${c.platform}:${c.platform_id}`,
    name: c.name,
    handle,
    platform: PLATFORM_LABEL[c.platform as CreatorPlatform] ?? c.platform,
    url,
    short: url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""),
    avatarPath: pic(c.avatar_url),
    avatarId: c.avatar_url ? avatarKey(c.avatar_url) : null,
    email: c.email ?? "",
    emailSource: c.email ? (c.email_manual ? "typed" : (c.email_source ?? "")) : "",
    videos: (c.recent_videos ?? []).slice(0, 3).map((v) => ({
      url: v.url,
      title: v.title ?? "",
      thumbPath: pic(v.thumbnail_url),
      thumbId: v.thumbnail_url ? avatarKey(v.thumbnail_url) : null,
    })),
    restricted: !!c.restricted,
    reach: c.reach?.kind ?? "",
    reachValue: c.reach?.value ?? "",
  };
}

export interface StatView {
  /** "users", "video", "eye", "heart". */
  icon: string;
  value: string;
  label: string;
}

export interface DetailVideo extends VideoView {
  /** "yesterday · 22K views". */
  meta: string;
  short: boolean;
}

export interface DetailLink {
  title: string;
  url: string;
  /** brandOf's key: "discord", "instagram", "youtube", "tiktok", "twitch", "x", "whatsapp", "email", "link". */
  brand: string;
  color: string;
}

/** A lead's detail (the CRM's creator profile dialog): everything Collector gathered, plus Reach and Edit. */
export interface DetailView extends RowView {
  /** "youtube", "tiktok", "instagram". */
  platformKey: string;
  hasContact: boolean;
  /** Only the tiles with data: YouTube subscribers, videos, views; TikTok followers, videos, likes; Instagram followers, posts. */
  stats: StatView[];
  /** The 3 newest, newest first. */
  recent: DetailVideo[];
  bio: string;
  /** The search term that found them ("" when not recorded). */
  foundVia: string;
  /** The search result that led to them. */
  foundVideo: string;
  reachKind: ReachKind;
  /** Each Reach kind's field: the saved value, else what Collector found. */
  drafts: Record<ReachKind, string>;
  /** The Reach's action button ("Send email", "Send WhatsApp", "Open in Discord", "Open Instagram") and where the
   *  non-message ones open. */
  reachSend: string;
  reachHref: string;
  links: DetailLink[];
  /** "Open channel" (YouTube) or "Open profile". */
  openLabel: string;
  /** "Sent an email on 3 Nov 2026 to a@b.c" when Send message reached them. */
  contacted: string;
  /** Edit's fields as they are. */
  edit: { name: string; handle: string; bio: string; links: string };
}

const STAT_LABELS: Record<string, [string, string, string, string]> = {
  youtube: ["Subscribers", "Videos", "Views", "eye"],
  tiktok: ["Followers", "Videos", "Likes", "heart"],
  instagram: ["Followers", "Posts", "Views", "eye"],
};

export function creatorDetail(c: CreatorRecord, pic: (url: string | null) => string | null, now = Date.now()): DetailView {
  const row = creatorRow(c, pic);
  const L = STAT_LABELS[c.platform] ?? STAT_LABELS.youtube!;
  const stats: StatView[] = [];
  if (c.subscriber_count !== null && c.subscriber_count !== undefined) stats.push({ icon: "users", value: compactCount(c.subscriber_count), label: L[0] });
  if (c.video_count !== null && c.video_count !== undefined) stats.push({ icon: "video", value: compactCount(c.video_count), label: L[1] });
  if (c.view_count !== null && c.view_count !== undefined) stats.push({ icon: L[3], value: compactCount(c.view_count), label: L[2] });
  const recent = (c.recent_videos ?? []).slice(0, 3).map(
    (v): DetailVideo => ({
      url: v.url,
      title: v.title ?? "",
      thumbPath: pic(v.thumbnail_url),
      thumbId: v.thumbnail_url ? avatarKey(v.thumbnail_url) : null,
      meta: [dayAgo(v.published_at, now), v.view_count !== null && v.view_count !== undefined ? `${compactCount(v.view_count)} views` : ""].filter(Boolean).join(" · "),
      short: !!v.is_short,
    }),
  );
  const kind = reachStart(c);
  const href = c.reach ? reachHref(c.reach) : null;
  const ct = c.contacted;
  return {
    ...row,
    platformKey: c.platform,
    hasContact: !!(c.email || c.whatsapp || c.reach),
    stats,
    recent,
    bio: c.description ?? "",
    foundVia: c.discovered_via ?? "",
    foundVideo: c.found_video ?? "",
    reachKind: kind,
    drafts: reachDrafts(c),
    reachSend: c.reach ? REACH_META[c.reach.kind].send : "",
    reachHref: href ?? "",
    links: c.links.map((l) => {
      const b = brandOf(l);
      return { title: linkTitle(l), url: l.url, brand: b.key, color: b.color };
    }),
    openLabel: c.platform === "youtube" ? "Open channel" : "Open profile",
    contacted: ct ? `Sent ${ct.via === "gmail" ? "an email" : "a WhatsApp message"} on ${new Date(ct.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} to ${ct.to}` : "",
    edit: { name: c.name, handle: c.handle ?? "", bio: c.description ?? "", links: linksText(c.links) },
  };
}

export interface ViewExtras {
  sources: SourceInfo[];
  sessions: SessionInfo[];
  /** Persons › Creators can send (a signed-in Gmail or WhatsApp there). */
  canSend: boolean;
}

export function buildView(d: CollectorData, rev: number, x: ViewExtras, pic: (url: string | null) => string | null, now = Date.now()): unknown {
  const run = d.run;
  const rows = d.creators
    .slice(-ROWS_MAX)
    .reverse()
    .map((c) => creatorRow(c, pic));
  const restricted = rows.filter((r) => r.restricted).length;
  return {
    rev,
    settings: d.settings,
    sources: x.sources,
    sessions: x.sessions,
    canSend: x.canSend,
    gaps: GAP_CHOICES,
    run: run
      ? {
          running: run.running,
          label: run.label,
          platform: run.platform,
          query: run.query,
          found: run.found,
          target: run.target,
          known: run.known,
          line: run.running ? run.line : "",
          status: run.status,
          ids: run.ids,
          elapsed: Math.max(0, Math.round(((run.running ? now : run.endedAt || now) - run.startedAt) / 1000)),
        }
      : null,
    counts: { available: rows.length - restricted, restricted },
    unseen: d.unseen,
    creators: rows,
  };
}
