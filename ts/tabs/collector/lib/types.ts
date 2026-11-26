// Collector (the Lead Collector userscript, RDevNeo/spok-lead-collector, moved into Hub): the records it keeps.
// A creator record is the userscript's, field for field: one JSON object per line is what SpokPayCRM → Creators →
// Import parses (influencers/src/lib/leadImport.ts: platform + platform_id + name required, deduped on both).

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
}

export interface CreatorRecord {
  platform: string;
  platform_id: string;
  name: string;
  handle: string | null;
  profile_url: string | null;
  avatar_url: string | null;
  /** null when the channel hides it: never 0 for "hidden". */
  subscriber_count: number | null;
  video_count: number | null;
  view_count: number | null;
  description: string | null;
  links: CreatorLink[];
  country: string | null;
  discovered_via: string;
  captured_at: string;
  /** Omitted (not empty) when the sweep never read the feed: the CRM reads [] as "no uploads". */
  recent_videos?: RecentVideo[];
}

/** One Discord server invite, as the Servers tab collects it (Copy gives the URLs, one per line). */
export interface ServerRecord {
  invite: string;
  name: string | null;
  guild_id: string | null;
  members: number | null;
  online: number | null;
  icon_url: string | null;
  /** "discover: <term>" or "reader: #channel". */
  source: string;
  captured_at: string;
}

export type CollectTab = "creators" | "servers";
export type CreatorPlatform = "instagram" | "tiktok" | "youtube";
export type ServerMode = "discover" | "reader" | "sidebar";

export interface Settings {
  tab: CollectTab;
  platform: CreatorPlatform;
  query: string;
  /** Days without an upload before a channel is dropped; 0 = any time. */
  gapDays: number;
  serverMode: ServerMode;
  serverQuery: string;
  /** Reader: a channel link (discord.com/channels/<guild>/<channel>) or id. */
  channel: string;
  /** Stop-at counts, per tab (0 = everything the source gives). */
  targets: { creators: number; servers: number };
}

export interface RunState {
  running: boolean;
  tab: CollectTab;
  /** What runs: "YouTube", "Discover". */
  label: string;
  query: string;
  startedAt: number;
  endedAt: number;
  status: string;
  found: number;
  target: number;
  considered: number;
  dropped: number;
}

export interface LogLine {
  at: number;
  text: string;
  /** "ok", "drop", "skip", "info", "error". */
  tone: string;
}

export interface CollectorData {
  v: 1;
  settings: Settings;
  creators: CreatorRecord[];
  servers: ServerRecord[];
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

export interface SourceInfo {
  value: string;
  label: string;
  available: boolean;
  /** Why not, when it isn't. */
  why: string;
}

/** The userscript's order (prospecting priority, not what's built): Instagram, TikTok, YouTube. */
export const CREATOR_SOURCES: SourceInfo[] = [
  {
    value: "instagram",
    label: "Instagram",
    available: false,
    why: "Not available yet: Instagram's search needs a signed-in Instagram session and its profiles only render in a browser. Hub has no Instagram login.",
  },
  {
    value: "tiktok",
    label: "TikTok",
    available: false,
    why: "Not available yet: TikTok's search answers only requests signed by its own page code (X-Bogus/msToken), which Hub can't run without a browser.",
  },
  { value: "youtube", label: "YouTube", available: true, why: "" },
];

export const SERVER_MODES: SourceInfo[] = [
  { value: "discover", label: "Discover", available: true, why: "" },
  { value: "reader", label: "Reader", available: true, why: "" },
  {
    value: "sidebar",
    label: "Sidebar",
    available: false,
    why: "Not available yet: walking every member profile of every server is the kind of traffic that gets a Discord account flagged.",
  },
];

export function defaultSettings(): Settings {
  return { tab: "creators", platform: "youtube", query: "", gapDays: 14, serverMode: "discover", serverQuery: "", channel: "", targets: { creators: 50, servers: 50 } };
}

export function defaultData(): CollectorData {
  return { v: 1, settings: defaultSettings(), creators: [], servers: [], run: null, log: [] };
}

export function normalizeTarget(v: unknown): number {
  const n = Math.floor(Number(String(v ?? "").replace(/[^\d]/g, "")));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 0;
}

/** Whatever the file holds, as data this version understands (unknown fields dropped, bad ones defaulted). */
export function migrate(raw: unknown): CollectorData {
  const d = defaultData();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const s = (r.settings ?? {}) as Record<string, unknown>;
  const t = (s.targets ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, ok: readonly T[], dflt: T): T => (ok.includes(v as T) ? (v as T) : dflt);
  d.settings = {
    tab: pick(s.tab, ["creators", "servers"] as const, d.settings.tab),
    platform: pick(s.platform, ["instagram", "tiktok", "youtube"] as const, d.settings.platform),
    query: typeof s.query === "string" ? s.query : "",
    gapDays: GAP_CHOICES.some((c) => c.value === s.gapDays) ? (s.gapDays as number) : d.settings.gapDays,
    serverMode: pick(s.serverMode, ["discover", "reader", "sidebar"] as const, d.settings.serverMode),
    serverQuery: typeof s.serverQuery === "string" ? s.serverQuery : "",
    channel: typeof s.channel === "string" ? s.channel : "",
    targets: { creators: t.creators === undefined ? d.settings.targets.creators : normalizeTarget(t.creators), servers: t.servers === undefined ? d.settings.targets.servers : normalizeTarget(t.servers) },
  };
  d.creators = Array.isArray(r.creators) ? (r.creators.filter((c) => c && typeof c === "object" && typeof (c as CreatorRecord).platform_id === "string") as CreatorRecord[]) : [];
  d.servers = Array.isArray(r.servers) ? (r.servers.filter((c) => c && typeof c === "object" && typeof (c as ServerRecord).invite === "string") as ServerRecord[]) : [];
  d.run = r.run && typeof r.run === "object" ? (r.run as RunState) : null;
  d.log = Array.isArray(r.log) ? (r.log.filter((l) => l && typeof l === "object" && typeof (l as LogLine).text === "string") as LogLine[]) : [];
  return d;
}

/** Copy for the CRM: creators as JSONL (one complete record per line), servers as one invite URL per line. */
export function exportText(d: CollectorData, tab: CollectTab): string {
  return tab === "creators" ? d.creators.map((c) => JSON.stringify(c)).join("\n") : d.servers.map((s) => s.invite).join("\n");
}
