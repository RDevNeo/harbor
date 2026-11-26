import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TikTok, solveWaf, ttParseEmbed, ttParseSuggest, ttParseUserDetail, ttTimeFromId, type Hit } from "../lib/tiktok.ts";
import { Instagram, igCleanLink, igCollectMedia, igHashtagFromQuery, igParseCrawlerHtml, igParseProfileJson, igTimeFromShortcode, igUsersFromSearch } from "../lib/instagram.ts";

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

const SESSION = { cookie: "csrftoken=CSRF123; sessionid=SESS; ds_user_id=42" };

describe("instagram client", () => {
  it("without a session reads the crawler page", async () => {
    const f = fakeFetch(() => html(fixture("ig-crawler.html")));
    const p = await new Instagram(f, null).profile("@instagram");
    expect(f.calls[0]!.url).toBe("https://www.instagram.com/instagram/");
    expect(header(f.calls[0], "User-Agent")).toStartWith("facebookexternalhit/1.1");
    expect(header(f.calls[0], "Cookie")).toBeUndefined();
    expect(p.precision).toBe("rounded");
    await expect(new Instagram(fakeFetch(() => html("nope", 404)), null).profile("gone")).rejects.toThrow("not found");
  });

  it("with a session reads web_profile_info with the web app's headers", async () => {
    const f = fakeFetch(() => json(JSON.parse(fixture("ig-profile.json"))));
    const p = await new Instagram(f, SESSION).profile("criadora.teste");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://www.instagram.com/api/v1/users/web_profile_info/?username=criadora.teste");
    expect(header(f.calls[0], "X-IG-App-ID")).toBe("936619743392459");
    expect(header(f.calls[0], "X-CSRFToken")).toBe("CSRF123");
    expect(header(f.calls[0], "X-Requested-With")).toBe("XMLHttpRequest");
    expect(header(f.calls[0], "Referer")).toBe("https://www.instagram.com/");
    expect(header(f.calls[0], "Cookie")).toBe(SESSION.cookie);
    expect(p.precision).toBe("exact");
    expect(p.email).toBe("parcerias@exemplo.com.br");
  });

  it("falls back to the crawler page on 429 or HTML", async () => {
    for (const refusal of [() => json({ message: "Please wait a few minutes", status: "fail" }, 429), () => html("<!DOCTYPE html><title>Page Not Found</title>", 404)]) {
      const f = fakeFetch((url) => (url.includes("/api/v1/") ? refusal() : html(fixture("ig-crawler.html"))));
      const p = await new Instagram(f, SESSION).profile("instagram");
      expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/users/web_profile_info/", "/instagram/"]);
      expect(p).toMatchObject({ platform_id: "25025320", precision: "rounded" });
    }
  });

  it("whoami: current_user, then ds_user_id, else null", async () => {
    expect(await new Instagram(fakeFetch(() => json({ user: { username: "me.here" }, status: "ok" })), SESSION).whoami()).toEqual({ username: "me.here" });
    const f = fakeFetch((url) => (url.includes("current_user") ? json({ status: "fail" }, 401) : json({ user: { pk: 42, username: "by.id" } })));
    expect(await new Instagram(f, SESSION).whoami()).toEqual({ username: "by.id" });
    expect(f.calls[1]!.url).toBe("https://www.instagram.com/api/v1/users/42/info/");
    expect(await new Instagram(fakeFetch(() => html("<html>login</html>")), { cookie: "sessionid=x" }).whoami()).toBeNull();
    expect(await new Instagram(fakeFetch(() => json({})), null).whoami()).toBeNull();
  });

  it("discover needs a session", async () => {
    const run = async (): Promise<void> => {
      for await (const _ of new Instagram(fakeFetch(() => json({})), null).discover("roblox", { stopped: () => false, sleep: async () => {}, log: () => {} })) void _;
    };
    await expect(run()).rejects.toThrow("Instagram search needs a signed-in session");
  });

  it("discover: hashtag pages then account search, deduped and paced", async () => {
    const f = fakeFetch((url) => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/tags/web_info/") return json(JSON.parse(fixture("ig-tag-web-info.json")));
      if (path === "/api/v1/tags/robloxbrasil/sections/") return json(JSON.parse(fixture("ig-tag-sections.json")));
      if (path === "/api/v1/web/search/topsearch/") return json(JSON.parse(fixture("ig-topsearch.json")));
      return html("", 404);
    });
    const slept: number[] = [];
    const batches: Hit[][] = [];
    for await (const b of new Instagram(f, SESSION).discover("#Roblox Brasil", { stopped: () => false, sleep: async (ms) => void slept.push(ms), log: () => {} })) batches.push(b);
    expect(batches.map((b) => b.map((h) => h.handle))).toEqual([["ana.roblox", "beto.games"], ["carla_plays"], ["roblox.brasil.oficial"]]);
    expect(batches[0]![0]!.latestAt).toBe(1795650000 * 1000);
    expect(f.calls[0]!.url).toBe("https://www.instagram.com/api/v1/tags/web_info/?tag_name=robloxbrasil");
    expect(f.calls[1]!.init?.method).toBe("POST");
    expect(f.calls[1]!.init?.body).toBe("tab=recent&page=0");
    expect(header(f.calls[1], "Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(f.calls[2]!.url).toBe("https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=%23Roblox%20Brasil&include_reel=true");
    expect(f.calls).toHaveLength(3);
    expect(slept).toEqual([1500, 1500]);
  });

  it("discover pages with max_id and stops a refused pass", async () => {
    let page = 0;
    const logs: string[] = [];
    const f = fakeFetch((url) => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/tags/web_info/") return json({ data: { recent: { sections: [] } } });
      if (path.endsWith("/sections/")) {
        page++;
        if (page === 3) return json({ message: "rate limited" }, 429);
        return json({ sections: [{ medias: [{ media: { taken_at: 1795000000 + page, user: { pk: String(page), username: `p${page}` } } }] }], more_available: true, next_max_id: `MAX${page}` });
      }
      return html("<!DOCTYPE html>", 200);
    });
    const handles: string[] = [];
    for await (const b of new Instagram(f, SESSION).discover("games", { stopped: () => false, sleep: async () => {}, log: (t) => void logs.push(t) })) handles.push(...b.map((h) => h.handle));
    expect(handles).toEqual(["p1", "p2"]);
    expect(f.calls.map((c) => c.init?.body ?? null)).toEqual([null, "tab=recent&page=0", "tab=recent&page=0&max_id=MAX1", "tab=recent&page=0&max_id=MAX2", null]);
    expect(logs.some((l) => l.includes("429"))).toBe(true);
    expect(logs.some((l) => l.includes("account search: refused"))).toBe(true);
  });
});
