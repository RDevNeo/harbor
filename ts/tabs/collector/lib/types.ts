// Collector (the Lead Collector userscript, RDevNeo/spok-lead-collector, moved into Hub): the records it keeps.
// A lead is what the user sees: picture, profile link, handle, platform, an email when there is one, the 3 newest
// videos, and whether it's Restricted (kept out of Available). The record stays the userscript's, field for field (one
// JSON object per line is what SpokPayCRM → Creators → Import parses: influencers/src/lib/leadImport.ts, platform +
// platform_id + name required), so Copy JSONL and Send message (Persons › Creators) carry everything along.

export interface RecentVideo {
  video_id: string;
  title: string | null;
  url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  view_count: number | null;
  is_short: boolean;
}

export interface CreatorLink {
  label: string | null;
  url: string;
  /** Where it was found ("bio", "linktr.ee/x"); absent for the platform's own link list. */
  source?: string;
}

export interface Contacted {
  at: string;
  /** "gmail", "whatsapp". */
  via: string;
  to: string;
  /** The person it made in Persons › Creators. */
  person: string | null;
}

export interface CreatorRecord {
  platform: string;
  platform_id: string;
  name: string;
  handle: string | null;
  profile_url: string | null;
  avatar_url: string | null;
  /** null when the channel hides it: never 0 for "hidden". Followers on Instagram/TikTok. */
  subscriber_count: number | null;
  /** Videos (YouTube, TikTok) or posts (Instagram). */
  video_count: number | null;
  /** Views (YouTube) or likes (TikTok). */
  view_count: number | null;
  description: string | null;
  links: CreatorLink[];
  country: string | null;
  discovered_via: string;
  captured_at: string;
  /** Omitted (not empty) when the sweep never read the feed: the CRM reads [] as "no uploads". */
  recent_videos?: RecentVideo[];
  // Hub's own, past the userscript's record:
  email?: string | null;
  /** "YouTube About", "Instagram bio", "linktr.ee/x", "site x.com.br/contato", "typed". */
  email_source?: string | null;
  /** Typed by hand: never replaced by one found later. */
  email_manual?: boolean;
  /** A WhatsApp number their bio or links give (digits, country code first). */
  whatsapp?: string | null;
  last_upload_at?: string | null;
  /** When the record was last read (the capture). */
  updated_at?: string | null;
  /** The video in the search results that led to them (its URL). */
  found_video?: string | null;
  contacted?: Contacted | null;
  /** Restricted by the user: kept (never collected again) but never shown in Available. */
  restricted?: boolean;
}

export type CreatorPlatform = "instagram" | "tiktok" | "youtube";
export const PLATFORMS: readonly CreatorPlatform[] = ["instagram", "tiktok", "youtube"];

export interface Settings {
  platform: CreatorPlatform;
  query: string;
  /** Days without an upload/post before a creator is dropped; 0 = any time. */
  gapDays: number;
  /** Stop-at count (0 = everything the source gives). */
  target: number;
  /** The Send message menu opens on the template used last. */
  lastTemplate: string;
}

export interface RunState {
  running: boolean;
  /** What runs: "YouTube", "Instagram", "TikTok". */
  label: string;
  platform: CreatorPlatform;
  query: string;
  startedAt: number;
  endedAt: number;
  status: string;
  found: number;
  target: number;
  considered: number;
  dropped: number;
  /** Already collected (or already in Persons): passed over. */
  known: number;
  /** The leads this run kept (record ids), in the order found: the Collector page's results. */
  ids: string[];
  /** What it's doing now, one line. */
  line: string;
}

export interface LogLine {
  at: number;
  text: string;
  /** "ok", "drop", "skip", "info", "error". */
  tone: string;
}

export interface CollectorData {
  v: 2;
  settings: Settings;
  creators: CreatorRecord[];
  /** Every identity key ever collected (ids, handles, linked profiles, emails): Clear and Remove keep them. */
  seen: string[];
  run: RunState | null;
  log: LogLine[];
}

export const GAP_CHOICES: { value: number; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 0, label: "Any time" },
];

export const PLATFORM_LABEL: Record<CreatorPlatform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

export function defaultSettings(): Settings {
  return { platform: "youtube", query: "", gapDays: 14, target: 20, lastTemplate: "" };
}

export function defaultData(): CollectorData {
  return { v: 2, settings: defaultSettings(), creators: [], seen: [], run: null, log: [] };
}

export function normalizeTarget(v: unknown): number {
  const n = Math.floor(Number(String(v ?? "").replace(/[^\d]/g, "")));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 0;
}

/**
 * Whatever the file holds, as data this version understands (v1's Servers dropped, unknown fields dropped, bad ones
 * defaulted). Every creator stays; the daily update's leftovers (its state, each record's history and error) go.
 */
export function migrate(raw: unknown): CollectorData {
  const d = defaultData();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const s = (r.settings ?? {}) as Record<string, unknown>;
  const t = s.targets && typeof s.targets === "object" ? (s.targets as Record<string, unknown>).creators : s.target;
  d.settings = {
    platform: PLATFORMS.includes(s.platform as CreatorPlatform) ? (s.platform as CreatorPlatform) : d.settings.platform,
    query: typeof s.query === "string" ? s.query : "",
    gapDays: GAP_CHOICES.some((c) => c.value === s.gapDays) ? (s.gapDays as number) : d.settings.gapDays,
    target: t === undefined ? d.settings.target : normalizeTarget(t),
    lastTemplate: typeof s.lastTemplate === "string" ? s.lastTemplate : "",
  };
  d.creators = Array.isArray(r.creators)
    ? (r.creators.filter((c) => c && typeof c === "object" && typeof (c as CreatorRecord).platform_id === "string" && typeof (c as CreatorRecord).platform === "string") as CreatorRecord[]).map((c) => ({
        ...c,
        links: Array.isArray(c.links) ? c.links.filter((l) => l && typeof l.url === "string") : [],
      }))
        .map((c) => {
          const { history: _h, update_error: _e, ...rest } = c as CreatorRecord & { history?: unknown; update_error?: unknown };
          return rest;
        })
    : [];
  d.seen = Array.isArray(r.seen) ? r.seen.filter((k): k is string => typeof k === "string") : [];
  const run = r.run && typeof r.run === "object" ? (r.run as Record<string, unknown>) : null;
  d.run = run && run.tab !== "servers" ? ({ known: 0, platform: "youtube", line: "", ...run, ids: Array.isArray(run.ids) ? run.ids.filter((x) => typeof x === "string") : [] } as unknown as RunState) : null;
  d.log = Array.isArray(r.log) ? (r.log.filter((l) => l && typeof l === "object" && typeof (l as LogLine).text === "string") as LogLine[]) : [];
  return d;
}

/** The CRM's fields (and the email), as the record it imports. */
export function exportRecord(c: CreatorRecord): Record<string, unknown> {
  const { email_manual: _m, whatsapp: _w, updated_at: _u, contacted: _c, last_upload_at: _l, restricted: _r, found_video: _f, ...rest } = c;
  const out: Record<string, unknown> = { ...rest, links: c.links.map(({ label, url }) => ({ label, url })) };
  if (!c.email) {
    delete out.email;
    delete out.email_source;
  }
  return out;
}

/** Copy for the CRM: the Available leads (Restricted ones left out) as JSONL, one complete record per line. */
export function exportText(d: CollectorData): string {
  return d.creators
    .filter((c) => !c.restricted)
    .map((c) => JSON.stringify(exportRecord(c)))
    .join("\n");
}
