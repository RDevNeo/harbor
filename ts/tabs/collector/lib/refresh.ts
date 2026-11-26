// The daily update: every collected creator read again (stats, last upload, bio, links, email), what changed written
// down. A typed email is never replaced; a found one only when there was none or the old one's gone from everywhere.
import { compactCount } from "./format.ts";
import type { Change, CreatorLink, CreatorRecord, RecentVideo } from "./types.ts";

/** What a platform answers for one creator today. */
export interface Fresh {
  name: string | null;
  handle: string | null;
  profile_url: string | null;
  avatar_url: string | null;
  subscriber_count: number | null;
  video_count: number | null;
  view_count: number | null;
  description: string | null;
  links: CreatorLink[];
  country: string | null;
  last_upload_at: string | null;
  recent_videos?: RecentVideo[];
}

export const HISTORY_KEEP = 10;
/** A creator is due when its last update is older than this (a day, less an hour of slack for the pass's own length). */
export const DUE_AFTER_MS = 23 * 3_600_000;
export const REFRESH_DELAY_MS = 2500;

const COUNT_FIELDS: { key: "subscriber_count" | "video_count" | "view_count"; label: (p: string) => string }[] = [
  { key: "subscriber_count", label: (p) => (p === "youtube" ? "Subscribers" : "Followers") },
  { key: "video_count", label: (p) => (p === "instagram" ? "Posts" : "Videos") },
  { key: "view_count", label: (p) => (p === "tiktok" ? "Likes" : "Views") },
];

const short = (s: string | null | undefined, n = 60): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

/** What differs between the record and today's answer, as shown in the creator's history. */
export function diffFresh(rec: CreatorRecord, fresh: Fresh, links: CreatorLink[], email: string | null): Change[] {
  const out: Change[] = [];
  for (const f of COUNT_FIELDS) {
    const a = rec[f.key];
    const b = fresh[f.key];
    if (b !== null && a !== b && compactCount(a) !== compactCount(b)) out.push({ field: f.label(rec.platform), from: a === null ? "hidden" : compactCount(a), to: compactCount(b) });
  }
  if (fresh.last_upload_at && day(fresh.last_upload_at) !== day(rec.last_upload_at)) out.push({ field: rec.platform === "instagram" ? "Last post" : "Last upload", from: day(rec.last_upload_at) || "none", to: day(fresh.last_upload_at) });
  if (fresh.name && fresh.name !== rec.name) out.push({ field: "Name", from: rec.name, to: fresh.name });
  if (fresh.handle && fresh.handle !== rec.handle) out.push({ field: "Handle", from: rec.handle ?? "", to: fresh.handle });
  if ((fresh.description ?? "") !== (rec.description ?? "") && fresh.description !== null) out.push({ field: "Bio", from: short(rec.description), to: short(fresh.description) });
  const had = new Set(rec.links.map((l) => l.url));
  const has = new Set(links.map((l) => l.url));
  const added = links.filter((l) => !had.has(l.url));
  const removed = rec.links.filter((l) => !has.has(l.url));
  if (added.length) out.push({ field: "Links added", from: "", to: added.map((l) => l.url.replace(/^https:\/\//, "")).join(", ") });
  if (removed.length) out.push({ field: "Links removed", from: removed.map((l) => l.url.replace(/^https:\/\//, "")).join(", "), to: "" });
  if (email && email !== (rec.email ?? null)) out.push({ field: "Email", from: rec.email ?? "none", to: email });
  return out;
}

/** The record with today's answer in (links/email as enrich found them), and its history entry when something changed. */
export function applyFresh(rec: CreatorRecord, fresh: Fresh, found: { links: CreatorLink[]; email: { email: string; source: string } | null }, at: string): { rec: CreatorRecord; changes: Change[] } {
  const keepManual = rec.email_manual && rec.email;
  const email = keepManual ? rec.email! : (found.email?.email ?? rec.email ?? null);
  const changes = diffFresh(rec, fresh, found.links, email);
  const next: CreatorRecord = {
    ...rec,
    name: fresh.name || rec.name,
    handle: fresh.handle || rec.handle,
    profile_url: fresh.profile_url || rec.profile_url,
    avatar_url: fresh.avatar_url || rec.avatar_url,
    subscriber_count: fresh.subscriber_count ?? rec.subscriber_count,
    video_count: fresh.video_count ?? rec.video_count,
    view_count: fresh.view_count ?? rec.view_count,
    description: fresh.description ?? rec.description,
    links: found.links,
    country: fresh.country ?? rec.country,
    last_upload_at: fresh.last_upload_at ?? rec.last_upload_at ?? null,
    ...(fresh.recent_videos?.length ? { recent_videos: fresh.recent_videos } : {}),
    email,
    email_source: keepManual ? (rec.email_source ?? null) : found.email && found.email.email === email ? found.email.source : (rec.email_source ?? null),
    updated_at: at,
    update_error: null,
  };
  if (changes.length) next.history = [{ at, changes }, ...(rec.history ?? [])].slice(0, HISTORY_KEEP);
  return { rec: next, changes };
}

/** Due for its daily update. */
export const isDue = (rec: CreatorRecord, now: number): boolean => {
  const t = Date.parse(rec.updated_at ?? rec.captured_at);
  return !Number.isFinite(t) || now - t >= DUE_AFTER_MS;
};
