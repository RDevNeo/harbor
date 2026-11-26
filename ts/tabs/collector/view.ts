// What Collector's screens draw, computed once for the PC window and the phone (GET v1/collector, GET …/creator): the
// settings, the sources (with why one can't run), the run's progress, the daily update, the log's tail, the result rows
// (newest first) and, for one creator, everything known about them.
import { avatarKey } from "./avatar-key.ts";
import { ago, compactCount, dayAgo } from "./lib/format.ts";
import { kindLabel, kindOf } from "./lib/links.ts";
import { GAP_CHOICES, PLATFORM_LABEL, type CollectorData, type CreatorPlatform, type CreatorRecord } from "./lib/types.ts";

export { compactCount as compact } from "./lib/format.ts";

export interface SourceInfo {
  value: CreatorPlatform;
  label: string;
  available: boolean;
  /** Why not, when it isn't; how it works, when it is. */
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

export interface RowView {
  /** "<platform>:<platform_id>". */
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
  email: string;
  emailSource: string;
  /** "Updated 3 h ago" (the daily update), or why it couldn't. */
  updated: string;
  /** The last update's changes, short ("Subscribers 12K → 13K"), when it was within a day and a half. */
  changed: string;
  /** "Emailed 25 Nov". */
  contacted: string;
}

const LOG_TAIL = 120;
const ROWS_MAX = 1000;
const CHANGED_FRESH_MS = 36 * 3_600_000;

const shortDate = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function statsOf(c: CreatorRecord): string {
  const followers = c.platform === "youtube" ? "subs" : "followers";
  return [
    c.subscriber_count === null ? `hidden ${followers}` : `${compactCount(c.subscriber_count)} ${followers}`,
    c.video_count === null ? "" : `${compactCount(c.video_count)} ${c.platform === "instagram" ? "posts" : "videos"}`,
    c.view_count === null ? "" : `${compactCount(c.view_count)} ${c.platform === "tiktok" ? "likes" : "views"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function creatorRow(c: CreatorRecord, pic: (url: string | null) => string | null, now = Date.now()): RowView {
  const last = c.last_upload_at ?? c.recent_videos?.[0]?.published_at ?? null;
  const discord = c.links.some((l) => /discord\.(gg|com\/invite)/i.test(l.url)) || /discord\.gg\//i.test(c.description ?? "");
  const h = c.history?.[0];
  const changed = h && now - Date.parse(h.at) < CHANGED_FRESH_MS ? h.changes.map((x) => (x.from && x.to ? `${x.field} ${x.from} → ${x.to}` : x.to ? `${x.field}: ${x.to}` : `${x.field}: ${x.from}`)).join(" · ") : "";
  return {
    id: `${c.platform}:${c.platform_id}`,
    name: c.name,
    sub: [c.handle ?? "", c.country ?? ""].filter(Boolean).join(" · "),
    stats: statsOf(c),
    meta: [last ? `${c.platform === "instagram" ? "posted" : "uploaded"} ${dayAgo(last, now)}` : "", c.links.length ? `${c.links.length} link${c.links.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "),
    url: c.profile_url ?? "",
    avatarUrl: c.avatar_url,
    avatarPath: pic(c.avatar_url),
    avatarId: c.avatar_url ? avatarKey(c.avatar_url) : null,
    discord,
    links: c.links.length,
    platform: PLATFORM_LABEL[c.platform as CreatorPlatform] ?? c.platform,
    email: c.email ?? "",
    emailSource: c.email ? (c.email_manual ? "typed" : (c.email_source ?? "")) : "",
    updated: c.update_error ? `Update failed: ${c.update_error}` : c.updated_at ? `Updated ${ago(c.updated_at, now)}` : "",
    changed,
    contacted: c.contacted ? `${c.contacted.via === "whatsapp" ? "WhatsApp sent" : "Emailed"} ${shortDate(c.contacted.at)}` : "",
  };
}

/** Everything about one creator (the details pane, the phone's creator screen). */
export function creatorDetail(c: CreatorRecord, pic: (url: string | null) => string | null, now = Date.now()): unknown {
  const row = creatorRow(c, pic, now);
  const stats: { label: string; value: string }[] = [
    { label: c.platform === "youtube" ? "Subscribers" : "Followers", value: c.subscriber_count === null ? "hidden" : compactCount(c.subscriber_count) },
    ...(c.video_count === null ? [] : [{ label: c.platform === "instagram" ? "Posts" : "Videos", value: compactCount(c.video_count) }]),
    ...(c.view_count === null ? [] : [{ label: c.platform === "tiktok" ? "Likes" : "Views", value: compactCount(c.view_count) }]),
    ...(c.last_upload_at ? [{ label: c.platform === "instagram" ? "Last post" : "Last upload", value: dayAgo(c.last_upload_at, now) }] : []),
  ];
  return {
    ...row,
    handle: c.handle ?? "",
    country: c.country ?? "",
    description: c.description ?? "",
    stats,
    links: c.links.map((l) => {
      const k = kindOf(l.url);
      return { label: l.label || kindLabel(k), url: l.url, kind: k, kindLabel: kindLabel(k), source: l.source ?? "", short: l.url.replace(/^https?:\/\//, "").replace(/\/$/, "") };
    }),
    emailManual: !!c.email_manual,
    whatsapp: c.whatsapp ?? "",
    updateError: c.update_error ?? "",
    updatedAt: c.updated_at ?? "",
    history: (c.history ?? []).map((h) => ({
      when: `${shortDate(h.at)} · ${ago(h.at, now)}`,
      changes: h.changes.map((x) => (x.from && x.to ? `${x.field}: ${x.from} → ${x.to}` : x.to ? `${x.field}: ${x.to}` : `${x.field}: ${x.from}`)),
    })),
    recent: (c.recent_videos ?? []).map((v) => ({ title: v.title ?? "", url: v.url, when: dayAgo(v.published_at, now), views: v.view_count === null ? "" : `${compactCount(v.view_count)} views` })),
    contactedAt: c.contacted?.at ?? "",
    contactedVia: c.contacted?.via ?? "",
    contactedTo: c.contacted?.to ?? "",
    found: `Found ${shortDate(c.captured_at)} with "${c.discovered_via}"`,
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
  const r = d.refresh;
  const due = d.creators.filter((c) => {
    const t = Date.parse(c.updated_at ?? c.captured_at);
    return !Number.isFinite(t) || now - t >= 23 * 3_600_000;
  }).length;
  const next = d.settings.daily && r.lastFullAt ? r.lastFullAt + 86_400_000 : 0;
  return {
    rev,
    settings: d.settings,
    sources: x.sources,
    sessions: x.sessions,
    canSend: x.canSend,
    gaps: GAP_CHOICES,
    run: run ? { ...run, elapsed: Math.max(0, Math.round(((run.running ? now : run.endedAt || now) - run.startedAt) / 1000)) } : null,
    refresh: {
      ...r,
      due,
      daily: d.settings.daily,
      last: r.lastFullAt ? ago(r.lastFullAt, now) : "",
      next: next ? (next <= now ? "soon" : `in ${Math.max(1, Math.round((next - now) / 3_600_000))} h`) : "",
    },
    log: d.log.slice(-LOG_TAIL),
    counts: { creators: d.creators.length, emails: d.creators.filter((c) => c.email).length, contacted: d.creators.filter((c) => c.contacted).length, remembered: d.seen.length },
    creators: d.creators.slice(-ROWS_MAX).reverse().map((c) => creatorRow(c, pic, now)),
  };
}
