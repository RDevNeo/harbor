import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInviteUrls, normalizeInvite, parseChannel } from "../lib/invites.ts";
import { handleOf, ytParseCount, ytSearchParam, ytParseFeed, ytUnwrapRedirect, ytChannelsFromSearch, ytUploadersFromSearch, ytParseAbout } from "../lib/youtube.ts";
import { discoveryAppetite, sweepYouTube, type SweepCtx } from "../lib/sweep.ts";
import { sweepDiscover, sweepReader, type ServerSweepCtx } from "../lib/discord.ts";
import { exportText, migrate, defaultData, type CreatorRecord, type ServerRecord } from "../lib/types.ts";
import { Collector, collectorRoute } from "../engine.ts";
import { compact } from "../view.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-25T12:00:00Z");

describe("invites", () => {
  it("normalizes and dedupes like the userscript", () => {
    expect(normalizeInvite("discord.gg/abc123).")).toBe("https://discord.gg/abc123");
    expect(normalizeInvite("https://www.discord.com/invite/XyZ/")).toBe("https://discord.com/invite/XyZ");
    expect(normalizeInvite("https://example.com/x")).toBeNull();
    expect(extractInviteUrls("join https://discord.gg/aa and discord.gg/aa, or discord.com/invite/bb!")).toEqual(["https://discord.gg/aa", "https://discord.com/invite/bb"]);
  });
  it("reads a channel link or id", () => {
    expect(parseChannel("https://discord.com/channels/111111111111111111/222222222222222222")).toEqual({ guild: "111111111111111111", channel: "222222222222222222" });
    expect(parseChannel("222222222222222222")).toEqual({ guild: null, channel: "222222222222222222" });
    expect(parseChannel("nope")).toBeNull();
  });
});

describe("youtube parsing", () => {
  it("builds the sp filter", () => {
    expect(ytSearchParam({ type: 2 })).toBe("EgIQAg%3D%3D");
    expect(ytSearchParam({})).toBe("");
  });
  it("parses localized counts, hidden as null", () => {
    expect(ytParseCount("3.15M subscribers")).toBe(3_150_000);
    expect(ytParseCount("1,2 mi de inscritos")).toBe(1_200_000);
    expect(ytParseCount("383 mil inscritos")).toBe(383_000);
    expect(ytParseCount("440,004,410 views")).toBe(440_004_410);
    expect(ytParseCount("3.15 million subscribers")).toBe(3_150_000);
    expect(ytParseCount("")).toBeNull();
  });
  it("keeps accented handles whole", () => {
    expect(handleOf("https://www.youtube.com/@Fam%C3%ADliaRobloxs2")).toBe("@FamíliaRobloxs2");
    expect(handleOf("/@jujubotv")).toBe("@jujubotv");
  });
  it("unwraps redirects", () => {
    expect(ytUnwrapRedirect("https://www.youtube.com/redirect?event=x&q=https%3A%2F%2Fdiscord.gg%2Fkk")).toBe("https://discord.gg/kk");
  });
  it("reads channel results with the swapped field names", () => {
    const data = { a: [{ channelRenderer: { channelId: "UC1", title: { simpleText: "Kauã" }, subscriberCountText: { simpleText: "@kaua" }, videoCountText: { simpleText: "154K subscribers" }, navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: "/@kaua" } }, thumbnail: { thumbnails: [{ url: "//yt3/a.jpg" }] } } }] };
    expect(ytChannelsFromSearch(data)).toEqual([{ channelId: "UC1", name: "Kauã", handle: "@kaua", profileUrl: "https://www.youtube.com/@kaua", avatarUrl: "https://yt3/a.jpg", subscribers: 154_000, description: "" }]);
    const vids = { x: [{ videoRenderer: { ownerText: { runs: [{ text: "K4", navigationEndpoint: { browseEndpoint: { browseId: "UC2", canonicalBaseUrl: "/@k4" } } }] } } }, { shortsLockupViewModel: { o: { browseId: "UC3" } } }] };
    expect(ytUploadersFromSearch(vids).map((c) => [c.channelId, c.handle])).toEqual([["UC2", "@k4"], ["UC3", null]]);
  });
  it("reads About links from the tap command", () => {
    const data = { aboutChannelViewModel: { canonicalChannelUrl: "http://www.youtube.com/@g", subscriberCountText: "3.11M subscribers", country: "Brazil", links: [{ channelExternalLinkViewModel: { title: { content: "Discord" }, link: { content: "discord.gg/g", commandRuns: [{ onTap: { innertubeCommand: { urlEndpoint: { url: "https://www.youtube.com/redirect?q=https%3A%2F%2Fdiscord.gg%2Fg" } } } }] } } }] }, microformatDataRenderer: { title: "Gelado" } };
    const a = ytParseAbout(data);
    expect(a.profileUrl).toBe("https://www.youtube.com/@g");
    expect(a.links).toEqual([{ label: "Discord", url: "https://discord.gg/g" }]);
    expect(a.subscribers).toBe(3_110_000);
  });
  it("reads the feed's entries, not the channel's own date", () => {
    const xml = `<feed><published>2010-01-01T00:00:00Z</published><entry><yt:videoId>a</yt:videoId><title>Old &amp; gold</title><published>2026-11-01T00:00:00Z</published></entry><entry><yt:videoId>b</yt:videoId><title>New</title><link rel="alternate" href="https://www.youtube.com/shorts/b"/><published>2026-11-20T00:00:00Z</published><media:statistics views="12"/></entry></feed>`;
    const f = ytParseFeed(xml);
    expect(f.newest).toBe(Date.parse("2026-11-20T00:00:00Z"));
    expect(f.videos.map((v) => [v.video_id, v.is_short, v.view_count])).toEqual([["b", true, 12], ["a", false, null]]);
    expect(f.videos[1]!.title).toBe("Old & gold");
  });
});

/** A fake YouTube: N channels per search page, one continuation page, feed ages by id. */
function fakeYt(ages: Record<string, number | null>) {
  const ids = Object.keys(ages);
  const page = (from: number) => ({ contents: ids.slice(from, from + 3).map((id) => ({ channelRenderer: { channelId: id, title: { simpleText: id } } })), ...(from + 3 < ids.length ? { c: { continuationCommand: { token: String(from + 3) } } } : {}) });
  const calls: string[] = [];
  return {
    calls,
    search: async (_q: string, sp: { type?: number }) => (calls.push("search"), sp.type === 2 ? page(0) : {}),
    continuation: async (t: string) => (calls.push("cont"), page(Number(t))),
    feed: async (id: string) => {
      calls.push(`feed:${id}`);
      const a = ages[id];
      if (a === undefined) throw new Error("feed HTTP 404");
      return { newest: a === null ? null : NOW - a * DAY, videos: a === null ? [] : [{ video_id: "v", title: "t", url: "u", thumbnail_url: null, published_at: new Date(NOW - a * DAY).toISOString(), view_count: 1, is_short: false }] };
    },
    about: async (id: string) => (calls.push(`about:${id}`), { name: `N ${id}`, handle: `@${id}`, profileUrl: `https://y/@${id}`, avatarUrl: null, subscribers: 10, videos: 2, views: 3, description: null, country: null, links: [] }),
  };
}

function sweepCtx(yt: ReturnType<typeof fakeYt>, target: number, gapDays: number, out: CreatorRecord[]): SweepCtx {
  return { yt, query: "q", target, gapDays, known: new Set(), count: () => out.length, add: (r) => out.push(r), stopped: () => false, log: () => {}, progress: () => {}, sleep: async () => {}, now: () => NOW };
}

describe("youtube sweep", () => {
  it("drops dead channels before reading About, and stops at the target", async () => {
    const yt = fakeYt({ UCa: 2, UCb: 40, UCc: null, UCd: 1, UCe: 3, UCf: 5 });
    const out: CreatorRecord[] = [];
    await sweepYouTube(sweepCtx(yt, 3, 14, out));
    expect(out.map((r) => r.platform_id)).toEqual(["UCa", "UCd", "UCe"]);
    expect(yt.calls).not.toContain("about:UCb");
    expect(yt.calls).not.toContain("about:UCc");
    expect(out[0]!.recent_videos?.length).toBe(1);
    expect(out[0]!.discovered_via).toBe("q");
  });
  it("on Any time reads no feed and leaves recent_videos out", async () => {
    const yt = fakeYt({ UCa: 400 });
    const out: CreatorRecord[] = [];
    await sweepYouTube(sweepCtx(yt, 0, 0, out));
    expect(out.length).toBe(1);
    expect(yt.calls.some((c) => c.startsWith("feed"))).toBe(false);
    expect("recent_videos" in out[0]!).toBe(false);
  });
  it("sizes discovery from the keep rate", () => {
    expect(discoveryAppetite(10, 0, { considered: 0, kept: 0, dropped: 0, discovered: 0 })).toBe(Math.ceil(10 / 0.6) + 5);
    expect(discoveryAppetite(10, 10, { considered: 20, kept: 10, dropped: 10, discovered: 20 })).toBe(0);
  });
});

function serverCtx(api: ServerSweepCtx["api"], widgets: Record<string, string | null>, out: ServerRecord[], target = 0): ServerSweepCtx {
  return {
    api,
    fetch: async (url: string) => {
      const id = url.match(/guilds\/(\d+)\/widget/)?.[1];
      if (id) return new Response(JSON.stringify(widgets[id] === null ? { message: "Widget Disabled" } : { instant_invite: widgets[id] }), { status: widgets[id] === null ? 403 : 200 });
      const code = url.match(/invites\/([^?]+)/)?.[1];
      if (code === "dead") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ guild: { id: `g-${code}`, name: `S ${code}`, icon: null }, approximate_member_count: 50 }));
    },
    target,
    knownCodes: new Set(),
    knownGuilds: new Set(),
    count: () => out.length,
    add: (r) => out.push(r),
    stopped: () => false,
    log: () => {},
    progress: () => {},
    sleep: async () => {},
  };
}

describe("discord servers", () => {
  it("Discover keeps servers whose widget gives an invite", async () => {
    const out: ServerRecord[] = [];
    const api = (async (_m: string, p: string) => (p.includes("offset=0") ? { total_count: 3, guilds: [{ id: "1", name: "A", icon: "h", approximate_member_count: 10 }, { id: "2", name: "B", icon: null }, { id: "3", name: "C", icon: null }] } : { guilds: [] })) as ServerSweepCtx["api"];
    await sweepDiscover(serverCtx(api, { "1": "https://discord.com/invite/aa", "2": null, "3": "https://discord.com/invite/cc" }, out), "robux");
    expect(out.map((s) => [s.invite, s.name, s.members])).toEqual([["https://discord.com/invite/aa", "A", 10], ["https://discord.com/invite/cc", "C", null]]);
    expect(out[0]!.icon_url).toBe("https://cdn.discordapp.com/icons/1/h.png?size=64");
  });
  it("Reader scans messages and looks invites up", async () => {
    const out: ServerRecord[] = [];
    const api = (async (_m: string, p: string) => (p.startsWith("/channels/222222222222222222/messages") ? (p.includes("before") ? [] : [{ id: "9", content: "discord.gg/xx and https://discord.gg/dead" }, { id: "8", content: "", embeds: [{ url: "https://discord.gg/xx" }] }]) : { name: "promo" })) as ServerSweepCtx["api"];
    await sweepReader(serverCtx(api, {}, out), "https://discord.com/channels/111111111111111111/222222222222222222");
    expect(out.map((s) => [s.invite, s.name, s.members, s.source])).toEqual([["https://discord.gg/xx", "S xx", 50, "reader: #promo"]]);
  });
});

describe("data and routes", () => {
  it("exports JSONL, one record per line", () => {
    const d = defaultData();
    d.creators = [{ platform: "youtube", platform_id: "UC1", name: "A" } as CreatorRecord, { platform: "youtube", platform_id: "UC2", name: "B" } as CreatorRecord];
    expect(exportText(d, "creators").split("\n").map((l) => JSON.parse(l).platform_id)).toEqual(["UC1", "UC2"]);
    expect(migrate({ settings: { gapDays: 3, targets: { creators: "120" } } }).settings).toMatchObject({ gapDays: 14, targets: { creators: 120, servers: 50 } });
    expect(compact(3_110_000)).toBe("3.1M");
    expect(compact(154_000)).toBe("154K");
  });
  it("runs a sweep from the routes and persists it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const yt = fakeYt({ UCa: 1, UCb: 2 });
    const c = new Collector(dir, { offline: false, changed: () => {}, log: () => {}, discord: () => ({ connected: false, account: null }), youtube: yt as never, sleep: async () => {}, fetch: async () => new Response("", { status: 404 }) });
    const call = (method: string, path: string, body: unknown = null, query: [string, string][] = []) => collectorRoute(c, { method, path: ["v1", "collector", ...path.split("/").filter(Boolean)], query, body, token: "", device: "", global: false } as never);
    expect((await call("POST", "start", { tab: "creators", query: "" }))!.status).toBe(409);
    expect(((await call("POST", "start", { platform: "tiktok", query: "x" }))!.body as { error: string }).error).toContain("Not available yet");
    await call("POST", "settings", { platform: "youtube", query: "blox", target: 0, gapDays: 7 });
    expect((await call("POST", "start"))!.status).toBe(200);
    await c.settled();
    const v = (await call("GET", ""))!.body as { counts: { creators: number }; run: { running: boolean } };
    expect(v.counts.creators).toBe(2);
    expect(v.run.running).toBe(false);
    const ex = (await call("GET", "export", null, [["tab", "creators"]]))!.body as { text: string; count: number };
    expect(ex.count).toBe(2);
    expect((await call("POST", "start", { tab: "servers", serverQuery: "x" }))!.status).toBe(409);
    await c.flush();
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).creators.length).toBe(2);
  });
});
