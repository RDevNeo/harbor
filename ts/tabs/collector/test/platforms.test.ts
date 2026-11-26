import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TikTok, solveWaf, ttParseEmbed, ttParseSuggest, ttParseUserDetail, ttTimeFromId, type Hit } from "../lib/tiktok.ts";
import { Instagram, igCleanLink, igCollectMedia, igHashtagFromQuery, igParseChunks, igParseCrawlerHtml, igParseProfileJson, igRecentFromFeed, igTimeFromShortcode, igTopSerpCursor, igUsersFromSearch } from "../lib/instagram.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

type Call = { url: string; init: RequestInit | undefined };
/** A fetch that answers from `route` and records every call. */
function fakeFetch(route: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return route(url, init, calls.length);
  };
  return Object.assign(f, { calls });
}
const header = (c: Call | undefined, k: string): string | undefined => (c?.init?.headers as Record<string, string> | undefined)?.[k];
const html = (body: string, status = 200, cookies: string[] = []): Response =>
  new Response(body, { status, headers: [["content-type", "text/html; charset=utf-8"], ...cookies.map((c): [string, string] => ["set-cookie", c])] });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = { sleep: async (): Promise<void> => {} };

/** A WAF page whose answer is `answer` (same shape as TikTok's). */
function syntheticChallenge(answer: number): string {
  const prefix = Buffer.from("synthetic-prefix-0123456789");
  const c = createHash("sha256").update(prefix).update(String(answer)).digest();
  const cs = Buffer.from(JSON.stringify({ v: { a: prefix.toString("base64"), b: 1795655040, c: c.toString("base64") }, s: "sig" })).toString("base64");
  return `<html><body>Please wait... <p id="wci" class="_wafchallengeid"></p> <p id="cs" class="${cs}"></p> <p id="rci" class="waforiginalreid"></p> <p id="rs" class="rsvalue"></p> <p id="rs_id" class="44"></p></body></html>`;
}

describe("tiktok parsing", () => {
  it("dates a video from its id", () => {
    expect(new Date(ttTimeFromId("7712155027653020941")!).toISOString()).toBe("2026-11-25T17:00:19.000Z");
    expect(ttTimeFromId("123")).toBeNull();
    expect(ttTimeFromId("abc")).toBeNull();
    expect(ttTimeFromId(null)).toBeNull();
  });

  it("reads the profile page's user-detail, statsV2 over stats", () => {
    const d = ttParseUserDetail(fixture("tt-profile.html"))!;
    expect(d.status).toBe("ok");
    const p = d.profile!;
    expect(p).toMatchObject({
      platform: "tiktok",
      platform_id: "6789306297633571845",
      name: "Roblox",
      handle: "@roblox",
      profile_url: "https://www.tiktok.com/@roblox",
      followers: 35_074_170,
      posts: 1088,
      likes: 162_019_349,
      bio: "Reimagining the way people come together",
      links: [{ label: null, url: "https://lnk.bio/roblox" }],
      email: null,
      country: null,
      last_post_at: null,
      recent: [],
      private: false,
      precision: "exact",
    });
    expect(p.avatar_url).toContain("1080:1080");
  });

  it("tells private, missing and unreadable pages apart", () => {
    const page = (detail: unknown): string => `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.user-detail": detail } })}</script>`;
    const priv = ttParseUserDetail(page({ statusCode: 10222, userInfo: { user: { id: "9", uniqueId: "shy", nickname: "Shy" }, stats: { followerCount: 1200, videoCount: 4 } } }))!;
    expect(priv.status).toBe("private");
    expect(priv.profile).toMatchObject({ platform_id: "9", private: true, followers: 1200, posts: 4, precision: "rounded" });
    expect(ttParseUserDetail(page({ statusCode: 10222 }))).toEqual({ status: "private", profile: null });
    expect(ttParseUserDetail(page({ statusCode: 10221 }))).toEqual({ status: "not_found", profile: null });
    expect(ttParseUserDetail(page({ statusCode: 0, userInfo: {} }))!.status).toBe("not_found");
    expect(ttParseUserDetail(fixture("tt-challenge.html"))).toBeNull();
  });

  it("reads the embed's newest public videos", () => {
    const e = ttParseEmbed(fixture("tt-embed.html"), "@Roblox")!;
    expect(e.error).toBe(false);
    expect(e.recent.map((v) => v.video_id)).toEqual(["7712155027653020941", "7711843630499073310", "7711781126565547277"]);
    expect(e.recent[0]).toMatchObject({
      title: "bro has been training for this moment his entire life",
      url: "https://www.tiktok.com/@roblox/video/7712155027653020941",
      published_at: "2026-11-25T17:00:19.000Z",
      is_short: true,
    });
    expect(e.recent[0]!.view_count).toBeGreaterThan(0);
    expect(e.recent[0]!.thumbnail_url).toStartWith("https://");
    expect(e.recent[1]!.title).toBeNull();
    expect(e.newest).toBe(Date.parse("2026-11-25T17:00:19Z"));
    expect(e.followers).toBe(35_100_000);
    expect(ttParseEmbed(fixture("tt-embed.html"), "someoneelse")).toBeNull();
    expect(ttParseEmbed("<html></html>", "roblox")).toBeNull();
  });

  it("splits suggestions into accounts and words", () => {
    const s = ttParseSuggest(JSON.parse(fixture("tt-suggest.json")));
    expect(s.accounts).toEqual([
      { handle: "robloxuser59268", id: "7626463405842662433", name: "Roblox games", avatarUrl: expect.stringContaining("tiktokcdn.com") },
      { handle: "robloxlive412", id: "7440320861692150792", name: "Roblox Live", avatarUrl: expect.stringContaining("tiktokcdn.com") },
    ]);
    expect(s.words).toEqual(["roblox", "roblox 🎁", "roblox the great build", "Roblox GTA 6 Game"]);
    expect(ttParseSuggest(null)).toEqual({ accounts: [], words: [] });
  });

  it("solves the WAF proof of work", () => {
    const cookies = solveWaf(syntheticChallenge(1234))!;
    expect(Object.keys(cookies).sort()).toEqual(["_wafchallengeid", "waforigin_id", "waforiginalreid"]);
    const c = JSON.parse(Buffer.from(cookies._wafchallengeid!, "base64").toString());
    expect(Buffer.from(c.d, "base64").toString()).toBe("1234");
    expect(c.s).toBe("sig");
    expect(cookies.waforiginalreid).toBe("rsvalue");
    expect(cookies.waforigin_id).toBe("44");
    // TikTok's real page (captured), and pages that aren't challenges
    expect(solveWaf(fixture("tt-challenge.html"))?._wafchallengeid).toBeString();
    expect(solveWaf(fixture("tt-profile.html"))).toBeNull();
  });
});

describe("tiktok client", () => {
  it("solves the challenge, keeps the cookies, reads profile and embed", async () => {
    const slept: number[] = [];
    let challenged = false;
    const f = fakeFetch((url, init) => {
      const cookie = (init?.headers as Record<string, string>).Cookie ?? "";
      if (url.includes("/embed/@roblox")) return html(fixture("tt-embed.html"));
      if (url.includes("/@roblox")) {
        if (!cookie.includes("_wafchallengeid=")) {
          challenged = true;
          return html(syntheticChallenge(77), 200, ["ttwid=t1; Path=/; HttpOnly"]);
        }
        return html(fixture("tt-profile.html"), 200, ["msToken=m1; Path=/"]);
      }
      return html("", 404);
    });
    const tt = new TikTok(f, { sleep: async (ms) => void slept.push(ms) });
    const p = await tt.profile("@roblox");
    expect(challenged).toBe(true);
    expect(slept).toEqual([1500]);
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/@roblox", "/@roblox", "/embed/@roblox"]);
    expect(header(f.calls[1], "Cookie")).toContain("ttwid=t1");
    expect(header(f.calls[2], "Cookie")).toContain("msToken=m1");
    expect(header(f.calls[0], "User-Agent")).toContain("Chrome/");
    expect(header(f.calls[0], "Accept-Language")).toStartWith("en-US");
    expect(p.followers).toBe(35_074_170);
    expect(p.recent).toHaveLength(3);
    expect(p.last_post_at).toBe("2026-11-25T17:00:19.000Z");
  });

  it("keeps the profile when the embed fails", async () => {
    const f = fakeFetch((url) => (url.includes("/embed/") ? html("Bad Request", 400) : html(fixture("tt-profile.html"))));
    const p = await new TikTok(f, noSleep).profile("roblox");
    expect(p.platform_id).toBe("6789306297633571845");
    expect(p.recent).toEqual([]);
    expect(p.last_post_at).toBeNull();
    const g = fakeFetch((url) => (url.includes("/embed/") ? Promise.reject(new Error("socket hang up")) : html(fixture("tt-profile.html"))));
    expect((await new TikTok(g, noSleep).profile("roblox")).recent).toEqual([]);
  });

  it("throws not found, returns private, and gives up on an unsolved challenge", async () => {
    const page = (detail: unknown): Response => html(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.user-detail": detail } })}</script>`);
    await expect(new TikTok(fakeFetch(() => page({ statusCode: 10221 })), noSleep).profile("gone")).rejects.toThrow("not found");
    const priv = await new TikTok(fakeFetch(() => page({ statusCode: 10222 })), noSleep).profile("shy");
    expect(priv).toMatchObject({ handle: "@shy", private: true, platform_id: "", followers: null });
    await expect(new TikTok(fakeFetch(() => html(syntheticChallenge(5))), noSleep).profile("x")).rejects.toThrow("challenge");
  });

  it("asks for suggestions unsigned", async () => {
    const f = fakeFetch(() => json(JSON.parse(fixture("tt-suggest.json"))));
    const s = await new TikTok(f, noSleep).suggest("roblox br");
    expect(f.calls[0]!.url).toBe("https://www.tiktok.com/api/search/general/preview/?aid=1988&keyword=roblox%20br");
    expect(s.accounts).toHaveLength(2);
    await expect(new TikTok(fakeFetch(() => new Response("")), noSleep).suggest("x")).rejects.toThrow("refused");
  });

  it("discovers breadth-first: the query, its words, then a..z", async () => {
    const sug = (accounts: string[], words: string[]) => ({
      status_code: 0,
      sug_list: [...words.map((content) => ({ content, sug_type: "" })), ...accounts.map((u) => ({ content: u, sug_type: "account", extra_info: { unique_id: u, sug_user_id: `id-${u}`, nickname: u.toUpperCase() } }))],
    });
    const answers: Record<string, unknown> = {
      "roblox br": sug(["ana", "beto"], ["roblox brasil", "minecraft", "Roblox Brookhaven"]),
      "roblox brasil": sug(["beto", "carla"], ["roblox brasil oficial"]),
      "Roblox Brookhaven": sug(["dani"], []),
    };
    const asked: string[] = [];
    const f = fakeFetch((url) => {
      const q = new URL(url).searchParams.get("keyword")!;
      asked.push(q);
      return json(answers[q] ?? sug([], []));
    });
    const slept: number[] = [];
    const batches: Hit[][] = [];
    for await (const b of new TikTok(f, noSleep).discover("roblox  br", { stopped: () => false, sleep: async (ms) => void slept.push(ms), log: () => {}, maxQueries: 6 })) batches.push(b);
    expect(asked).toEqual(["roblox br", "roblox brasil", "Roblox Brookhaven", "roblox br a", "roblox br b", "roblox br c"]);
    expect(batches.map((b) => b.map((h) => h.handle))).toEqual([["ana", "beto"], ["carla"], ["dani"]]);
    expect(batches[0]![0]).toEqual({ handle: "ana", id: "id-ana", name: "ANA", avatarUrl: null });
    expect(slept).toEqual([1800, 1800, 1800, 1800, 1800]);
  });

  it("stops discovery when asked and after repeated failures", async () => {
    let n = 0;
    const f = fakeFetch(() => json({ status_code: 0, sug_list: [{ content: `u${++n}`, sug_type: "account", extra_info: { unique_id: `u${n}` } }] }));
    const got: string[] = [];
    for await (const b of new TikTok(f, noSleep).discover("x", { stopped: () => got.length >= 2, sleep: async () => {}, log: () => {} })) got.push(...b.map((h) => h.handle));
    expect(got).toEqual(["u1", "u2"]);
    expect(f.calls).toHaveLength(2);
    const logs: string[] = [];
    const bad = fakeFetch(() => html("", 500));
    for await (const _ of new TikTok(bad, noSleep).discover("x", { stopped: () => false, sleep: async () => {}, log: (t) => void logs.push(t) })) void _;
    expect(bad.calls).toHaveLength(3);
    expect(logs[0]).toContain("HTTP 500");
  });
});

/** An 11-char shortcode for a post at `ms` (inverse of igTimeFromShortcode). */
function shortcodeAt(ms: number): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let v = ((BigInt(ms) - 1314220021721n) << 23n) | 12345n;
  let s = "";
  for (let i = 0; i < 11; i++) {
    s = A[Number(v & 63n)] + s;
    v >>= 6n;
  }
  return s;
}

describe("instagram parsing", () => {
  it("reads web_profile_info", () => {
    const p = igParseProfileJson(JSON.parse(fixture("ig-profile.json")))!;
    expect(p).toMatchObject({
      platform: "instagram",
      platform_id: "1234567890",
      name: "Criadora Teste",
      handle: "@criadora.teste",
      profile_url: "https://www.instagram.com/criadora.teste/",
      avatar_url: "https://scontent.cdninstagram.com/v/hd.jpg",
      followers: 48213,
      posts: 412,
      likes: null,
      email: "parcerias@exemplo.com.br",
      country: null,
      private: false,
      precision: "exact",
      last_post_at: new Date(1795600000 * 1000).toISOString(),
    });
    expect(p.links).toEqual([
      { label: "Meu Linktree", url: "https://linktr.ee/criadorateste" },
      { label: null, url: "https://youtube.com/@criadorateste" },
    ]);
    expect(p.recent.map((v) => v.video_id)).toEqual(["REEL1abcdef", "REEL2abcdef", "REEL3abcdef"]);
    expect(p.recent[0]).toEqual({
      video_id: "REEL1abcdef",
      title: "reel um",
      url: "https://www.instagram.com/reel/REEL1abcdef/",
      thumbnail_url: "https://scontent.cdninstagram.com/v/r1.jpg",
      published_at: new Date(1795500000 * 1000).toISOString(),
      view_count: 15400,
      is_short: true,
    });
    expect(p.recent[2]!.title).toBeNull();
    expect(igParseProfileJson({ data: { user: null } })).toBeNull();
  });

  it("reads the crawler page (rounded counts), English and Portuguese", () => {
    const p = igParseCrawlerHtml(fixture("ig-crawler.html"), "instagram")!;
    expect(p).toMatchObject({
      platform_id: "25025320",
      name: "Instagram",
      handle: "@instagram",
      profile_url: "https://www.instagram.com/instagram/",
      followers: 684_000_000,
      posts: 8661,
      bio: "Discover what's new on Instagram 🔎✨",
      links: [],
      last_post_at: null,
      recent: [],
      precision: "rounded",
    });
    expect(p.avatar_url).toStartWith("https://scontent.cdninstagram.com/");
    const pt = `<meta property="og:title" content="Fulana Silva (&#064;fulana.silva) &#x2022; Fotos e v&#xed;deos do Instagram" />
<meta property="og:description" content="12,5 mil seguidores, 300 seguindo, 1.204 publica&#xe7;&#xf5;es - Veja as fotos e v&#xed;deos do Instagram de Fulana Silva (&#064;fulana.silva)" />
<meta content="12,5 mil seguidores, 300 seguindo, 1.204 publica&#xe7;&#xf5;es - Fulana Silva (&#064;fulana.silva) no Instagram: &quot;Maquiagem &amp; vida real&quot;" name="description" />
<script>{"profile_id":"987654"}</script>`;
    expect(igParseCrawlerHtml(pt, "fulana.silva")).toMatchObject({ platform_id: "987654", name: "Fulana Silva", handle: "@fulana.silva", followers: 12_500, posts: 1204, bio: "Maquiagem & vida real" });
    expect(igParseCrawlerHtml(`<meta property="og:description" content="1.2M seguidores, 10 seguindo, 3 publicações" />`, "x")).toMatchObject({ followers: 1_200_000, posts: 3, platform_id: "", name: "x" });
    expect(igParseCrawlerHtml("<html><title>Login • Instagram</title></html>", "x")).toBeNull();
  });

  it("collects media authors from any layout, newest post per author", () => {
    const hits = igCollectMedia(JSON.parse(fixture("ig-tag-web-info.json")));
    expect(hits).toEqual([
      { handle: "ana.roblox", id: "111", name: "Ana", avatarUrl: null, followers: null, latestAt: 1795650000 * 1000 },
      { handle: "beto.games", id: "222", name: "Beto", avatarUrl: null, followers: null, latestAt: 1795000000 * 1000 },
    ]);
    expect(igCollectMedia(JSON.parse(fixture("ig-tag-sections.json")))[0]).toMatchObject({ handle: "carla_plays", id: "333", followers: 1200 });
    expect(igUsersFromSearch(JSON.parse(fixture("ig-topsearch.json"))).map((h) => h.handle)).toEqual(["roblox.brasil.oficial", "ana.roblox"]);
  });

  it("dates shortcodes, cleans links, makes tags", () => {
    const at = Date.parse("2026-11-20T10:00:00Z");
    expect(igTimeFromShortcode(shortcodeAt(at))).toBe(at);
    expect(igTimeFromShortcode(`${shortcodeAt(at)}extraPrivateSuffix`)).toBe(at);
    expect(igTimeFromShortcode("short")).toBeNull();
    expect(igTimeFromShortcode("!!!!!!!!!!!")).toBeNull();
    expect(igCleanLink("https://l.instagram.com/?u=https%3A%2F%2Fwa.me%2F5511999999999%3Ffbclid%3DPAZ&e=AT")).toBe("https://wa.me/5511999999999");
    expect(igCleanLink("linktr.ee/x?fbclid=1&ref=bio")).toBe("https://linktr.ee/x?ref=bio");
    expect(igCleanLink("")).toBeNull();
    expect(igCleanLink("not a url")).toBeNull();
    expect(igHashtagFromQuery("#Roblox Brasil")).toBe("robloxbrasil");
    expect(igHashtagFromQuery("maquiagem_ção")).toBe("maquiagem_ção");
    expect(igHashtagFromQuery("roblox-br")).toBeNull();
  });
});

const SESSION = { cookie: "csrftoken=CSRF123; sessionid=42%3AabcDEF%3A7%3AAYx; ds_user_id=42; mid=MID9" };
const BEARER = `Bearer IGT:2:${btoa(JSON.stringify({ ds_user_id: "42", sessionid: "42:abcDEF:7:AYx" }))}`;
const ig = (f: ReturnType<typeof fakeFetch>, session: { cookie: string } | null = SESSION): Instagram => new Instagram(f, session, { gapMs: 0 });
// Instagram's GraphQL labels its JSON chunks text/html.
const gqlText = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": 'text/html; charset="utf-8"' } });

describe("instagram app-api parsing", () => {
  it("reads usernameinfo + the user's feed", () => {
    const p = igParseProfileJson(JSON.parse(fixture("ig-usernameinfo.json")))!;
    expect(p).toMatchObject({ platform_id: "1234567890", handle: "@criadora.teste", followers: 48213, posts: 412, email: "parcerias@exemplo.com.br", avatar_url: "https://scontent.cdninstagram.com/v/hd.jpg", precision: "exact" });
    expect(p.links).toEqual([{ label: "Meu Linktree", url: "https://linktr.ee/criadorateste" }]);
    const f = igRecentFromFeed(JSON.parse(fixture("ig-feed-user.json")));
    expect(f.lastPostAt).toBe(new Date(1795600000 * 1000).toISOString());
    expect(f.recent.map((v) => [v.video_id, v.view_count, v.title, v.thumbnail_url])).toEqual([
      ["REEL1abcdef", 15400, "reel um", "https://scontent.cdninstagram.com/v/r1.jpg"],
      ["REEL2abcdef", 800, null, null],
      ["PINNEDold01", 999, "fixado", "https://scontent.cdninstagram.com/v/pin.jpg"],
    ]);
    expect(igRecentFromFeed({ status: "fail" })).toEqual({ recent: [], lastPostAt: null });
  });

  it("reads TopSerpQuery's chunks: authors and the cursor", () => {
    const docs = igParseChunks(fixture("ig-topserp.ndjson"));
    expect(docs).toHaveLength(4);
    expect(igCollectMedia(docs)).toEqual([
      { handle: "ana.roblox", id: "111", name: "Ana.Roblox", avatarUrl: "https://scontent.cdninstagram.com/v/ana.roblox.jpg", followers: null, latestAt: 1795650000 * 1000 },
      { handle: "beto.games", id: "222", name: "Beto.Games", avatarUrl: "https://scontent.cdninstagram.com/v/beto.games.jpg", followers: null, latestAt: 1795000000 * 1000 },
      { handle: "carla_plays", id: "333", name: "Carla_Plays", avatarUrl: "https://scontent.cdninstagram.com/v/carla_plays.jpg", followers: null, latestAt: 1795500000 * 1000 },
    ]);
    expect(igTopSerpCursor(docs)).toBe("CURSOR1");
    expect(igTopSerpCursor([{ page_info: { has_next_page: false, end_cursor: "X" } }])).toBeNull();
    expect(igParseChunks('{"a":1}')).toEqual([{ a: 1 }]);
    expect(igParseChunks('{"a":1}\nnot json\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(igUsersFromSearch(JSON.parse(fixture("ig-topsearch-flat.json"))).map((h) => h.handle)).toEqual(["roblox.brasil.oficial", "ana.roblox"]);
  });
});

describe("instagram client", () => {
  it("without a session reads the crawler page", async () => {
    const f = fakeFetch(() => html(fixture("ig-crawler.html")));
    const p = await ig(f, null).profile("@instagram");
    expect(f.calls[0]!.url).toBe("https://www.instagram.com/instagram/");
    expect(header(f.calls[0], "User-Agent")).toStartWith("facebookexternalhit/1.1");
    expect(header(f.calls[0], "Cookie")).toBeUndefined();
    expect(header(f.calls[0], "Authorization")).toBeUndefined();
    expect(p.precision).toBe("rounded");
    await expect(ig(fakeFetch(() => html("nope", 404)), null).profile("gone")).rejects.toThrow("not found");
  });

  it("with a session reads usernameinfo + feed on the app API, the session as an IGT bearer, no cookie", async () => {
    const f = fakeFetch((url) => (url.includes("/usernameinfo/") ? json(JSON.parse(fixture("ig-usernameinfo.json"))) : json(JSON.parse(fixture("ig-feed-user.json")))));
    const p = await ig(f).profile("criadora.teste");
    expect(f.calls.map((c) => c.url)).toEqual(["https://i.instagram.com/api/v1/users/criadora.teste/usernameinfo/", "https://i.instagram.com/api/v1/feed/user/1234567890/?count=12"]);
    const c = f.calls[0];
    expect(header(c, "Authorization")).toBe(BEARER);
    expect(header(c, "IG-U-DS-USER-ID")).toBe("42");
    expect(header(c, "X-MID")).toBe("MID9");
    expect(header(c, "X-IG-App-ID")).toBe("567067343352427");
    expect(header(c, "User-Agent")).toStartWith("Instagram ");
    expect(header(c, "User-Agent")).toContain(" Android (");
    expect(header(c, "Cookie")).toBeUndefined();
    expect(p).toMatchObject({ precision: "exact", followers: 48213, email: "parcerias@exemplo.com.br", last_post_at: new Date(1795600000 * 1000).toISOString() });
    expect(p.recent.map((v) => v.video_id)).toEqual(["REEL1abcdef", "REEL2abcdef", "PINNEDold01"]);
  });

  it("a private profile skips the feed; a missing one is not found", async () => {
    const priv = JSON.parse(fixture("ig-usernameinfo.json"));
    priv.user.is_private = true;
    const f = fakeFetch(() => json(priv));
    expect((await ig(f).profile("criadora.teste")).private).toBe(true);
    expect(f.calls).toHaveLength(1);
    const g = fakeFetch(() => json({ message: "User not found", status: "fail" }, 404));
    await expect(ig(g).profile("gone")).rejects.toThrow("not found");
    expect(g.calls).toHaveLength(1);
  });

  it("falls back to the crawler page when the app API refuses (429, challenge, HTML)", async () => {
    for (const refusal of [() => json({ message: "Please wait a few minutes", status: "fail" }, 429), () => json({ message: "challenge_required", status: "fail" }, 400), () => html("<!DOCTYPE html><title>Page Not Found</title>", 404)]) {
      const f = fakeFetch((url) => (url.startsWith("https://i.instagram.com/") ? refusal() : html(fixture("ig-crawler.html"))));
      const p = await ig(f).profile("instagram");
      expect(f.calls.map((c) => new URL(c.url).host + new URL(c.url).pathname)).toEqual(["i.instagram.com/api/v1/users/instagram/usernameinfo/", "www.instagram.com/instagram/"]);
      expect(p).toMatchObject({ platform_id: "25025320", precision: "rounded" });
    }
  });

  it("whoami: current_user, then users/<ds_user_id>/info, else null", async () => {
    const a = fakeFetch(() => json({ user: { username: "me.here" }, status: "ok" }));
    expect(await ig(a).whoami()).toEqual({ username: "me.here" });
    expect(a.calls[0]!.url).toBe("https://i.instagram.com/api/v1/accounts/current_user/?edit=true");
    expect(header(a.calls[0], "Authorization")).toBe(BEARER);
    const f = fakeFetch((url) => (url.includes("current_user") ? json({ message: "We're sorry, but something went wrong.", status: "fail" }) : json({ user: { pk: 42, username: "by.id" } })));
    expect(await ig(f).whoami()).toEqual({ username: "by.id" });
    expect(f.calls[1]!.url).toBe("https://i.instagram.com/api/v1/users/42/info/");
    // ds_user_id missing: read from the sessionid's prefix
    const g = fakeFetch(() => json({ user: { username: "x" } }));
    expect(await ig(g, { cookie: "sessionid=77%3Aabc" }).whoami()).toEqual({ username: "x" });
    expect(header(g.calls[0], "IG-U-DS-USER-ID")).toBe("77");
    expect(await ig(fakeFetch(() => json({ message: "login_required", status: "fail" }, 403))).whoami()).toBeNull();
    expect(await ig(fakeFetch(() => html("<html>login</html>")), { cookie: "sessionid=x" }).whoami()).toBeNull();
    expect(await ig(fakeFetch(() => json({})), null).whoami()).toBeNull();
  });

  it("spaces every call by the gap, across clients", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => void waits.push(ms);
    const f = fakeFetch(() => json({ user: { username: "me" } }));
    await new Instagram(f, SESSION, { gapMs: 200, sleep }).whoami();
    await new Instagram(f, SESSION, { gapMs: 200, sleep }).whoami();
    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeGreaterThan(150);
    await new Promise((r) => setTimeout(r, 210));
  });

  it("discover needs a session", async () => {
    const run = async (): Promise<void> => {
      for await (const _ of ig(fakeFetch(() => json({})), null).discover("roblox", { stopped: () => false, sleep: async () => {}, log: () => {} })) void _;
    };
    await expect(run()).rejects.toThrow("Instagram search needs a signed-in session");
  });

  it("discover: the search page's posts for #tag (paged by cursor), then account search, deduped and paced", async () => {
    let serp = 0;
    const f = fakeFetch((url) => {
      const path = new URL(url).pathname;
      if (path === "/graphql/query") {
        serp++;
        if (serp === 1) return gqlText(fixture("ig-topserp.ndjson"));
        return json({ data: { manual_pagination_query: { edges: [{ node: { items: [{ taken_at: 1795700000, user: { id: "555", username: "dani.rbx" } }] } }] } } });
      }
      if (path === "/api/v1/fbsearch/topsearch_flat/") return json(JSON.parse(fixture("ig-topsearch-flat.json")));
      return html("", 404);
    });
    const slept: number[] = [];
    const batches: Hit[][] = [];
    for await (const b of ig(f).discover("#Roblox Brasil", { stopped: () => false, sleep: async (ms) => void slept.push(ms), log: () => {} })) batches.push(b);
    expect(batches.map((b) => b.map((h) => h.handle))).toEqual([["ana.roblox", "beto.games", "carla_plays"], ["dani.rbx"], ["roblox.brasil.oficial"]]);
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/graphql/query", "/graphql/query", "/api/v1/fbsearch/topsearch_flat/"]);
    const form = (i: number): URLSearchParams => new URLSearchParams(String(f.calls[i]!.init?.body));
    expect(f.calls[0]!.init?.method).toBe("POST");
    expect(header(f.calls[0], "Content-Type")).toBe("application/x-www-form-urlencoded; charset=UTF-8");
    expect(header(f.calls[0], "X-FB-Friendly-Name")).toBe("TopSerpQuery");
    expect(form(0).get("client_doc_id")).toBe("418531681916451609839969517761");
    const v0 = JSON.parse(form(0).get("variables")!);
    const v1 = JSON.parse(form(1).get("variables")!);
    expect([v0.query, v0.is_pagination_request, v0.after, v0.search_surface]).toEqual(["#robloxbrasil", false, undefined, "TOP_SERP"]);
    expect([v1.query, v1.is_pagination_request, v1.after, v1.search_session_id]).toEqual(["#robloxbrasil", true, "CURSOR1", v0.search_session_id]);
    expect(new URL(f.calls[2]!.url).searchParams.get("query")).toBe("Roblox Brasil");
    expect(slept).toEqual([1500, 1500]);
  });

  it("discover stops a refused pass and still runs account search", async () => {
    const logs: string[] = [];
    const f = fakeFetch((url) => (url.includes("/graphql/") ? json({ errors: [{ message: "Please wait" }] }) : json({ message: "rate limited", status: "fail" }, 429)));
    const handles: string[] = [];
    for await (const b of ig(f).discover("games", { stopped: () => false, sleep: async () => {}, log: (t) => void logs.push(t) })) handles.push(...b.map((h) => h.handle));
    expect(handles).toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(JSON.parse(new URLSearchParams(String(f.calls[0]!.init?.body)).get("variables")!).query).toBe("#games");
    expect(logs.some((l) => l.includes("#games posts: refused"))).toBe(true);
    expect(logs.some((l) => l.includes("account search: refused (HTTP 429)"))).toBe(true);
  });

  it("discover: a phrase that isn't one tag searches the keyword; stops when the cursor runs out", async () => {
    const f = fakeFetch((url) => (url.includes("/graphql/") ? json({ data: { x: { items: [{ taken_at: 1795000001, user: { pk: "9", username: "kw.one" } }] } } }) : json({ list: [] })));
    const handles: string[] = [];
    for await (const b of ig(f).discover("roblox-br dicas", { stopped: () => false, sleep: async () => {}, log: () => {} })) handles.push(...b.map((h) => h.handle));
    expect(handles).toEqual(["kw.one"]);
    expect(JSON.parse(new URLSearchParams(String(f.calls[0]!.init?.body)).get("variables")!).query).toBe("roblox-br dicas");
    expect(f.calls).toHaveLength(2);
  });
});
