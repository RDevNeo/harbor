// Collector (the Lead Collector userscript, RDevNeo/spok-lead-collector, moved into Hub): the records it keeps.
// A lead is what the user sees: picture, profile link, handle, platform, an email when there is one, the 3 newest
// videos, and whether it's Restricted (kept out of Available). The record stays the userscript's, field for field (one
// JSON object per line is what SpokPayCRM → Creators → Import parses: influencers/src/lib/leadImport.ts, platform +
// platform_id + name required), so Copy JSONL and Send message (Persons › Creators) carry everything along.
import { backfillRuns, parseRuns, type RunRecord } from "./history.ts";

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
  /** "gmail", "whatsapp", "discord", "instagram". */
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
  /** The one way to contact them the user picked in the lead's detail (its icon shows on the card). Only ever typed. */
  reach?: Reach | null;
  /** The WhatsApp number was typed (Reach): never replaced by one found later. */
  whatsapp_manual?: boolean;
  /** Fields typed in the detail's Edit ("name", "handle", "description", "links"): a later read never replaces them. */
  edited?: string[];
  /** When opening the detail last filled missing data (bio, counts, videos' views and dates) from the platform. */
  filled_at?: string | null;
  /** Brought in from elsewhere rather than found by a run ("SpokPay CRM · Has Contact"). */
  imported_from?: string;
  /** Approved in the detail's review bar: out of Available, into Approved (still never collected again). */
  approved?: Approved | null;
  /** The detail's Quick note: private, never exported. */
  note?: string;
}

/** Where Approve sends a lead: Approved alone, or Approved and Persons › Creators (no message sent). */
export type ApproveTo = "list" | "persons";
export const APPROVE_TO: readonly ApproveTo[] = ["list", "persons"];
export interface Approved {
  at: string;
  to: ApproveTo;
  /** The person in Persons › Creators, when Approve added them there. */
  person: string | null;
}

/** The CRM's Reach (creator-contacts.ts): one operator-owned way to contact a creator. */
export type ReachKind = "email" | "discord" | "whatsapp" | "instagram";
export const REACH_KINDS: readonly ReachKind[] = ["email", "discord", "whatsapp", "instagram"];
export interface Reach {
  kind: ReachKind;
  value: string;
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
  /** The review bar's "Approve to", the last one picked. */
  approveTo: ApproveTo;
  /** The lists' Sort: followers high → low (the default) or low → high. */
  sort: SortMode;
  /** The lists' "Show only — platforms" ([] = every platform). */
  platforms: CreatorPlatform[];
}

/** Followers (YouTube subscribers count as followers), high → low or low → high. */
export type SortMode = "followers-desc" | "followers-asc";
export const SORT_MODES: readonly SortMode[] = ["followers-desc", "followers-asc"];

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
  /** The Last upload window it runs with (days, 0 any time): History keeps it. */
  gapDays?: number;
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
  /** Runs that finished since the user last looked at the Collector tab (PC or phone): the tab's count. */
  unseen: number;
  /** Every finished run (History), oldest first (lib/history.ts). */
  runs: RunRecord[];
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
  return { platform: "youtube", query: "", gapDays: 14, target: 20, lastTemplate: "", approveTo: "list", sort: "followers-desc", platforms: [] };
}

export function defaultData(): CollectorData {
  return { v: 2, settings: defaultSettings(), creators: [], seen: [], run: null, log: [], unseen: 0, runs: [] };
}

/** A "Show only — platforms" choice: known platforms, once each, in the usual order; anything else is "all" ([]). */
export function normalizePlatforms(v: unknown): CreatorPlatform[] {
  const got = Array.isArray(v) ? v.filter((x): x is CreatorPlatform => PLATFORMS.includes(x as CreatorPlatform)) : [];
  const out = (["youtube", "tiktok", "instagram"] as const).filter((p) => got.includes(p));
  return out.length === 3 ? [] : out;
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
    approveTo: APPROVE_TO.includes(s.approveTo as ApproveTo) ? (s.approveTo as ApproveTo) : "list",
    sort: SORT_MODES.includes(s.sort as SortMode) ? (s.sort as SortMode) : "followers-desc",
    platforms: normalizePlatforms(s.platforms),
  };
  d.creators = Array.isArray(r.creators)
    ? (r.creators.filter((c) => c && typeof c === "object" && typeof (c as CreatorRecord).platform_id === "string" && typeof (c as CreatorRecord).platform === "string") as CreatorRecord[]).map((c) => ({
        ...c,
        links: Array.isArray(c.links) ? c.links.filter((l) => l && typeof l.url === "string") : [],
      }))
        .map((c) => {
          // Reach and Edit came later: absent on older records, a bad one dropped.
          const { reach, edited, ...rest } = c;
          const okReach = reach && typeof reach === "object" && REACH_KINDS.includes(reach.kind) && typeof reach.value === "string" && reach.value.trim();
          const okEdited = Array.isArray(edited) ? edited.filter((f): f is string => typeof f === "string") : [];
          return { ...rest, ...(okReach ? { reach: { kind: reach.kind, value: reach.value.trim() } } : {}), ...(okEdited.length ? { edited: okEdited } : {}) };
        })
        .map((c) => {
          // Approve and the Quick note came later: a bad one dropped.
          const { approved, note, ...rest } = c;
          const okApproved = approved && typeof approved === "object" && typeof approved.at === "string";
          return {
            ...rest,
            ...(okApproved ? { approved: { at: approved.at, to: APPROVE_TO.includes(approved.to) ? approved.to : "list", person: typeof approved.person === "string" ? approved.person : null } } : {}),
            ...(typeof note === "string" && note.trim() ? { note } : {}),
          };
        })
        .map((c) => {
          const { history: _h, update_error: _e, ...rest } = c as CreatorRecord & { history?: unknown; update_error?: unknown };
          return rest;
        })
    : [];
  d.seen = Array.isArray(r.seen) ? r.seen.filter((k): k is string => typeof k === "string") : [];
  const run = r.run && typeof r.run === "object" ? (r.run as Record<string, unknown>) : null;
  d.run = run && run.tab !== "servers" ? ({ known: 0, platform: "youtube", line: "", ...run, ids: Array.isArray(run.ids) ? run.ids.filter((x) => typeof x === "string") : [] } as unknown as RunState) : null;
  d.log = Array.isArray(r.log) ? (r.log.filter((l) => l && typeof l === "object" && typeof (l as LogLine).text === "string") as LogLine[]) : [];
  d.unseen = typeof r.unseen === "number" && Number.isInteger(r.unseen) && r.unseen > 0 ? r.unseen : 0;
  // History came later: a file without it gets its runs rebuilt once from the leads (and the last run as saved).
  d.runs = Array.isArray(r.runs) ? parseRuns(r.runs) : backfillRuns(d.creators, d.run);
  return d;
}

/** The CRM's fields (and the email), as the record it imports. */
export function exportRecord(c: CreatorRecord): Record<string, unknown> {
  const { email_manual: _m, whatsapp: _w, updated_at: _u, contacted: _c, last_upload_at: _l, restricted: _r, found_video: _f, reach, whatsapp_manual: _wm, edited: _e, filled_at: _fa, imported_from: _if, approved: _a, note: _n, ...rest } = c;
  const out: Record<string, unknown> = { ...rest, links: c.links.map(({ label, url }) => ({ label, url })) };
  // The CRM's own Reach columns (creators.reach_kind / reach_value).
  if (reach) {
    out.reach_kind = reach.kind;
    out.reach_value = reach.value;
  }
  if (!c.email) {
    delete out.email;
    delete out.email_source;
  }
  return out;
}

/** Which list a lead is in: Restricted, Approved, else Available. */
export function listOf(c: CreatorRecord): "available" | "approved" | "restricted" {
  return c.restricted ? "restricted" : c.approved ? "approved" : "available";
}

/** Copy for the CRM: the Available leads (or the Approved ones) as JSONL, one complete record per line. */
export function exportText(d: CollectorData, which: "available" | "approved" = "available"): string {
  return d.creators
    .filter((c) => listOf(c) === which)
    .map((c) => JSON.stringify(exportRecord(c)))
    .join("\n");
}
