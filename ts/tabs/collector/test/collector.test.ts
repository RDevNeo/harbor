import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YouTube, handleOf, ytParseCount, ytSearchParam, ytParseFeed, ytUnwrapRedirect, ytUploadersFromSearch, ytParseAbout } from "../lib/youtube.ts";
import { discoveryAppetite, sweepYouTube, type SweepCtx } from "../lib/sweep.ts";
import { exportText, migrate, defaultData, type CreatorRecord } from "../lib/types.ts";
import { Collector, collectorRoute, type CollectorDeps } from "../engine.ts";
import { compact } from "../view.ts";
import { extractUrls, normalizeUrl, profileKeyOf, kindOf, whatsappOf } from "../lib/links.ts";
import { bestEmail, extractEmails } from "../lib/email.ts";
import { enrich, linktreeLinks } from "../lib/enrich.ts";
import { allKeys } from "../lib/identity.ts";
import { fillTemplate, loadTemplates, templatesToSave } from "../lib/templates.ts";
import { sweepSocial, type Profile, type SocialClient } from "../lib/social.ts";
import { fakePersons, livePersons, type SendInput } from "../persons-bridge.ts";
import { brandOf, linkTitle, normalizeReach, parseLinks, reachError, reachHref } from "../lib/reach.ts";
import { crmRecord } from "../lib/crm.ts";
import type { DetailView } from "../view.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-25T12:00:00Z");

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
  it("goes from search results' videos to their channels, in the page's order, channel results left out", () => {
    const owner = (id: string, handle: string) => ({ runs: [{ text: id, navigationEndpoint: { browseEndpoint: { browseId: id, canonicalBaseUrl: `/${handle}` } } }] });
    const page = {
      x: [
        { videoRenderer: { videoId: "v1", ownerText: owner("UC2", "@k4") } },
        { channelRenderer: { channelId: "UC9", title: { simpleText: "Only a channel" } } },
        { reelShelfRenderer: { items: [{ shortsLockupViewModel: { onTap: { reelWatchEndpoint: { videoId: "s1" } }, o: { browseId: "UC3" } } }] } },
        { videoRenderer: { videoId: "v2", ownerText: owner("UC2", "@k4") } },
        { videoRenderer: { videoId: "v3", longBylineText: owner("UC4", "@k5") } },
      ],
    };
    expect(ytUploadersFromSearch(page).map((c) => [c.channelId, c.handle, c.videoUrl])).toEqual([
      ["UC2", "@k4", "https://www.youtube.com/watch?v=v1"],
      ["UC3", null, "https://www.youtube.com/shorts/s1"],
      ["UC4", "@k5", "https://www.youtube.com/watch?v=v3"],
    ]);
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

/** A fake YouTube: 3 videos (one per channel) per search page, continuation pages, feed ages by id. Only the first
 * pass (the plain search) has results. */
function fakeYt(ages: Record<string, number | null>) {
  const ids = Object.keys(ages);
  const page = (from: number) => ({
    contents: ids.slice(from, from + 3).map((id) => ({ videoRenderer: { videoId: `v-${id}`, ownerText: { runs: [{ text: id, navigationEndpoint: { browseEndpoint: { browseId: id } } }] } } })),
    ...(from + 3 < ids.length ? { c: { continuationCommand: { token: String(from + 3) } } } : {}),
  });
  const calls: string[] = [];
  return {
    calls,
    search: async (_q: string, sp: { type?: number }) => (calls.push("search"), sp.type === undefined ? page(0) : {}),
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
  return { yt, query: "q", target, gapDays, isKnown: () => false, enrich: async (r) => r, count: () => out.length, add: (r) => (out.push(r), null), stopped: () => false, log: () => {}, progress: () => {}, sleep: async () => {}, now: () => NOW };
}

describe("youtube client", () => {
  it("searches as Brazil (gl=BR, hl=pt, pt-BR) and reads About in English with gl=BR", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const page = `<script>var ytcfg={"INNERTUBE_API_KEY":"K","HL":"pt","GL":"BR"};var ytInitialData = {"contents":{}};</script>`;
    const f = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return url.includes("/youtubei/") ? new Response("{}") : new Response(page);
    };
    const yt = new YouTube(f);
    await yt.search("roblox", {}).catch(() => null);
    await yt.continuation("TOKEN");
    await yt.about("UC123").catch(() => null);
    const search = new URL(calls[0]!.url);
    expect(search.searchParams.get("gl")).toBe("BR");
    expect(search.searchParams.get("hl")).toBe("pt");
    expect((calls[0]!.init!.headers as Record<string, string>)["Accept-Language"]).toStartWith("pt-BR");
    const ctx = JSON.parse(String(calls[1]!.init!.body)).context.client;
    expect(ctx).toMatchObject({ hl: "pt", gl: "BR" });
    const about = new URL(calls[2]!.url);
    expect(about.searchParams.get("gl")).toBe("BR");
    expect(about.searchParams.get("hl")).toBe("en");
  });
});

describe("youtube sweep", () => {
  it("drops dead channels before reading About, and stops at the target", async () => {
    const yt = fakeYt({ UCa: 2, UCb: 40, UCc: null, UCd: 1, UCe: 3, UCf: 5 });
    const out: CreatorRecord[] = [];
    await sweepYouTube(sweepCtx(yt, 3, 14, out));
    expect(out.map((r) => r.platform_id)).toEqual(["UCa", "UCd", "UCe"]);
    expect(yt.calls).not.toContain("about:UCb");
    expect(yt.calls).not.toContain("about:UCc");
    expect(out[0]!.recent_videos?.length).toBe(1);
    expect([out[0]!.discovered_via, out[0]!.found_video]).toEqual(["q", "https://www.youtube.com/watch?v=v-UCa"]);
  });
  it("on Any time keeps old channels, still with their newest videos; a feed that fails drops nobody", async () => {
    const yt = fakeYt({ UCa: 400, UCz: undefined as unknown as null });
    const out: CreatorRecord[] = [];
    await sweepYouTube(sweepCtx(yt, 0, 0, out));
    expect(out.map((r) => [r.platform_id, r.recent_videos?.length ?? 0])).toEqual([["UCa", 1], ["UCz", 0]]);
  });
  it("sizes discovery from the keep rate", () => {
    expect(discoveryAppetite(10, 0, { considered: 0, kept: 0, dropped: 0, discovered: 0, known: 0 })).toBe(Math.ceil(10 / 0.6) + 5);
    expect(discoveryAppetite(10, 10, { considered: 20, kept: 10, dropped: 10, discovered: 20, known: 0 })).toBe(0);
  });
});

describe("links and emails", () => {
  it("finds every link in a bio, bare domains too, normalized", () => {
    const bio = "Parcerias 📩 contato [arroba] kauablox [ponto] com\nInsta: instagram.com/Kaua.Blox | tiktok.com/@kaua?lang=pt\nhttps://linktr.ee/kaua). wa.me/5511999998888 https://www.youtube.com/redirect?q=https%3A%2F%2Fdiscord.gg%2Fkk&v=1";
    expect(extractUrls(bio)).toEqual([
      "https://instagram.com/Kaua.Blox",
      "https://tiktok.com/@kaua?lang=pt",
      "https://linktr.ee/kaua",
      "https://wa.me/5511999998888",
      "https://discord.gg/kk",
    ]);
    expect(normalizeUrl("HTTPS://WWW.Site.com.br/?utm_source=x")).toBe("https://site.com.br");
    expect(normalizeUrl("https://l.instagram.com/?u=https%3A%2F%2Fbeacons.ai%2Fx%3Ffbclid%3D1&e=2")).toBe("https://beacons.ai/x");
    expect(kindOf("https://linktr.ee/kaua")).toBe("linkinbio");
    expect(profileKeyOf("https://instagram.com/Kaua.Blox")).toBe("instagram:@kaua.blox");
    expect(profileKeyOf("https://www.instagram.com/p/abc/")).toBeNull();
    expect(profileKeyOf("https://tiktok.com/@kaua?lang=pt")).toBe("tiktok:@kaua");
    expect(profileKeyOf("https://youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa")).toBe("youtube:UCaaaaaaaaaaaaaaaaaaaaaa");
    expect(whatsappOf(["https://wa.me/5511999998888"])).toBe("5511999998888");
    expect(whatsappOf([], "Whats: (11) 99999-8888")).toBe("5511999998888");
  });
  it("finds emails, disguised ones too, and leaves junk out", () => {
    expect(extractEmails("📩 Parcerias: parcerias@kauablox.com.br")).toEqual(["parcerias@kauablox.com.br"]);
    expect(extractEmails("contato [arroba] kauablox [ponto] com")).toEqual(["contato@kauablox.com"]);
    expect(extractEmails("biz (at) gmail (dot) com · logo@2x.png · noreply@site.com · a@example.com")).toEqual(["biz@gmail.com"]);
    expect(extractEmails('<a href="mailto:Oi@Canal.com?subject=x">')).toEqual(["oi@canal.com"]);
    expect(bestEmail(["fan@gmail.com", "contato@canal.com"])).toBe("contato@canal.com");
  });
  it("opens link-in-bio pages for links and an email, then their site", async () => {
    const next = { props: { pageProps: { links: [{ title: "Minha loja", url: "https://lojadokaua.com.br" }, { title: "GROUP", url: "" }], socialLinks: [{ type: "TIKTOK", url: "https://www.tiktok.com/@kaua" }, { type: "EMAIL_ADDRESS", url: "mailto:kaua@gmail.com" }] } } };
    expect(linktreeLinks(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`).map((l) => l.url)).toEqual(["https://lojadokaua.com.br", "https://www.tiktok.com/@kaua", "mailto:kaua@gmail.com"]);
    const pages: Record<string, string> = {
      "https://linktr.ee/kaua": `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { links: [{ title: "Loja", url: "https://lojadokaua.com.br" }] } } })}</script>`,
      "https://lojadokaua.com.br": `<a href="/contato">Contato</a>`,
      "https://lojadokaua.com.br/contato": `Fale com a gente: suporte@lojadokaua.com.br`,
    };
    const seen: string[] = [];
    const f = (async (url: string) => (seen.push(url), pages[url] ? new Response(pages[url], { headers: { "content-type": "text/html" } }) : new Response("", { status: 404 }))) as never;
    const e = await enrich({ fetch: f, sleep: async () => {} }, { links: [{ label: "Linktree", url: "https://linktr.ee/kaua" }], bio: "insta: instagram.com/kaua", bioSource: "YouTube About" });
    expect(e.links.map((l) => [l.url, l.source ?? ""])).toEqual([
      ["https://linktr.ee/kaua", ""],
      ["https://instagram.com/kaua", "YouTube About"],
      ["https://lojadokaua.com.br", "linktr.ee/kaua"],
    ]);
    expect(e.email).toEqual({ email: "suporte@lojadokaua.com.br", source: "site lojadokaua.com.br/contato" });
    expect(seen).toEqual(["https://linktr.ee/kaua", "https://lojadokaua.com.br", "https://lojadokaua.com.br/contato"]);
  });
});

const rec = (o: Partial<CreatorRecord> & { platform: string; platform_id: string }): CreatorRecord => ({
  name: o.platform_id,
  handle: null,
  profile_url: null,
  avatar_url: null,
  subscriber_count: 10,
  video_count: 1,
  view_count: null,
  description: null,
  links: [],
  country: null,
  discovered_via: "q",
  captured_at: new Date(NOW).toISOString(),
  ...o,
});

describe("templates", () => {
  it("fills the name, or drops it cleanly", () => {
    expect(fillTemplate("Olá {name}, tudo bem? @{handle}", { name: "Kauã", handle: "kaua" })).toBe("Olá Kauã, tudo bem? @kaua");
    expect(fillTemplate("Olá {name}, tudo bem?", { name: "" })).toBe("Olá, tudo bem?");
  });
  it("keeps edits of built-ins and the user's own, nothing else", () => {
    const list = loadTemplates([{ id: "padrao", name: "Padrão", description: "d", subject: "Novo assunto", body: "b" }, { id: "t_1", name: "Meu", description: "", subject: "s", body: "oi {name}" }]);
    expect(list.map((t) => t.id)).toEqual(["padrao", "loja-parceira", "site-da-loja", "t_1", "blank"]);
    expect(list[0]!.subject).toBe("Novo assunto");
    expect(templatesToSave(list).map((t) => t.id)).toEqual(["padrao", "t_1"]);
  });
});

/** A fake social platform: accounts by handle, discovery in one batch. */
function fakeSocial(platform: "tiktok" | "instagram", accounts: Record<string, Partial<Profile>>): SocialClient & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async profile(h) {
      reads.push(h);
      const a = accounts[h];
      if (!a) throw new Error("not found");
      return { platform, platform_id: `id-${h}`, name: h, handle: `@${h}`, profile_url: `https://www.${platform}.com/@${h}`, avatar_url: null, followers: 100, posts: 5, likes: 9, bio: null, links: [], email: null, country: null, last_post_at: new Date(NOW - DAY).toISOString(), recent: [], private: false, precision: "exact", ...a };
    },
    async *discover() {
      yield Object.keys(accounts).map((handle) => ({ handle }));
    },
  };
}

function deps(over: Partial<CollectorDeps> = {}): CollectorDeps {
  return { offline: false, changed: () => {}, log: () => {}, persons: fakePersons(), sleep: async () => {}, fetch: async () => new Response("", { status: 404 }), ...over };
}

const caller = (c: Collector) => (method: string, path: string, body: unknown = null, query: [string, string][] = []) =>
  collectorRoute(c, { method, path: ["v1", "collector", ...path.split("/").filter(Boolean)], query, body, token: "", device: "", global: false } as never);

describe("tiktok's Brazil filter", () => {
  it("skips videos with nothing Portuguese unread, keeps creators whose video was made in Brazil, as Brazil", async () => {
    const made: Record<string, string | null> = { ana: "BR", beto: "PT", carla: null, dani: null, eva: "BR" };
    const reads: string[] = [];
    const looked: string[] = [];
    const client: SocialClient = {
      async profile(h) {
        reads.push(h);
        return { platform: "tiktok", platform_id: `id-${h}`, name: h, handle: `@${h}`, profile_url: `https://www.tiktok.com/@${h}`, avatar_url: null, followers: 100, posts: 5, likes: 9, bio: null, links: [], email: null, country: null, last_post_at: new Date(NOW - DAY).toISOString(), recent: [], private: false, precision: "exact" };
      },
      async *discover() {
        yield [
          { handle: "ana", pt: "caption", videoUrl: "https://www.tiktok.com/@ana/video/1" },
          { handle: "beto", pt: "clear", videoUrl: "https://www.tiktok.com/@beto/video/2" },
          { handle: "carla", pt: "caption", videoUrl: "https://www.tiktok.com/@carla/video/3" },
          { handle: "dani", pt: "clear", videoUrl: "https://www.tiktok.com/@dani/video/4" },
          { handle: "zed", videoUrl: "https://www.tiktok.com/@zed/video/5" },
          { handle: "eva", pt: "clear", videoUrl: "https://www.tiktok.com/@eva/video/6" },
        ];
      },
      async madeIn(url) {
        const h = url.split("/@")[1]!.split("/")[0]!;
        looked.push(h);
        return made[h] ?? null;
      },
    };
    const kept: CreatorRecord[] = [];
    const logs: string[] = [];
    const st = await sweepSocial({ platform: "tiktok", client, query: "q", target: 0, gapDays: 30, isKnown: () => false, enrich: async (r) => r, add: (r) => void kept.push(r) ?? null, count: () => kept.length, stopped: () => false, log: (t) => void logs.push(t), progress: () => {}, sleep: async () => {}, now: () => NOW });
    expect(looked).toEqual(["ana", "beto", "carla", "dani", "eva"]);
    expect(reads).toEqual(["ana", "dani", "eva"]);
    expect(kept.map((r) => [r.handle, r.country])).toEqual([["@ana", "Brazil"], ["@dani", null], ["@eva", "Brazil"]]);
    expect([st.kept, st.dropped]).toEqual([3, 3]);
    expect(logs).toContain("Skipped 1 creator whose video isn't in Portuguese.");
    expect(logs).toContain("DROP @beto: not Brazilian - their video was made in PT.");
  });

  it("without an answer from a video page keeps only clear Portuguese; stops when TikTok refuses reads in a row; other platforms aren't filtered", async () => {
    let reads = 0;
    let refuse = false;
    const base = {
      async profile(h: string): Promise<Profile> {
        reads++;
        if (refuse) throw new Error("TikTok HTTP 403");
        return { platform: "tiktok", platform_id: h, name: h, handle: `@${h}`, profile_url: "", avatar_url: null, followers: 1, posts: 1, likes: null, bio: null, links: [], email: null, country: null, last_post_at: new Date(NOW).toISOString(), recent: [], private: false, precision: "exact" };
      },
    };
    const many = Array.from({ length: 8 }, (_, i) => ({ handle: `u${i}`, pt: i % 2 ? ("caption" as const) : ("clear" as const), videoUrl: `https://www.tiktok.com/@u${i}/video/${i}` }));
    const client: SocialClient = { ...base, async *discover() { yield many; }, async madeIn() { throw new Error("TikTok video HTTP 403"); } };
    const logs: string[] = [];
    const kept: string[] = [];
    const ctx = { platform: "tiktok" as const, query: "q", target: 0, gapDays: 0, isKnown: () => false, enrich: async (r: CreatorRecord) => r, add: (r: CreatorRecord) => void kept.push(r.handle) ?? null, count: () => kept.length, stopped: () => false, log: (t: string) => void logs.push(t), progress: () => {}, sleep: async () => {}, now: () => NOW };
    await sweepSocial({ ...ctx, client });
    expect(kept).toEqual(["@u0", "@u2", "@u4", "@u6"]);
    refuse = true;
    reads = 0;
    kept.length = 0;
    await sweepSocial({ ...ctx, client });
    expect(logs.some((l) => l.includes("refused 5 reads in a row"))).toBe(true);
    expect(reads).toBe(2); // u0's video and profile, u1's video, u2's video and profile: the 5th refusal in a row
    reads = 0;
    refuse = false;
    const ig: SocialClient = { ...base, async *discover() { yield [{ handle: "a" }, { handle: "b" }]; } };
    const st = await sweepSocial({ ...ctx, platform: "instagram", client: ig });
    expect([reads, st.kept]).toEqual([2, 2]);
  });
});

describe("collector", () => {
  it("exports JSONL, one record per line, with the email and without Hub's own fields", () => {
    const d = defaultData();
    d.creators = [rec({ platform: "youtube", platform_id: "UC1", email: "a@b.com", email_source: "bio", email_manual: false, found_video: "https://y/v" }), rec({ platform: "youtube", platform_id: "UC2" }), rec({ platform: "youtube", platform_id: "UC3", restricted: true })];
    const lines = exportText(d).split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.platform_id)).toEqual(["UC1", "UC2"]);
    expect([lines[0].email, "found_video" in lines[0], "restricted" in lines[0], "email" in lines[1]]).toEqual(["a@b.com", false, false, false]);
    expect(migrate({ settings: { gapDays: 3, targets: { creators: "120", servers: 5 }, tab: "servers" }, servers: [{ invite: "x" }] }).settings).toMatchObject({ gapDays: 14, target: 120 });
    expect(compact(3_110_000)).toBe("3.1M");
  });
  it("migrates the old state: every creator kept, the daily update's leftovers dropped", () => {
    const old = { v: 2, settings: { platform: "tiktok", query: "q", gapDays: 7, target: 30, daily: true }, creators: [{ ...rec({ platform: "youtube", platform_id: "UC1" }), history: [{ at: "x", changes: [] }], update_error: "boom" }], seen: ["youtube:UC1"], refresh: { running: true }, run: { running: false, label: "YouTube", query: "q", found: 1 } };
    const d = migrate(old);
    expect(d.creators.map((c) => c.platform_id)).toEqual(["UC1"]);
    expect(["history" in d.creators[0]!, "update_error" in d.creators[0]!, "refresh" in d, "daily" in d.settings]).toEqual([false, false, false, false]);
    expect([d.settings.platform, d.settings.target, d.run?.ids, d.seen]).toEqual(["tiktok", 30, [], ["youtube:UC1"]]);
  });
  it("runs a YouTube sweep from the routes and persists it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const yt = fakeYt({ UCa: 1, UCb: 2 });
    const c = new Collector(dir, deps({ youtube: yt as never }));
    const call = caller(c);
    expect((await call("POST", "start", { query: "" }))!.status).toBe(409);
    expect(((await call("POST", "start", { platform: "instagram", query: "x" }))!.body as { error: string }).error).toContain("signed-in");
    await call("POST", "settings", { platform: "youtube", query: "blox", target: 0, gapDays: 7 });
    expect((await call("POST", "start"))!.status).toBe(200);
    await c.settled();
    const v = (await call("GET", ""))!.body as { counts: { available: number }; run: { running: boolean; found: number; ids: string[] }; creators: { id: string; videos: unknown[] }[] };
    expect([v.counts.available, v.run.running, v.run.found, v.run.ids]).toEqual([2, false, 2, ["youtube:UCa", "youtube:UCb"]]);
    expect(v.creators.map((x) => [x.id, x.videos.length])).toEqual([["youtube:UCb", 1], ["youtube:UCa", 1]]);
    expect(((await call("GET", "export"))!.body as { count: number }).count).toBe(2);
    await c.flush();
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).creators.length).toBe(2);
  });
  it("a finished run notifies and counts on the tab until it's seen (GET unread, POST seen), kept across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const notes: { key: string; title: string; body: string }[] = [];
    const notify = (key: string, title: string, body: string): void => void notes.push({ key, title, body });
    const c = new Collector(dir, deps({ youtube: fakeYt({ UCa: 1, UCb: 2 }) as never, notify }));
    const call = caller(c);
    const unread = async (): Promise<number> => ((await call("GET", "unread"))!.body as { unread: number }).unread;
    expect(await unread()).toBe(0);
    await call("POST", "start", { platform: "youtube", query: "dress to impress", target: 0, gapDays: 0 });
    await c.settled();
    expect(notes).toEqual([{ key: "run", title: "Collector: done — 2 new leads for “dress to impress”", body: "YouTube: no more for this term." }]);
    expect(await unread()).toBe(1);
    expect(((await call("GET", ""))!.body as { unseen: number }).unseen).toBe(1);
    // A second run that finds nobody new still notifies, saying so; the count grows.
    await call("POST", "start", { platform: "youtube", query: "dress to impress", target: 0, gapDays: 0 });
    await c.settled();
    expect(notes[1]!.title).toBe("Collector: done — no new leads for “dress to impress”");
    expect(await unread()).toBe(2);
    await c.flush();
    // Hub restarted: the count is still there, until the tab is opened.
    const again = new Collector(dir, deps({}));
    const call2 = caller(again);
    expect(((await call2("GET", "unread"))!.body as { unread: number }).unread).toBe(2);
    expect((await call2("POST", "seen"))!.status).toBe(200);
    expect(((await call2("GET", "unread"))!.body as { unread: number }).unread).toBe(0);
  });
  it("a run cut by Hub closing neither notifies nor counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const notes: string[] = [];
    const yt = fakeYt({ UCa: 1 });
    const c = new Collector(dir, deps({ youtube: yt as never, notify: (_k, t) => void notes.push(t) }));
    await caller(c)("POST", "start", { platform: "youtube", query: "q", target: 0, gapDays: 0 });
    c.dispose();
    await c.stop();
    expect([notes, c.data.unseen]).toEqual([[], 0]);
  });
  it("says how a run ended: target reached, stopped early, an error", async () => {
    const { runNote } = await import("../engine.ts");
    const base = { query: "q", label: "TikTok", known: 0, failed: "", stopped: false, target: 1 };
    expect(runNote({ ...base, n: 1 })).toEqual({ title: "Collector: done — 1 new lead for “q”", body: "TikTok: the target (1) is in." });
    expect(runNote({ ...base, n: 0, stopped: true, known: 3 }).title).toBe("Collector: stopped — no new leads for “q”");
    expect(runNote({ ...base, n: 0, stopped: true, known: 3 }).body).toBe("TikTok: stopped before the target (1). 3 already collected, passed over.");
    expect(runNote({ ...base, n: 2, failed: "429" })).toEqual({ title: "Collector: stopped on an error — 2 new leads for “q”", body: "TikTok: 429" });
  });
  it("never collects anyone twice: not once restricted or removed, not on another platform, not when they're in Persons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const yt = fakeYt({ UCa: 1, UCb: 1 });
    // UCb's About links TikTok @tb; @pp is in Persons › Creators already.
    yt.about = async (id: string) => ({ name: `N ${id}`, handle: `@${id}`, profileUrl: `https://www.youtube.com/@${id}`, avatarUrl: null, subscribers: 10, videos: 2, views: 3, description: null, country: null, links: id === "UCb" ? [{ label: "TikTok", url: "https://www.tiktok.com/@tb" }] : [] });
    const tt = fakeSocial("tiktok", { tb: {}, pp: {}, fresh: {} });
    const c = new Collector(dir, deps({ youtube: yt as never, tiktok: tt, persons: fakePersons({ keys: ["tiktok:@pp"] }) }));
    const call = caller(c);
    await call("POST", "start", { platform: "youtube", query: "q", target: 0, gapDays: 0 });
    await c.settled();
    expect((await call("POST", "restrict", { id: "youtube:UCa", restricted: true }))!.status).toBe(200);
    await call("POST", "remove", { id: "youtube:UCb" });
    await call("POST", "start", { platform: "youtube", query: "q", target: 0, gapDays: 0 });
    await c.settled();
    expect(c.data.creators.map((x) => [x.platform_id, x.restricted])).toEqual([["UCa", true]]);
    expect(c.data.run?.ids).toEqual([]);
    await call("POST", "start", { platform: "tiktok", query: "q", target: 0, gapDays: 14 });
    await c.settled();
    expect(c.data.creators.filter((x) => !x.restricted).map((x) => x.handle)).toEqual(["@fresh"]);
    expect(tt.reads).toEqual(["fresh"]);
    expect(c.data.run?.known).toBe(2);
  });
  it("links a creator found on a second platform to the first instead of keeping both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const tt = fakeSocial("tiktok", { kaua: { links: [{ label: null, url: "https://youtube.com/@UCa" }] } });
    const yt = fakeYt({ UCa: 1 });
    const c = new Collector(dir, deps({ youtube: yt as never, tiktok: tt }));
    const call = caller(c);
    await call("POST", "start", { platform: "youtube", query: "q", target: 0, gapDays: 0 });
    await c.settled();
    expect(allKeys(c.data.creators[0]!)).toContain("youtube:@uca");
    await call("POST", "start", { platform: "tiktok", query: "q", target: 0, gapDays: 0 });
    await c.settled();
    expect(c.data.creators.length).toBe(1);
    expect(c.data.creators[0]!.links.map((l) => [l.url, l.source])).toEqual([["https://tiktok.com/@kaua", "same person"]]);
  });
  it("a typed email sticks; Send goes through Persons and marks the creator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const sent: SendInput[] = [];
    const c = new Collector(dir, deps({ persons: fakePersons({ sent }) }));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "Kauã", handle: "@kaua" }));
    const call = caller(c);
    expect((await call("POST", "email", { id: "youtube:UC1", email: "nope" }))!.status).toBe(400);
    await call("POST", "email", { id: "youtube:UC1", email: "Kaua@Canal.com" });
    expect([c.data.creators[0]!.email, c.data.creators[0]!.email_source, c.data.creators[0]!.email_manual]).toEqual(["kaua@canal.com", "typed", true]);
    const m = (await call("GET", "compose", null, [["id", "youtube:UC1"], ["template", "padrao"]]))!.body as { to: string; subject: string; text: string; channel: string };
    expect([m.to, m.subject, m.channel]).toEqual(["kaua@canal.com", "Sua loja profissional.", "creators-gmail"]);
    expect(m.text.startsWith("Olá Kauã, tudo bem?")).toBe(true);
    expect((await call("POST", "send", { id: "youtube:UC1", channel: "creators-gmail", to: m.to, subject: "", text: m.text }))!.status).toBe(409);
    const r = await call("POST", "send", { id: "youtube:UC1", channel: "creators-gmail", to: m.to, subject: m.subject, text: m.text, template: "padrao" });
    expect(r!.status).toBe(200);
    expect(sent.map((s) => [s.to, s.subject, s.rec.name])).toEqual([["kaua@canal.com", "Sua loja profissional.", "Kauã"]]);
    expect(c.data.creators[0]!.contacted?.via).toBe("gmail");
    expect(c.data.settings.lastTemplate).toBe("padrao");
  });
  it("Send message goes on every Persons › Creators channel (Gmail, WhatsApp, Discord, Instagram); a missing one says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const sent: SendInput[] = [];
    const persons = fakePersons({
      sent,
      channels: [
        { id: "creators-gmail", kind: "gmail", label: "Email", account: "igor@spokpay.com", connected: true },
        { id: "creators-discord", kind: "discord", label: "Discord", account: "spokpay", connected: true },
      ],
    });
    const c = new Collector(dir, deps({ persons }));
    c.data.creators.push(rec({ platform: "instagram", platform_id: "99", name: "Bia", handle: "@bia" }));
    const call = caller(c);
    await call("POST", "reach", { id: "instagram:99", kind: "discord", value: "123456789012345678" });
    type M = { channel: string; kind: string; to: string; subject: string; channels: { id: string; kind: string; to: string; connected: boolean; why: string }[] };
    const m = (await call("GET", "compose", null, [["id", "instagram:99"]]))!.body as M;
    expect(m.channels.map((x) => [x.id, x.to, x.connected])).toEqual([
      ["creators-gmail", "", true],
      ["none-whatsapp", "", false],
      ["creators-discord", "123456789012345678", true],
      ["none-instagram", "@bia", false],
    ]);
    // the Reach's channel first, no subject off email
    expect([m.channel, m.kind, m.to, m.subject]).toEqual(["creators-discord", "discord", "123456789012345678", ""]);
    expect(m.channels[1]!.why).toContain("Persons › Creators has no WhatsApp");
    expect(m.channels[0]!.why).toBe("No email yet: type one.");
    expect((await call("POST", "send", { id: "instagram:99", channel: "creators-discord", to: "12", text: "Oi" }))!.status).toBe(409);
    expect(((await call("POST", "send", { id: "instagram:99", channel: "none-instagram", to: "@bia", text: "Oi" }))!.body as { error: string }).error).toContain("has no Instagram");
    expect((await call("POST", "send", { id: "instagram:99", channel: "creators-discord", to: "123456789012345678", text: "Oi Bia" }))!.status).toBe(200);
    expect(sent.map((x) => [x.channel, x.to, x.subject, x.text])).toEqual([["creators-discord", "123456789012345678", "", "Oi Bia"]]);
    expect(c.data.creators[0]!.contacted?.via).toBe("discord");
    expect(((await call("GET", "creator", null, [["id", "instagram:99"]]))!.body as DetailView).contacted).toContain("Sent a Discord message on");
  });
  it("the composer remembers the template and channel picked last (state.json); a Reach icon's channel still wins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const persons = fakePersons({
      channels: [
        { id: "creators-gmail", kind: "gmail", label: "Email", account: "igor@spokpay.com", connected: true },
        { id: "creators-gmail-2", kind: "gmail", label: "Email", account: "fagner@spokpay.com", connected: true },
        { id: "creators-whatsapp", kind: "whatsapp", label: "WhatsApp", account: null, connected: true },
      ],
    });
    const c = new Collector(dir, deps({ persons }));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "Ana", email: "ana@x.com", whatsapp: "5521975709440" }), rec({ platform: "youtube", platform_id: "UC2", name: "Bo", email: "bo@x.com" }));
    const call = caller(c);
    type M = { channel: string; template: string };
    const open = async (id: string, q: [string, string][] = []): Promise<M> => (await call("GET", "compose", null, [["id", id], ...q]))!.body as M;
    expect(await open("youtube:UC1")).toMatchObject({ channel: "creators-gmail", template: "padrao" });
    // a plain open remembers nothing; a pick does
    await open("youtube:UC1", [["template", "loja-parceira"], ["channel", "creators-gmail-2"]]);
    expect([c.data.settings.lastTemplate, c.data.settings.lastChannel]).toEqual(["", undefined]);
    await open("youtube:UC1", [["template", "loja-parceira"], ["channel", "creators-gmail-2"], ["remember", "1"]]);
    expect(c.data.settings).toMatchObject({ lastTemplate: "loja-parceira", lastChannel: "creators-gmail-2" });
    expect(await open("youtube:UC2")).toMatchObject({ channel: "creators-gmail-2", template: "loja-parceira" });
    await open("youtube:UC1", [["channel", "creators-whatsapp"], ["remember", "1"]]);
    // Bo has no number: the last channel can't reach him, so the usual pick
    expect((await open("youtube:UC2")).channel).toBe("creators-gmail");
    expect((await open("youtube:UC1")).channel).toBe("creators-whatsapp");
    // opened from a Reach icon: that channel
    expect((await open("youtube:UC1", [["kind", "email"]])).channel).toBe("creators-gmail");
    await c.flush();
    const again = new Collector(dir, deps({ persons }));
    expect(again.data.settings).toMatchObject({ lastTemplate: "loja-parceira", lastChannel: "creators-whatsapp" });
  });
  it("Send message picks where in Persons they go (its places); the channels follow that place's section; remembered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const sent: SendInput[] = [];
    let keysAsked: string[] | undefined;
    const base = fakePersons({ sent });
    const persons = { ...base, creatorKeys: (places?: string[]) => ((keysAsked = places), []) };
    const c = new Collector(dir, deps({ persons }));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "Ana", email: "ana@x.com" }));
    const call = caller(c);
    type M = { place: string; placeLabel: string; places: { value: string; label: string }[]; channel: string; channels: { id: string; conn: string; why: string }[] };
    const open = async (q: [string, string][] = []): Promise<M> => (await call("GET", "compose", null, [["id", "youtube:UC1"], ...q]))!.body as M;
    const m = await open();
    expect([m.place, m.places.map((x) => x.label), m.channel]).toEqual(["creators", ["Robux Paradise", "Creators", "SpokPay", "Personal"], "creators-gmail"]);
    expect(m.channels[0]!.conn).toBe("Creators Gmail");
    const st = await open([["place", "store:robux"], ["remember", "1"]]);
    expect([st.place, st.placeLabel, st.channel, st.channels.map((x) => x.id)]).toEqual(["store:robux", "Robux Paradise", "stores-gmail", ["stores-gmail", "stores-whatsapp", "stores-discord", "none-instagram"]]);
    expect(st.channels[3]!.why).toContain("Persons › Stores has no Instagram");
    expect(c.data.settings.lastPlace).toBe("store:robux");
    expect((await open()).place).toBe("store:robux");
    // a channel of another place's section doesn't send for this one
    expect((await call("POST", "send", { id: "youtube:UC1", channel: "creators-gmail", to: "ana@x.com", subject: "Oi", text: "Oi", place: "store:robux" }))!.status).toBe(409);
    expect((await call("POST", "send", { id: "youtube:UC1", channel: "stores-gmail", to: "ana@x.com", subject: "Oi", text: "Oi", place: "store:gone" }))!.status).toBe(409);
    expect((await call("POST", "send", { id: "youtube:UC1", channel: "stores-gmail", to: "ana@x.com", subject: "Oi", text: "Oi", place: "store:robux" }))!.status).toBe(200);
    expect(sent.map((x) => [x.channel, x.place])).toEqual([["stores-gmail", "store:robux"]]);
    expect(c.data.creators[0]!.contacted).toMatchObject({ place: "store:robux", placeLabel: "Robux Paradise" });
    expect(((await call("GET", "creator", null, [["id", "youtube:UC1"]]))!.body as DetailView).contacted).toContain("(Persons › Robux Paradise)");
    // the next run never collects anyone in the places sent to
    await call("POST", "start", { platform: "youtube", query: "q", target: 1, gapDays: 0 });
    await c.settled();
    expect(keysAsked).toEqual(["store:robux"]);
  });
  it("Restrict keeps a lead out of Available and the export; Unrestrict brings it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const c = new Collector(dir, deps({}));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "A" }), rec({ platform: "tiktok", platform_id: "7", name: "B" }));
    const call = caller(c);
    expect((await call("POST", "restrict", { id: "nope", restricted: true }))!.status).toBe(404);
    const v = (await call("POST", "restrict", { id: "youtube:UC1", restricted: true }))!.body as { counts: { available: number; restricted: number }; creators: { id: string; restricted: boolean }[] };
    expect(v.counts).toEqual({ available: 1, approved: 0, restricted: 1 });
    expect(v.creators.find((x) => x.id === "youtube:UC1")?.restricted).toBe(true);
    expect(((await call("GET", "export"))!.body as { count: number }).count).toBe(1);
    await call("POST", "restrict", { id: "youtube:UC1", restricted: false });
    expect(c.data.creators.every((x) => !x.restricted)).toBe(true);
  });
  it("Approve takes a lead out of Available into Approved (its own export); Unapprove brings it back; Reject after Approve restricts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const added: CreatorRecord[] = [];
    const sent: SendInput[] = [];
    const c = new Collector(dir, deps({ persons: fakePersons({ added, sent }) }));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "A" }), rec({ platform: "tiktok", platform_id: "7", name: "B" }), rec({ platform: "instagram", platform_id: "9", name: "C" }));
    const call = caller(c);
    type V = { counts: { available: number; approved: number; restricted: number }; creators: { id: string; approved: boolean; restricted: boolean }[]; settings: { approveTo: string } };
    expect((await call("POST", "approve", { id: "nope", approved: true }))!.status).toBe(404);
    // Default: the Approved list only; nothing goes to Persons.
    let v = (await call("POST", "approve", { id: "youtube:UC1", approved: true }))!.body as V;
    expect(v.counts).toEqual({ available: 2, approved: 1, restricted: 0 });
    expect(v.creators.find((x) => x.id === "youtube:UC1")?.approved).toBe(true);
    expect(c.data.creators[0]!.approved).toMatchObject({ to: "list", person: null });
    expect(added).toEqual([]);
    const exp = async (which: string) => (await call("GET", "export", null, which ? [["which", which]] : []))!.body as { text: string; count: number };
    expect((await exp("")).count).toBe(2);
    expect((await exp("approved")).count).toBe(1);
    expect(JSON.parse((await exp("approved")).text)).not.toHaveProperty("approved");
    // To Persons › Creators: added the way Send makes them, nothing sent; the choice is remembered.
    v = (await call("POST", "approve", { id: "tiktok:7", approved: true, to: "persons" }))!.body as V;
    expect(added.map((r) => r.name)).toEqual(["B"]);
    expect(sent).toEqual([]);
    expect(c.data.creators[1]!.approved).toMatchObject({ to: "persons", person: "p_added1" });
    expect(v.settings.approveTo).toBe("persons");
    // Reject (Restrict) an approved lead: out of Approved, into Restricted.
    v = (await call("POST", "restrict", { id: "tiktok:7", restricted: true }))!.body as V;
    expect(v.counts).toEqual({ available: 1, approved: 1, restricted: 1 });
    expect(c.data.creators[1]!.approved).toBeUndefined();
    // Approve a restricted lead: it leaves Restricted.
    v = (await call("POST", "approve", { id: "tiktok:7", approved: true, to: "list" }))!.body as V;
    expect(v.counts).toEqual({ available: 1, approved: 2, restricted: 0 });
    // Unapprove: back in Available.
    v = (await call("POST", "approve", { id: "youtube:UC1", approved: false }))!.body as V;
    expect(v.counts).toEqual({ available: 2, approved: 1, restricted: 0 });
    // The last choice, the approval and a note survive a restart; a note is never exported.
    expect((await call("POST", "note", { id: "instagram:9", note: "  talked on IG  " }))!.status).toBe(200);
    expect((await call("POST", "note", { id: "nope", note: "x" }))!.status).toBe(404);
    expect((await call("POST", "settings", { approveTo: "bogus" }))!.status).toBe(200);
    await c.flush();
    const again = new Collector(dir, deps({}));
    expect(again.data.settings.approveTo).toBe("list");
    expect(again.data.creators.find((x) => x.platform_id === "7")?.approved?.to).toBe("list");
    expect(again.data.creators.find((x) => x.platform_id === "9")?.note).toBe("  talked on IG  ");
    expect(((await caller(again)("GET", "creator", null, [["id", "instagram:9"]]))!.body as DetailView).note).toBe("  talked on IG  ");
    expect(exportText(again.data)).not.toContain("talked");
    await caller(again)("POST", "note", { id: "instagram:9", note: "   " });
    expect(again.data.creators.find((x) => x.platform_id === "9")?.note).toBeUndefined();
  });
  it("Approve to Persons › Creators makes the person Send would (email, number, profiles), or joins the one there; sends nothing", () => {
    type P = { id: string; name: string; email?: string; whatsapp?: string; listIds: string[]; storeIds: string[]; socials?: string[]; notes?: string };
    let people: P[] = [{ id: "p1", name: "Old", email: "old@x.com", listIds: [], storeIds: [] }];
    let n = 0;
    let sends = 0;
    const svc = {
      get data() {
        return { people };
      },
      newId: () => `p_new${++n}`,
      update: (f: (d: { people: P[] }) => { people: P[] }) => void (people = f({ people }).people),
      updatePerson: (id: string, f: (p: P) => P) => void (people = people.map((p) => (p.id === id ? f(p) : p))),
      send: async () => void sends++,
    };
    const bridge = livePersons(() => svc as never);
    const fresh = bridge.add(rec({ platform: "youtube", platform_id: "UC1", name: "Ana", email: "Ana@Canal.com", whatsapp: "5521975709440", profile_url: "https://www.youtube.com/@ana" }));
    expect(fresh).toMatchObject({ ok: true, person: "p_new1", created: true });
    expect(people[1]).toMatchObject({ name: "Ana", email: "ana@canal.com", whatsapp: "5521975709440", listIds: ["creators"] });
    expect(people[1]!.socials?.length).toBe(1);
    const joined = bridge.add(rec({ platform: "tiktok", platform_id: "7", name: "Old one", email: "old@x.com" }));
    expect(joined).toMatchObject({ ok: true, person: "p1", created: false });
    expect(people[0]!.listIds).toEqual(["creators"]);
    expect([people.length, sends]).toEqual([2, 0]);
    expect(livePersons(() => null).add(rec({ platform: "youtube", platform_id: "x" }))).toMatchObject({ ok: false });
  });
  it("Send on Discord or Instagram makes the person with that id in Creators (an Instagram lead's own id, no lookup)", async () => {
    type P = { id: string; name: string; discordId: string; instagram?: string; instagramUsername?: string; listIds: string[]; storeIds: string[] };
    let people: P[] = [];
    let n = 0;
    const sends: [string, string, string][] = [];
    const views = [
      { id: "cd", kind: "discord", section: "creators", connected: true, state: { me: null }, convos: {} },
      { id: "ci", kind: "instagram", section: "creators", connected: true, state: { me: null }, convos: {} },
    ];
    const svc = {
      get data() {
        return { people };
      },
      newId: () => `p_new${++n}`,
      update: (f: (d: { people: P[] }) => { people: P[] }) => void (people = f({ people }).people),
      updatePerson: (id: string, f: (p: P) => P) => void (people = people.map((p) => (p.id === id ? f(p) : p))),
      deletePerson: (id: string) => void (people = people.filter((p) => p.id !== id)),
      views: () => views,
      view: (id: string) => views.find((v) => v.id === id),
      lookup: async () => ({ matches: [] }),
      send: async (pid: string, conn: string, text: string, o: { peer: string }) => (sends.push([pid, conn, o.peer]), void text, { ok: true }),
    };
    const bridge = livePersons(() => svc as never);
    expect(bridge.channels().map((c) => c.kind)).toEqual(["discord", "instagram"]);
    const r = await bridge.send({ rec: rec({ platform: "youtube", platform_id: "UC1", name: "Ana" }), channel: "cd", to: "123456789012345678", subject: "", text: "Oi" });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(people[0]).toMatchObject({ name: "Ana", discordId: "123456789012345678", listIds: ["creators"] });
    const ig = await bridge.send({ rec: rec({ platform: "instagram", platform_id: "4455", name: "Bia", handle: "@bia" }), channel: "ci", to: "@Bia", subject: "", text: "Oi" });
    expect(ig).toMatchObject({ ok: true, created: true });
    expect(people[1]).toMatchObject({ instagram: "4455", instagramUsername: "Bia" });
    // someone else's handle is looked up through Persons' Instagram; not found: no send, nobody made
    const miss = await bridge.send({ rec: rec({ platform: "youtube", platform_id: "UC2", name: "Cy" }), channel: "ci", to: "@cy", subject: "", text: "Oi" });
    expect(miss.ok).toBe(false);
    expect([people.length, sends.map((x) => x[2])]).toEqual([2, ["123456789012345678", "4455"]]);
  });
  it("Send to a store or SpokPay puts the person there (the list made when missing); never-twice covers those places", async () => {
    type P = { id: string; name: string; discordId: string; email?: string; listIds: string[]; storeIds: string[]; socials?: string[] };
    let data = { people: [{ id: "p0", name: "Shop", discordId: "", email: "shop@x.com", listIds: [], storeIds: ["s1"], socials: ["https://www.youtube.com/@shop"] }] as P[], stores: [{ id: "s1", name: "Robux Paradise" }], lists: [{ id: "creators", name: "Creators", accountId: "gmail" }] };
    let n = 0;
    const views = [
      { id: "sg", kind: "gmail", section: "stores", connected: true, state: { me: null }, convos: {}, label: "Stores Gmail" },
      { id: "sw", kind: "whatsapp", section: "stores", also: ["personal"], connected: true, state: { me: null }, convos: {}, label: "Stores WhatsApp" },
      { id: "cg", kind: "gmail", section: "creators", connected: true, state: { me: null }, convos: {}, label: "Creators Gmail" },
    ];
    const svc = {
      get data() {
        return data;
      },
      newId: () => `p_new${++n}`,
      update: (f: (d: typeof data) => typeof data) => void (data = f(data)),
      updatePerson: (id: string, f: (p: P) => P) => void (data = { ...data, people: data.people.map((p) => (p.id === id ? f(p) : p)) }),
      deletePerson: () => {},
      views: () => views,
      view: (id: string) => views.find((v) => v.id === id),
      lookup: async () => ({ matches: [] }),
      send: async () => ({ ok: true }),
    };
    const bridge = livePersons(() => svc as never);
    expect(bridge.places().map((x) => [x.value, x.label])).toEqual([["store:s1", "Robux Paradise"], ["creators", "Creators"], ["spokpay", "SpokPay"], ["personal", "Personal"]]);
    expect(bridge.channels("stores").map((c) => c.id)).toEqual(["sg", "sw"]);
    expect(bridge.channels("personal").map((c) => c.id)).toEqual(["sw"]);
    expect(bridge.channels("creators").map((c) => c.id)).toEqual(["cg"]);
    expect((await bridge.send({ rec: rec({ platform: "youtube", platform_id: "UC1", name: "Ana" }), channel: "cg", to: "ana@x.com", subject: "s", text: "t", place: "store:s1" })).ok).toBe(false);
    expect((await bridge.send({ rec: rec({ platform: "youtube", platform_id: "UC1", name: "Ana" }), channel: "sg", to: "ana@x.com", subject: "s", text: "t", place: "store:s1" })).ok).toBe(true);
    expect(data.people[1]).toMatchObject({ name: "Ana", email: "ana@x.com", storeIds: ["s1"], listIds: [] });
    expect((await bridge.send({ rec: rec({ platform: "youtube", platform_id: "UC2", name: "Bo" }), channel: "sw", to: "+55 21 97570-9440", subject: "", text: "t", place: "personal" })).ok).toBe(true);
    expect(data.people[2]).toMatchObject({ listIds: ["personal"] });
    expect(data.lists.map((l) => l.id)).toEqual(["creators", "personal"]);
    expect(bridge.creatorKeys()).toEqual([]);
    expect(bridge.creatorKeys(["store:s1"])).toContain("email:shop@x.com");
  });
  it("remembers the lists' Sort and platforms; bad ones fall back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const c = new Collector(dir, deps({}));
    const call = caller(c);
    expect(c.data.settings).toMatchObject({ sort: "followers-desc", platforms: [] });
    await call("POST", "settings", { sort: "followers-asc", platforms: ["instagram", "youtube", "nope", "youtube"] });
    expect(c.data.settings).toMatchObject({ sort: "followers-asc", platforms: ["youtube", "instagram"] });
    await call("POST", "settings", { sort: "name-asc", platforms: ["youtube", "tiktok", "instagram"] });
    expect(c.data.settings).toMatchObject({ sort: "followers-asc", platforms: [] });
    await call("POST", "settings", { platforms: ["tiktok"] });
    await c.flush();
    expect(new Collector(dir, deps({})).data.settings).toMatchObject({ sort: "followers-asc", platforms: ["tiktok"] });
    expect(migrate({ settings: { sort: 3, platforms: "x" } }).settings).toMatchObject({ sort: "followers-desc", platforms: [] });
    const v = (await call("GET", ""))!.body as { sorts: { value: string }[]; creators: unknown[] };
    expect((v.sorts as { value: string; label: string }[]).map((x) => x.label)).toEqual(["Followers (high → low)", "Followers (low → high)"]);
  });
  it("Approved and Rejected leads are never collected again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const yt = fakeYt({ UCa: 1, UCb: 1 });
    const c = new Collector(dir, deps({ youtube: yt as never }));
    const call = caller(c);
    await call("POST", "start", { platform: "youtube", query: "q", target: 0, gapDays: 0 });
    await c.settled();
    await call("POST", "approve", { id: "youtube:UCa", approved: true });
    await call("POST", "restrict", { id: "youtube:UCb", restricted: true });
    await call("POST", "start", { platform: "youtube", query: "q", target: 0, gapDays: 0 });
    await c.settled();
    expect(c.data.creators.length).toBe(2);
    expect(c.data.run?.ids).toEqual([]);
  });
});

describe("lead detail", () => {
  it("Reach follows the CRM's checks; links get their brand and title; Edit's links box parses back", () => {
    expect([reachError("email", "a@b"), reachError("email", "a@b.co"), reachError("discord", "123"), reachError("discord", "123456789012345678"), reachError("instagram", "bad handle!"), reachError("whatsapp", "21 97570-9440")]).toEqual(["That isn't an email address.", null, expect.any(String), null, expect.any(String), null]);
    expect([normalizeReach("whatsapp", "(21) 9 7570-9440"), normalizeReach("whatsapp", "+1 415 555 0100"), normalizeReach("instagram", "https://instagram.com/ana.x/"), normalizeReach("email", " A@B.Co ")]).toEqual(["+5521975709440", "+14155550100", "@ana.x", "a@b.co"]);
    expect(reachHref({ kind: "whatsapp", value: "+5521975709440" })).toBe("https://wa.me/5521975709440");
    expect(reachHref({ kind: "instagram", value: "@ana" })).toBe("https://www.instagram.com/ana/");
    expect(["https://discord.gg/x", "https://www.youtube.com/@a", "https://linktr.ee/a", "mailto:a@b.co"].map((url) => brandOf({ label: null, url }).key)).toEqual(["discord", "youtube", "link", "email"]);
    expect([linkTitle({ label: "LOJA", url: "https://x.com.br" }), linkTitle({ label: null, url: "https://www.rreze.com.br/a" })]).toEqual(["LOJA", "rreze.com.br"]);
    expect(parseLinks("ROBUX GRATIS https://rocute.com.br/Rreze\nrreze.com.br\n\nsiga | https://linktr.ee/r")).toEqual([
      { label: "ROBUX GRATIS", url: "https://rocute.com.br/Rreze" },
      { label: null, url: "https://rreze.com.br" },
      { label: "siga", url: "https://linktr.ee/r" },
    ]);
  });
  it("shows everything gathered: stats with data only, the newest videos with their age and views, bio, how found, links", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const c = new Collector(dir, deps({}));
    const at = new Date(Date.now() - DAY - 3_600_000).toISOString();
    c.data.creators.push(
      rec({ platform: "youtube", platform_id: "UC1", name: "rreze", handle: "@rreze", subscriber_count: 570_000, video_count: 1000, view_count: 69_000_000, description: "todo dia tem video", email: "r@p.com.br", recent_videos: [{ video_id: "v1", title: "EU LEVEI UM GOLPE", url: "https://y/v1", thumbnail_url: null, published_at: at, view_count: 22_000, is_short: false }], links: [{ label: "LOJA RREZE", url: "https://rreze.com.br" }] }),
      rec({ platform: "instagram", platform_id: "9", name: "ig", subscriber_count: 1200, video_count: 30, view_count: null }),
    );
    const call = caller(c);
    const d = (await call("GET", "creator", null, [["id", "youtube:UC1"]]))!.body as DetailView;
    expect(d.stats).toEqual([{ icon: "users", value: "570K", label: "Subscribers" }, { icon: "video", value: "1K", label: "Videos" }, { icon: "eye", value: "69M", label: "Views" }]);
    expect(d.recent.map((v) => [v.title, v.meta])).toEqual([["EU LEVEI UM GOLPE", "yesterday · 22K views"]]);
    expect([d.bio, d.foundVia, d.hasContact, d.reachKind, d.drafts.email, d.openLabel, d.reach]).toEqual(["todo dia tem video", "q", true, "email", "r@p.com.br", "Open channel", ""]);
    expect(d.links).toEqual([{ title: "LOJA RREZE", url: "https://rreze.com.br", brand: "link", color: "#9aa4b2" }]);
    const ig = (await call("GET", "creator", null, [["id", "instagram:9"]]))!.body as DetailView;
    expect(ig.stats.map((x) => x.label)).toEqual(["Followers", "Posts"]);
    expect([ig.hasContact, ig.openLabel]).toEqual([false, "Open profile"]);
  });
  it("Reach is typed only: saved, shown on the card, written to Send message, cleared; Edit's fields stay typed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const c = new Collector(dir, deps({}));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "A", email: "found@a.com", email_source: "bio" }));
    const call = caller(c);
    expect((await call("POST", "reach", { id: "youtube:UC1", kind: "fax", value: "1" }))!.status).toBe(400);
    expect((await call("POST", "reach", { id: "youtube:UC1", kind: "discord", value: "nope" }))!.status).toBe(400);
    const d = (await call("POST", "reach", { id: "youtube:UC1", kind: "whatsapp", value: "(21) 9 7570-9440" }))!.body as DetailView;
    expect([d.reach, d.reachValue, d.reachSend, d.reachHref, d.drafts.whatsapp]).toEqual(["whatsapp", "+5521975709440", "Send WhatsApp", "https://wa.me/5521975709440", "+5521975709440"]);
    expect([c.data.creators[0]!.whatsapp, c.data.creators[0]!.whatsapp_manual]).toEqual(["5521975709440", true]);
    const v = (await call("GET", ""))!.body as { creators: { reach: string }[] };
    expect(v.creators[0]!.reach).toBe("whatsapp");
    await call("POST", "reach", { id: "youtube:UC1", kind: "email", value: "Deal@A.com" });
    expect([c.data.creators[0]!.email, c.data.creators[0]!.email_manual, c.data.creators[0]!.reach]).toEqual(["deal@a.com", true, { kind: "email", value: "deal@a.com" }]);
    const m = (await call("GET", "compose", null, [["id", "youtube:UC1"], ["kind", "email"]]))!.body as { to: string; kind: string };
    expect([m.to, m.kind]).toEqual(["deal@a.com", "gmail"]);
    await call("POST", "reach", { id: "youtube:UC1", kind: "email", value: "" });
    expect([c.data.creators[0]!.reach, c.data.creators[0]!.email]).toEqual([undefined, "deal@a.com"]);
    expect((await call("POST", "edit", { id: "youtube:UC1", name: "  " }))!.status).toBe(400);
    const e = (await call("POST", "edit", { id: "youtube:UC1", name: "Ana B", handle: "anab", description: "bio typed", links: "Shop https://shop.com" }))!.body as DetailView;
    expect([e.name, e.handle, e.bio, e.links.map((l) => [l.title, l.url])]).toEqual(["Ana B", "@anab", "bio typed", [["Shop", "https://shop.com"]]]);
    expect(c.data.creators[0]!.edited?.sort()).toEqual(["description", "handle", "links", "name"]);
    const line = JSON.parse(exportText(c.data));
    expect(["edited" in line, "reach" in line, line.name]).toEqual([false, false, "Ana B"]);
  });
  it("fills what an older lead misses once on opening, keeping what was typed; once a day at most", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const yt = fakeYt({ UC1: 2 });
    yt.about = async (id: string) => ({ name: "Fresh", handle: `@${id}`, profileUrl: "", avatarUrl: "https://img/a.jpg", subscribers: 999, videos: 7, views: 50, description: "fresh bio", country: null, links: [{ label: "Site", url: "https://site.com" }] });
    const c = new Collector(dir, deps({ youtube: yt as never }));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "Typed name", edited: ["name"], email: "me@x.com", email_manual: true, subscriber_count: null, video_count: null }));
    const call = caller(c);
    const d = (await call("POST", "fill", { id: "youtube:UC1" }))!.body as DetailView;
    expect([d.name, d.bio, d.stats.map((s) => s.value), d.recent.length, d.links.map((l) => l.url), d.email]).toEqual(["Typed name", "fresh bio", ["999", "7", "50"], 1, ["https://site.com"], "me@x.com"]);
    expect(Collector.missing(c.data.creators[0]!)).toBe(false);
    c.data.creators[0]!.description = null;
    yt.calls.length = 0;
    await call("POST", "fill", { id: "youtube:UC1" });
    expect(yt.calls).toEqual([]);
  });
  it("the opening detail's thumbnails come ahead of the picture queue, so the fill's answer shows them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const got: string[] = [];
    // The queue is slow (a CRM import's hundreds): every picture takes a while, except when fetched for the detail.
    const fetch = async (u: string) => (got.push(u), new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])));
    const c = new Collector(dir, deps({ fetch: fetch as never, sleep: () => new Promise((r) => setTimeout(r, 60_000)) }));
    for (let i = 0; i < 5; i++) c.avatarPath(`https://img/queued-${i}.jpg`);
    const vids = [1, 2, 3].map((i) => ({ url: `https://y/v${i}`, title: `v${i}`, thumbnail_url: `https://img/t${i}.jpg`, published_at: new Date(NOW).toISOString(), view_count: 5 }));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC9", description: "bio", recent_videos: vids as never, filled_at: new Date().toISOString() }));
    const d = (await caller(c)("POST", "fill", { id: "youtube:UC9" }))!.body as DetailView;
    expect(d.recent.map((v) => !!v.thumbPath)).toEqual([true, true, true]);
    expect(got.slice(0, 1)).toEqual(["https://img/queued-0.jpg"]);
    expect(got).toContain("https://img/t3.jpg");
  });
});

describe("SpokPay CRM import", () => {
  const HC = "960a";
  const card = (o: Record<string, unknown>) => ({ id: `crm-${o.platform_id}`, platform: "youtube", name: "N", handle: null, profile_url: null, avatar_url: null, subscriber_count: 1000, video_count: 10, view_count: 5000, description: "bio", links: [], country: null, discovered_via: "robux", captured_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", status_id: HC, reach_kind: null, reach_value: null, ...o });
  const crmFetch = (cards: unknown[], calls: string[] = []) => async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/api/query")) return new Response("", { status: 404 });
    const path = (JSON.parse(String(init?.body)) as { path: string }).path;
    calls.push(path);
    const value = path === "creators:listCreatorStatuses" ? [{ id: HC, name: "Has Contact" }, { id: "x", name: "Triaged" }] : cards;
    return new Response(JSON.stringify({ status: "success", value }), { status: 200 });
  };
  it("maps a card: the detail's fields, its Reach typed (an email Reach is the email), where it came from", () => {
    const r = crmRecord(card({ platform_id: "UC9", handle: "rreze", links: [{ label: "https://x.com/r", url: "https://x.com/r" }, { label: "Loja", url: "https://loja.com" }], reach_kind: "email", reach_value: "R@Pull.com.br" }) as never, "Has Contact");
    expect([r.handle, r.subscriber_count, r.description, r.discovered_via, r.links.map((l) => l.label), r.reach, r.email, r.email_manual, r.imported_from]).toEqual(["@rreze", 1000, "bio", "robux", [null, "Loja"], { kind: "email", value: "r@pull.com.br" }, "r@pull.com.br", true, "SpokPay CRM · Has Contact"]);
    expect("imported_from" in JSON.parse(exportText({ ...defaultData(), creators: [r] }))).toBe(false);
  });
  it("brings the Has Contact cards into Available once: again changes nothing, existing leads are completed, the same person isn't kept twice, missing data is read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const calls: string[] = [];
    const cards = [
      card({ platform_id: "UCnew", name: "New", reach_kind: "discord", reach_value: "490259731382927360" }),
      card({ platform_id: "UChere", name: "Here", description: "crm bio", reach_kind: "email", reach_value: "here@x.com" }),
      card({ platform: "tiktok", platform_id: "77", handle: "@twin", name: "Twin" }),
      card({ platform_id: "UCtriaged", status_id: "x" }),
    ];
    const yt = fakeYt({ UCnew: 1, UChere: 1 });
    const c = new Collector(dir, deps({ youtube: yt as never, fetch: crmFetch(cards, calls) as never }));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UChere", name: "Here", restricted: true, description: null }), rec({ platform: "tiktok", platform_id: "other-id", name: "Twin here", handle: "@twin" }));
    const call = caller(c);
    const r = (await call("POST", "import-crm", {}))!.body as { total: number; added: number; updated: number; skipped: string[]; byPlatform: Record<string, number> };
    expect([r.total, r.added, r.updated, r.skipped.length, r.byPlatform]).toEqual([3, 1, 1, 1, { youtube: 1 }]);
    await c.imported();
    const here = c.data.creators.find((x) => x.platform_id === "UChere")!;
    expect([here.restricted, here.description, here.email, here.reach?.kind, here.recent_videos?.length]).toEqual([true, "crm bio", "here@x.com", "email", 1]);
    const added = c.data.creators.find((x) => x.platform_id === "UCnew")!;
    expect([added.reach, added.recent_videos?.length, c.isKnown(["youtube:UCnew"])]).toEqual([{ kind: "discord", value: "490259731382927360" }, 1, true]);
    expect(yt.calls.filter((x) => x.startsWith("about:"))).toEqual(["about:UCnew", "about:UChere"]);
    const again = (await call("POST", "import-crm", {}))!.body as { added: number; updated: number };
    await c.imported();
    expect([again.added, again.updated, c.data.creators.length]).toEqual([0, 2, 3]);
    expect(calls.every((p) => p.startsWith("creators:list"))).toBe(true);
  });
});
