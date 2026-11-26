// The Servers tab: Discord server invites, read the way an API client can without clicking through Discord's UI and
// without writing anything (the userscript drove discord.com's DOM; Hub has no browser):
//   Discover: Discord's own Discover search (`/discoverable-guilds/search`, needs a signed-in account: Persons' Discord
//             connection), then each server's public widget (`/guilds/<id>/widget.json`, no login) for its invite. A server
//             whose widget is off has no invite a visitor can read: named in the log as SKIP, as the userscript's Discover
//             skipped servers that reserve "Create Invite" for members. Nothing is joined and no invite is created.
//   Reader:   a channel's messages, newest first, scanned for invite URLs (the userscript's Reader).
// Invites found by Reader are looked up (`/invites/<code>`, public) for the server's name and counts.
import { extractInviteUrls, inviteCode, normalizeInvite, parseChannel } from "./invites.ts";
import type { ServerRecord } from "./types.ts";

/** Discord's HTTP API on a signed-in connection (Persons' DiscordLink.api): path under /api/v9. */
export type DiscordApi = <T = unknown>(method: string, path: string) => Promise<T>;
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const DISCOVER_PAGE = 24;
export const DISCOVER_MAX_PAGES = 40;
export const WIDGET_DELAY_MS = 700;
export const DISCOVER_PAGE_DELAY_MS = 1500;
export const READER_PAGE = 100;
export const READER_MAX_PAGES = 30;
export const READER_PAGE_DELAY_MS = 1200;
export const LOOKUP_DELAY_MS = 600;

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export interface ServerSweepCtx {
  api: DiscordApi;
  /** Public endpoints (widget, invite lookup), without the login. */
  fetch: Fetch;
  origin?: string;
  target: number;
  /** Invite codes and guild ids already collected. */
  knownCodes: Set<string>;
  knownGuilds: Set<string>;
  count(): number;
  add(rec: ServerRecord): void;
  stopped(): boolean;
  log(text: string, tone?: "ok" | "drop" | "skip" | "info" | "error"): void;
  progress(p: { considered: number; dropped: number }): void;
  sleep(ms: number): Promise<void>;
}

interface Guild {
  id: string;
  name: string;
  icon: string | null;
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const iconUrl = (id: string, icon: string | null | undefined): string | null => (icon ? `https://cdn.discordapp.com/icons/${id}/${icon}.${icon.startsWith("a_") ? "gif" : "png"}?size=64` : null);
const reached = (c: ServerSweepCtx): boolean => c.target > 0 && c.count() >= c.target;

async function publicJson(c: ServerSweepCtx, path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const r = await c.fetch(`${c.origin ?? "https://discord.com"}/api/v9${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: r.status, body };
}

/** Discover: search, then each result's widget for a public invite. */
export async function sweepDiscover(c: ServerSweepCtx, query: string): Promise<void> {
  const capturedAt = new Date().toISOString();
  let considered = 0;
  let dropped = 0;
  c.log(c.target > 0 ? `Searching Discover for "${query}" - target ${c.target} invite(s).` : `Searching Discover for "${query}" - no target, collecting everything.`);
  for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
    if (c.stopped() || reached(c)) break;
    let res: { guilds?: Guild[]; total_count?: number };
    try {
      res = await c.api("GET", `/discoverable-guilds/search?query=${encodeURIComponent(query)}&limit=${DISCOVER_PAGE}&offset=${page * DISCOVER_PAGE}`);
    } catch (e) {
      c.log(`Discover search failed: ${errText(e)}`, "error");
      break;
    }
    const guilds = res.guilds ?? [];
    if (page === 0) c.log(`Discover has ${res.total_count ?? guilds.length} server(s) for "${query}".`);
    if (guilds.length === 0) break;
    for (const g of guilds) {
      if (c.stopped()) break;
      if (reached(c)) {
        c.log(`Target of ${c.target} invite(s) reached.`);
        break;
      }
      if (c.knownGuilds.has(g.id)) continue;
      c.knownGuilds.add(g.id);
      considered++;
      let invite: string | null = null;
      try {
        const w = await publicJson(c, `/guilds/${g.id}/widget.json`);
        invite = w.status === 200 ? normalizeInvite(typeof w.body?.instant_invite === "string" ? w.body.instant_invite : null) : null;
        if (!invite) {
          dropped++;
          c.log(`SKIP ${g.name}: ${w.status === 200 ? "its widget offers no invite" : "no public invite (widget off)"}.`, "skip");
        }
      } catch (e) {
        dropped++;
        c.log(`SKIP ${g.name}: could not read its widget (${errText(e)}).`, "skip");
      }
      if (invite && !c.knownCodes.has(inviteCode(invite))) {
        c.knownCodes.add(inviteCode(invite));
        c.add({ invite, name: g.name, guild_id: g.id, members: g.approximate_member_count ?? null, online: g.approximate_presence_count ?? null, icon_url: iconUrl(g.id, g.icon), source: `discover: ${query}`, captured_at: capturedAt });
        c.log(`Invite collected of server: ${g.name} — ${invite}`, "ok");
      }
      c.progress({ considered, dropped });
      await c.sleep(WIDGET_DELAY_MS);
    }
    if (guilds.length < DISCOVER_PAGE) break;
    await c.sleep(DISCOVER_PAGE_DELAY_MS);
  }
  if (considered === 0) c.log("Discover found nothing new for that term.");
  else if (c.target > 0 && !reached(c) && !c.stopped()) c.log(`Discover is exhausted for "${query}" and the target is still ${Math.max(c.target - c.count(), 0)} short. Try another term.`);
}

interface Msg {
  id: string;
  content?: string;
  embeds?: { url?: string; title?: string; description?: string }[];
}

/** Reader: a channel's messages, newest first, scanned for invites; each found invite looked up for its server. */
export async function sweepReader(c: ServerSweepCtx, channelText: string): Promise<void> {
  const ch = parseChannel(channelText);
  if (!ch) {
    c.log("Reader needs a channel link (https://discord.com/channels/<server>/<channel>) or a channel id.", "error");
    return;
  }
  const capturedAt = new Date().toISOString();
  let label = ch.channel;
  try {
    const info = await c.api<{ name?: string }>("GET", `/channels/${ch.channel}`);
    if (info.name) label = `#${info.name}`;
  } catch (e) {
    c.log(`Can't read that channel: ${errText(e)}`, "error");
    return;
  }
  c.log(`Reading ${label}, newest first${c.target > 0 ? ` - target ${c.target} invite(s)` : ""}.`);
  let before = "";
  let considered = 0;
  let scanned = 0;
  for (let page = 0; page < READER_MAX_PAGES; page++) {
    if (c.stopped() || reached(c)) break;
    let msgs: Msg[];
    try {
      msgs = await c.api<Msg[]>("GET", `/channels/${ch.channel}/messages?limit=${READER_PAGE}${before ? `&before=${before}` : ""}`);
    } catch (e) {
      c.log(`Reading ${label} failed: ${errText(e)}`, "error");
      break;
    }
    if (!Array.isArray(msgs) || msgs.length === 0) break;
    scanned += msgs.length;
    before = msgs[msgs.length - 1]!.id;
    const found = new Set<string>();
    for (const m of msgs) {
      const text = [m.content ?? "", ...(m.embeds ?? []).flatMap((e) => [e.url ?? "", e.title ?? "", e.description ?? ""])].join("\n");
      for (const u of extractInviteUrls(text)) if (!c.knownCodes.has(inviteCode(u))) found.add(u);
    }
    for (const invite of found) {
      if (c.stopped() || reached(c)) break;
      c.knownCodes.add(inviteCode(invite));
      considered++;
      let name: string | null = null;
      let gid: string | null = null;
      let members: number | null = null;
      let online: number | null = null;
      let icon: string | null = null;
      try {
        const r = await publicJson(c, `/invites/${encodeURIComponent(inviteCode(invite))}?with_counts=true`);
        if (r.status === 404) {
          c.log(`SKIP ${invite}: invite expired or invalid.`, "skip");
          c.progress({ considered, dropped: 0 });
          await c.sleep(LOOKUP_DELAY_MS);
          continue;
        }
        const g = (r.body?.guild ?? null) as Guild | null;
        if (g) {
          name = g.name;
          gid = g.id;
          icon = iconUrl(g.id, g.icon);
          members = typeof r.body?.approximate_member_count === "number" ? r.body.approximate_member_count : null;
          online = typeof r.body?.approximate_presence_count === "number" ? r.body.approximate_presence_count : null;
        }
      } catch {
        // kept without its server's name
      }
      if (gid && c.knownGuilds.has(gid)) {
        c.log(`SKIP ${name ?? invite}: already collected.`, "skip");
      } else {
        if (gid) c.knownGuilds.add(gid);
        c.add({ invite, name, guild_id: gid, members, online, icon_url: icon, source: `reader: ${label}`, captured_at: capturedAt });
        c.log(`Invite collected of server: ${name ?? "unknown server"} — ${invite}`, "ok");
      }
      c.progress({ considered, dropped: 0 });
      await c.sleep(LOOKUP_DELAY_MS);
    }
    if (msgs.length < READER_PAGE) break;
    await c.sleep(READER_PAGE_DELAY_MS);
  }
  c.log(`Scanned ${scanned} message(s) in ${label}.`);
}
