// TikTok and Instagram sweeps (the userscript's ttCollectCreators / igCollectCreators, from the engine): discovery
// hands batches of accounts (TikTok: its search suggestions, which answer without a login; Instagram: hashtag and
// account search on the user's own session), each new one is read (profile, newest posts), dropped when it hasn't
// posted within the window, enriched (links, email) and kept. Same rules as YouTube: never twice, drops don't count.
import { handleKey } from "./identity.ts";
import { daysSince, formatUploadAge, type Stats } from "./sweep.ts";
import type { CreatorLink, CreatorRecord, RecentVideo } from "./types.ts";

export interface Profile {
  platform: "tiktok" | "instagram";
  platform_id: string;
  name: string;
  handle: string;
  profile_url: string;
  avatar_url: string | null;
  followers: number | null;
  posts: number | null;
  likes: number | null;
  bio: string | null;
  links: { label: string | null; url: string }[];
  email: string | null;
  country: string | null;
  last_post_at: string | null;
  recent: RecentVideo[];
  private: boolean;
  precision: "exact" | "rounded";
}

export interface Hit {
  handle: string;
  id?: string;
  name?: string;
  avatarUrl?: string | null;
  followers?: number | null;
  latestAt?: number | null;
}

export interface DiscoverOpts {
  stopped(): boolean;
  sleep(ms: number): Promise<void>;
  log(t: string): void;
  maxQueries?: number;
}

export interface SocialClient {
  profile(handle: string): Promise<Profile>;
  discover(query: string, o: DiscoverOpts): AsyncIterable<Hit[]>;
}

export interface SocialSweepCtx {
  platform: "tiktok" | "instagram";
  client: SocialClient;
  query: string;
  target: number;
  gapDays: number;
  isKnown(keys: string[]): boolean;
  enrich(rec: CreatorRecord, bioSource: string): Promise<CreatorRecord>;
  add(rec: CreatorRecord): string | null;
  count(): number;
  stopped(): boolean;
  log(text: string, tone?: "ok" | "drop" | "skip" | "info" | "error"): void;
  progress(stats: Stats): void;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

export const PROFILE_DELAY_MS = 1200;
/** Blocked reads in a row before the sweep gives the platform a rest (the CRM's refresh rule). */
export const BLOCKED_LIMIT = 5;

const LABEL = { tiktok: "TikTok", instagram: "Instagram" } as const;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A profile as Collector's record (the userscript's fields: followers in subscriber_count, likes in view_count). */
export function profileRecord(p: Profile, query: string, at: string): CreatorRecord {
  const links: CreatorLink[] = p.links.map((l) => ({ label: l.label, url: l.url }));
  return {
    platform: p.platform,
    platform_id: p.platform_id,
    name: p.name || p.handle,
    handle: p.handle,
    profile_url: p.profile_url,
    avatar_url: p.avatar_url,
    subscriber_count: p.followers,
    video_count: p.posts,
    view_count: p.platform === "tiktok" ? p.likes : null,
    description: p.bio,
    links,
    country: p.country,
    discovered_via: query,
    captured_at: at,
    ...(p.recent.length ? { recent_videos: p.recent } : {}),
    last_upload_at: p.last_post_at,
    updated_at: at,
    ...(p.email ? { email: p.email, email_source: `${LABEL[p.platform]} contact` } : {}),
  };
}

export async function sweepSocial(c: SocialSweepCtx): Promise<Stats> {
  const label = LABEL[c.platform];
  const now = c.now ?? Date.now;
  const at = new Date(now()).toISOString();
  const stats: Stats = { considered: 0, kept: 0, dropped: 0, discovered: 0, known: 0 };
  const reached = (): boolean => c.target > 0 && c.count() >= c.target;
  const seenNow = new Set<string>();
  let blocked = 0;
  c.log(c.target > 0 ? `Sweeping ${label} for "${c.query}" - target ${c.target} creator(s).` : `Sweeping ${label} for "${c.query}" - no target, collecting everything.`);
  c.log(c.gapDays > 0 ? `Dropping any account with no post in the last ${c.gapDays} days.` : "No freshness filter - collecting accounts whenever they last posted.");
  try {
    for await (const batch of c.client.discover(c.query, { stopped: () => c.stopped() || reached(), sleep: c.sleep, log: (t) => c.log(t), maxQueries: c.target > 0 ? Math.min(200, 30 + c.target * 4) : 200 })) {
      if (c.stopped() || reached()) break;
      const fresh = batch.filter((h) => {
        const k = h.handle.replace(/^@/, "").toLowerCase();
        if (!k || seenNow.has(k)) return false;
        seenNow.add(k);
        return true;
      });
      const todo = fresh.filter((h) => !c.isKnown([handleKey(c.platform, h.handle)!, ...(h.id ? [`${c.platform}:${h.id}`] : [])]));
      stats.known += fresh.length - todo.length;
      stats.discovered += todo.length;
      c.progress(stats);
      for (const h of todo) {
        if (c.stopped() || reached()) break;
        const who = `@${h.handle.replace(/^@/, "")}`;
        stats.considered++;
        // A post seen in discovery inside the window is enough; else the profile's newest post decides.
        let p: Profile;
        try {
          p = await c.client.profile(h.handle.replace(/^@/, ""));
          blocked = 0;
        } catch (e) {
          const msg = errText(e);
          stats.dropped++;
          c.log(`SKIP ${who}: ${msg}`, "skip");
          c.progress(stats);
          if (/blocked|refused|429|401|403|captcha|verify/i.test(msg) && ++blocked >= BLOCKED_LIMIT) {
            c.log(`${label} refused ${blocked} reads in a row - stopping here to go easy on it. Try again later.`, "error");
            return stats;
          }
          await c.sleep(PROFILE_DELAY_MS);
          continue;
        }
        if (p.private) {
          stats.dropped++;
          c.log(`DROP ${who}: private account.`, "drop");
          c.progress(stats);
          await c.sleep(PROFILE_DELAY_MS);
          continue;
        }
        const newest = Math.max(p.last_post_at ? Date.parse(p.last_post_at) : 0, h.latestAt ?? 0) || null;
        if (c.gapDays > 0) {
          if (newest === null && p.precision === "exact") {
            stats.dropped++;
            c.log(`DROP ${who}: no posts found.`, "drop");
            c.progress(stats);
            await c.sleep(PROFILE_DELAY_MS);
            continue;
          }
          if (newest !== null && daysSince(newest, now()) > c.gapDays) {
            stats.dropped++;
            c.log(`DROP ${who}: dead - last post ${formatUploadAge(daysSince(newest, now()))} (limit ${c.gapDays} days).`, "drop");
            c.progress(stats);
            await c.sleep(PROFILE_DELAY_MS);
            continue;
          }
        }
        let rec = profileRecord(p, c.query, at);
        if (!rec.last_upload_at && newest) rec.last_upload_at = new Date(newest).toISOString();
        if (!rec.avatar_url && h.avatarUrl) rec.avatar_url = h.avatarUrl;
        rec = await c.enrich(rec, `${label} bio`);
        const why = c.add(rec);
        if (why) {
          stats.known++;
          c.log(`SKIP ${rec.name}: ${why}`, "skip");
        } else {
          stats.kept++;
          const f = rec.subscriber_count === null ? "hidden" : rec.subscriber_count;
          c.log(`OK ${rec.name} (${who}) - ${f} followers, ${rec.links.length} link(s)${rec.email ? `, email (${rec.email_source})` : ""}${newest ? `, last post ${formatUploadAge(daysSince(newest, now()))}` : ""}`, "ok");
        }
        c.progress(stats);
        await c.sleep(PROFILE_DELAY_MS);
      }
    }
  } catch (e) {
    c.log(`${label} search stopped: ${errText(e)}`, "error");
  }
  if (stats.discovered === 0 && stats.known === 0) c.log("Nothing found for that term.");
  else if (c.target > 0 && !reached() && !c.stopped()) c.log(`${label} has no more accounts for "${c.query}" and the target is still ${Math.max(c.target - c.count(), 0)} short. Try another term.`);
  return stats;
}
