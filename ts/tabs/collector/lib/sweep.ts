// The YouTube creator sweep (the userscript's collectCreators / harvestChannels / ytPageThrough): discovery walks a list
// of search surfaces, harvesting after each and stopping the moment the target is met; every channel goes through the
// freshness gate (its Atom feed) before its About data is read; drops never count toward the target.
import { YT_SORT, YT_TYPE, YT_UPLOADED, ytChannelsFromSearch, ytFind, ytUploadersFromSearch, type ChannelHit, type SearchFilter, type YouTube } from "./youtube.ts";
import { handleKey } from "./identity.ts";
import type { CreatorRecord, RecentVideo } from "./types.ts";

export interface Pass {
  label: string;
  sp: SearchFilter;
  extract: (data: unknown) => ChannelHit[];
}

/** Each ranks differently, so each returns a materially different set (measured in the userscript). */
export const YT_DISCOVERY_PASSES: Pass[] = [
  { label: "Channels", sp: { type: YT_TYPE.CHANNEL }, extract: ytChannelsFromSearch },
  { label: "Channels by views", sp: { sort: YT_SORT.VIEWS, type: YT_TYPE.CHANNEL }, extract: ytChannelsFromSearch },
  { label: "Videos today", sp: { uploaded: YT_UPLOADED.TODAY, type: YT_TYPE.VIDEO }, extract: ytUploadersFromSearch },
  { label: "Videos this week", sp: { uploaded: YT_UPLOADED.WEEK, type: YT_TYPE.VIDEO }, extract: ytUploadersFromSearch },
  { label: "Videos", sp: { type: YT_TYPE.VIDEO }, extract: ytUploadersFromSearch },
  { label: "Videos this month", sp: { uploaded: YT_UPLOADED.MONTH, type: YT_TYPE.VIDEO }, extract: ytUploadersFromSearch },
  { label: "Videos by views", sp: { sort: YT_SORT.VIEWS, type: YT_TYPE.VIDEO }, extract: ytUploadersFromSearch },
  { label: "Videos by upload date", sp: { sort: YT_SORT.DATE, type: YT_TYPE.VIDEO }, extract: ytUploadersFromSearch },
  { label: "Channels by rating", sp: { sort: YT_SORT.RATING, type: YT_TYPE.CHANNEL }, extract: ytChannelsFromSearch },
];

// The userscript's pacing (gentle: one request at a time, a breather between each).
export const YT_PASS_DELAY_MS = 600;
export const YT_MAX_PAGES = 200;
export const YT_DRY_PAGE_LIMIT = 10;
export const YT_ENRICH_DELAY_MS = 350;
export const YT_PAGE_DELAY_MS = 250;
export const YT_FEED_DELAY_MS = 150;
export const YT_LIVE_RATE_ESTIMATE = 0.6;
export const YT_MIN_LIVE_RATE = 0.15;

export interface Stats {
  considered: number;
  kept: number;
  dropped: number;
  discovered: number;
  /** Passed over: collected before, or in Persons already. */
  known: number;
}

export interface SweepCtx {
  yt: Pick<YouTube, "search" | "continuation" | "feed" | "about">;
  query: string;
  /** 0: no target. */
  target: number;
  /** 0: any time (no feed read). */
  gapDays: number;
  /** Already collected, on any platform, or already in Persons (identity keys: lib/identity.ts). */
  isKnown(keys: string[]): boolean;
  /** Links and email filled in (link-in-bio pages, their site), before it's kept. */
  enrich(rec: CreatorRecord, bioSource: string): Promise<CreatorRecord>;
  /** How many creators are collected now (the target is measured against it). */
  count(): number;
  /** Keeps it; or why not (the same person is already collected, by a link of theirs). */
  add(rec: CreatorRecord): string | null;
  stopped(): boolean;
  log(text: string, tone?: "ok" | "drop" | "skip" | "info" | "error"): void;
  progress(stats: Stats): void;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

export const daysSince = (t: number, now = Date.now()): number => (now - t) / 86_400_000;
export function formatUploadAge(days: number): string {
  if (days < 1) return "today";
  const w = Math.round(days);
  return `${w} day${w === 1 ? "" : "s"} ago`;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const reached = (c: SweepCtx): boolean => c.target > 0 && c.count() >= c.target;

/** How many channels to discover for the leads still missing, by the keep rate seen so far. */
export function discoveryAppetite(target: number, have: number, stats: Stats): number {
  if (target <= 0) return 0;
  const shortfall = Math.max(target - have, 0);
  if (shortfall === 0) return 0;
  const rate = stats.considered >= 10 ? Math.max(stats.kept / stats.considered, YT_MIN_LIVE_RATE) : YT_LIVE_RATE_ESTIMATE;
  return Math.ceil(shortfall / rate) + 5;
}

async function pageThrough(c: SweepCtx, label: string, first: unknown, extract: Pass["extract"], wanted: number, stats: Stats, seenNow: Set<string>): Promise<ChannelHit[]> {
  const found: ChannelHit[] = [];
  let data = first;
  let dry = 0;
  for (let page = 1; page <= YT_MAX_PAGES; page++) {
    if (c.stopped()) break;
    const hits = extract(data).filter((e) => !seenNow.has(e.channelId));
    for (const e of hits) seenNow.add(e.channelId);
    const batch = hits.filter((e) => !c.isKnown([`youtube:${e.channelId}`, ...(e.handle ? [handleKey("youtube", e.handle)!] : [])]));
    stats.known += hits.length - batch.length;
    found.push(...batch);
    if (batch.length === 0) {
      // YouTube pads these lists with Shorts and resumes handing out channels pages later.
      if (++dry >= YT_DRY_PAGE_LIMIT) {
        c.log(`${label}: no new channels for ${dry} pages - source exhausted.`);
        break;
      }
    } else {
      dry = 0;
      c.log(`${label} page ${page}: ${batch.length} new channel(s). ${found.length} queued.`);
    }
    if (wanted > 0 && found.length >= wanted) {
      c.log(`${label}: enough channels for the target.`);
      break;
    }
    const cmd = ytFind(data, "continuationCommand") as { token?: string } | null;
    if (!cmd?.token) {
      c.log(`${label}: no further pages.`);
      break;
    }
    let next: unknown;
    try {
      next = await c.yt.continuation(cmd.token);
    } catch (e) {
      c.log(`${label}: continuation failed (${errText(e)}).`, "error");
      break;
    }
    if (!next) {
      c.log(`${label}: continuation unavailable.`);
      break;
    }
    data = next;
    await c.sleep(YT_PAGE_DELAY_MS);
  }
  return found;
}

async function harvest(c: SweepCtx, entries: ChannelHit[], capturedAt: string, stats: Stats): Promise<void> {
  c.log(c.gapDays > 0 ? `Checking uploads on ${entries.length} channel(s), then reading the live ones...` : `Reading ${entries.length} channel page(s) for links and stats...`);
  const now = c.now ?? Date.now;
  for (const entry of entries) {
    if (c.stopped()) break;
    if (reached(c)) {
      c.log(`Target of ${c.target} creator(s) reached.`);
      break;
    }
    const label = entry.name || entry.channelId;
    stats.considered++;
    let age: number | null = null;
    let recent: RecentVideo[] = [];
    if (c.gapDays > 0) {
      let newest: number | null;
      try {
        const f = await c.yt.feed(entry.channelId);
        newest = f.newest;
        recent = f.videos;
      } catch (e) {
        stats.dropped++;
        c.log(`DROP ${label}: could not check uploads (${errText(e)}).`, "drop");
        c.progress(stats);
        await c.sleep(YT_FEED_DELAY_MS);
        continue;
      }
      if (newest === null) {
        stats.dropped++;
        c.log(`DROP ${label}: no uploads at all.`, "drop");
        c.progress(stats);
        await c.sleep(YT_FEED_DELAY_MS);
        continue;
      }
      age = daysSince(newest, now());
      if (age > c.gapDays) {
        stats.dropped++;
        c.log(`DROP ${label}: dead - last upload ${formatUploadAge(age)} (limit ${c.gapDays} days).`, "drop");
        c.progress(stats);
        await c.sleep(YT_FEED_DELAY_MS);
        continue;
      }
    }
    try {
      const d = await c.yt.about(entry.channelId);
      let rec: CreatorRecord = {
        platform: "youtube",
        platform_id: entry.channelId,
        name: d.name || entry.name || entry.channelId,
        handle: d.handle || entry.handle,
        profile_url: d.profileUrl || entry.profileUrl,
        avatar_url: d.avatarUrl || entry.avatarUrl,
        subscriber_count: d.subscribers ?? entry.subscribers ?? null,
        video_count: d.videos,
        view_count: d.views,
        description: d.description || entry.description || null,
        links: d.links,
        country: d.country,
        discovered_via: c.query,
        captured_at: capturedAt,
        ...(recent.length ? { recent_videos: recent } : {}),
        last_upload_at: recent[0]?.published_at ?? null,
        updated_at: capturedAt,
      };
      rec = await c.enrich(rec, "YouTube About");
      const why = c.add(rec);
      if (why) {
        stats.known++;
        c.log(`SKIP ${rec.name}: ${why}`, "skip");
        c.progress(stats);
        continue;
      }
      stats.kept++;
      const subs = rec.subscriber_count === null ? "hidden" : rec.subscriber_count;
      c.log(`OK ${rec.name} - ${subs} subs, ${rec.links.length} link(s)${rec.email ? `, email (${rec.email_source})` : ""}${age === null ? "" : `, last upload ${formatUploadAge(age)}`}`, "ok");
    } catch (e) {
      c.log(`SKIP ${label}: ${errText(e)}`, "skip");
    }
    c.progress(stats);
    await c.sleep(YT_ENRICH_DELAY_MS);
  }
}

/** One sweep, to the end: the target met, every surface exhausted, or stopped. Says which. */
export async function sweepYouTube(c: SweepCtx): Promise<Stats> {
  const capturedAt = new Date((c.now ?? Date.now)()).toISOString();
  const stats: Stats = { considered: 0, kept: 0, dropped: 0, discovered: 0, known: 0 };
  const seenNow = new Set<string>();
  c.log(c.target > 0 ? `Sweeping YouTube for "${c.query}" - target ${c.target} creator(s).` : `Sweeping YouTube for "${c.query}" - no target, collecting everything.`);
  c.log(c.gapDays > 0 ? `Dropping any channel with no upload in the last ${c.gapDays} days.` : "No freshness filter - collecting channels whenever they last uploaded.");
  for (const pass of YT_DISCOVERY_PASSES) {
    if (c.stopped() || reached(c)) break;
    let page: unknown;
    try {
      page = await c.yt.search(c.query, pass.sp);
    } catch (e) {
      c.log(`${pass.label} search failed: ${errText(e)}`, "error");
      continue;
    }
    const found = await pageThrough(c, pass.label, page, pass.extract, discoveryAppetite(c.target, c.count(), stats), stats, seenNow);
    stats.discovered += found.length;
    c.progress(stats);
    if (found.length === 0) {
      c.log(`${pass.label}: nothing new.`);
      continue;
    }
    await harvest(c, found, capturedAt, stats);
    if (!c.stopped() && !reached(c)) await c.sleep(YT_PASS_DELAY_MS);
  }
  if (stats.dropped > 0 && c.gapDays > 0) c.log(`Dropped ${stats.dropped} channel(s) - no upload in the last ${c.gapDays} days.`);
  if (stats.discovered === 0) c.log("Nothing new found for that term.");
  else if (c.target > 0 && !reached(c) && !c.stopped())
    c.log(`Every search surface is exhausted for "${c.query}" and the target is still ${Math.max(c.target - c.count(), 0)} short. Try another search term, or widen Last upload.`);
  return stats;
}
