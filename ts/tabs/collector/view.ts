// What Collector's screens draw, computed once for the PC window and the phone (GET v1/collector): the settings, the
// sources (with why one can't run), the run (one line while it goes, its leads), and every lead as a simple card:
// picture, name and handle, platform, profile link, email (and where it came from), the 3 newest videos, Restricted.
import { avatarKey } from "./avatar-key.ts";
import { GAP_CHOICES, PLATFORM_LABEL, type CollectorData, type CreatorPlatform, type CreatorRecord } from "./lib/types.ts";

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
