// Ported from Person Hub's src/lib/socials.test.ts (the URL and parser parts; data.json's are the
// model's), plus fetchSocial against a fake YouTube / TikTok (no network) and its 3 h cache.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSocials,
  formatAge,
  formatCount,
  isFresh,
  normalizeSocials,
  parseSocialUrl,
  parseYoutubeFeed,
  socialHandle,
  tiktokTimeFromId,
  tiktokVideosFromEmbedHtml,
  youtubeChannelIdFromHtml,
  youtubeProfileFromHtml,
} from "../src/socials.ts";

describe("parseSocialUrl", () => {
  it("reads TikTok, Instagram and YouTube profiles in the shapes a copy produces", () => {
    expect(parseSocialUrl("https://www.tiktok.com/@khaby.lame?lang=en")).toMatchObject({ platform: "tiktok", value: "khaby.lame", url: "https://www.tiktok.com/@khaby.lame" });
    expect(parseSocialUrl("tiktok.com/@someone/video/7300000000000000000")).toMatchObject({ platform: "tiktok", value: "someone" });
    expect(parseSocialUrl("instagram.com/NatGeo/")).toMatchObject({ platform: "instagram", value: "natgeo", url: "https://www.instagram.com/natgeo/" });
    expect(parseSocialUrl("https://m.youtube.com/@MrBeast/videos")).toMatchObject({ platform: "youtube", kind: "handle", value: "MrBeast", url: "https://www.youtube.com/@MrBeast" });
    expect(parseSocialUrl("https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA")).toMatchObject({ kind: "channelId", value: "UCX6OQ3DkcsbYNE6H8uQQuVA" });
    expect(parseSocialUrl("youtube.com/c/Vanity")).toMatchObject({ kind: "custom", value: "Vanity" });
    expect(parseSocialUrl("<https://youtube.com/user/old>")).toMatchObject({ kind: "user", value: "old" });
  });
  it("rejects what is not a profile", () => {
    for (const s of ["", "hello", "https://instagram.com/p/abc", "https://www.youtube.com/watch?v=x", "https://tiktok.com/foryou", "https://example.com/@x", "javascript:alert(1)", "ftp://youtube.com/@x"]) {
      expect(parseSocialUrl(s)).toBeNull();
    }
  });
  it("labels a profile by its handle", () => {
    const t = parseSocialUrl("tiktok.com/@a.b");
    expect(t && socialHandle(t)).toBe("@a.b");
  });
});

describe("normalizeSocials", () => {
  it("keeps canonical, unique profile URLs", () => {
    expect(normalizeSocials(["tiktok.com/@X", "https://www.tiktok.com/@x", "junk", 3, "instagram.com/y"])).toEqual(["https://www.tiktok.com/@X", "https://www.instagram.com/y/"]);
    expect(normalizeSocials(undefined)).toEqual([]);
  });
});

describe("formatCount / formatAge", () => {
  it("counts", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(1500)).toBe("1.5K");
    expect(formatCount(22_400)).toBe("22K");
    expect(formatCount(140_000)).toBe("140K");
    expect(formatCount(999_999)).toBe("1M");
    expect(formatCount(1_450_000)).toBe("1.4M");
    expect(formatCount(33_775_027)).toBe("34M");
    expect(formatCount(2_100_000_000)).toBe("2.1B");
  });
  it("ages", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    expect(formatAge("2026-11-25T11:30:00Z", now)).toBe("just now");
    expect(formatAge("2026-11-25T08:00:00Z", now)).toBe("4h ago");
    expect(formatAge("2026-11-24T08:00:00Z", now)).toBe("1d ago");
    expect(formatAge("2026-10-30T12:00:00Z", now)).toBe("26d ago");
    expect(formatAge("2026-09-01T12:00:00Z", now)).toBe("2mo ago");
    expect(formatAge("2025-10-01T12:00:00Z", now)).toBe("1y ago");
    expect(formatAge(null, now)).toBeNull();
    expect(formatAge("garbage", now)).toBeNull();
  });
});

const entry = (id: string, at: string, views: string, shorts = false): string =>
  `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><title>Tom &amp; Jerry&#39;s ${id}</title><link rel="alternate" href="https://www.youtube.com/${shorts ? `shorts/${id}` : `watch?v=${id}`}"/><published>${at}</published><media:group><media:title>x</media:title><media:thumbnail url="https://i.ytimg.com/vi/${id}/hqdefault.jpg" width="480" height="360"/><media:community><media:statistics views="${views}"/></media:community></media:group></entry>`;
const FEED = `<feed><title>Chan</title><published>2010-01-01T00:00:00Z</published>${entry("a", "2026-11-01T00:00:00Z", "10")}${entry("b", "2026-11-20T00:00:00Z", "22000", true)}${entry("c", "2026-10-01T00:00:00Z", "5")}${entry("d", "2026-09-01T00:00:00Z", "1")}</feed>`;
const tid = (sec: number): string => (BigInt(sec) << 32n).toString();
const embed = (userInfo: object, videoList: object[] = []): string =>
  `<script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify({ source: { data: { "/embed/@me": { userInfo, videoList } } } })}</script>`;

describe("YouTube and TikTok parsers", () => {
  it("reads a YouTube feed: entries only, newest first, entities decoded, shorts", () => {
    const v = parseYoutubeFeed(FEED);
    expect(v.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(v[0]).toMatchObject({ title: "Tom & Jerry's b", views: 22000, short: true, url: "https://www.youtube.com/shorts/b", thumbnail: "https://i.ytimg.com/vi/b/hqdefault.jpg", publishedAt: "2026-11-20T00:00:00Z" });
  });
  it("finds a channel id on its page", () => {
    expect(youtubeChannelIdFromHtml('{"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"}')).toBe("UCX6OQ3DkcsbYNE6H8uQQuVA");
    expect(youtubeChannelIdFromHtml("<html></html>")).toBeNull();
  });
  it("reads a TikTok creator embed, ordered by the ids' timestamps (pinned first in the page)", () => {
    const old = tid(1_700_000_000);
    const mid = tid(1_760_000_000);
    const latest = tid(1_770_000_000);
    const html = embed({ uniqueId: "me" }, [
      { id: old, desc: "pinned", coverUrl: "https://p16/c1", playCount: 5 },
      { id: latest, desc: " newest ", coverUrl: "", originCoverUrl: "https://p16/o3", playCount: 1800000 },
      { id: mid, desc: "", coverUrl: "https://p16/c2", playCount: 22 },
      { id: tid(1_765_000_000), privateItem: true },
    ]);
    const r = tiktokVideosFromEmbedHtml(html, "me");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.videos.map((v) => v.id)).toEqual([latest, mid, old]);
    expect(r.videos[0]).toMatchObject({ title: "newest", thumbnail: "https://p16/o3", views: 1800000, url: `https://www.tiktok.com/@me/video/${latest}`, publishedAt: new Date(1_770_000_000_000).toISOString() });
    expect(r.videos[1]?.title).toBeNull();
    expect(tiktokTimeFromId("nope")).toBeNull();
  });
  it("reads a YouTube channel page's picture (sized to 240) and name", () => {
    const html = `<meta property="og:title" content="Tom &amp; Co"><meta property="og:image" content="https://yt3.googleusercontent.com/og=s900-c-k-c0x00ffffff-no-rj">"avatar":{"thumbnails":[{"url":"https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj","width":900}]}`;
    expect(youtubeProfileFromHtml(html)).toEqual({ avatar: "https://yt3.googleusercontent.com/abc=s240-c-k-c0x00ffffff-no-rj", name: "Tom & Co" });
    expect(youtubeProfileFromHtml('<meta property="og:image" content="https://yt3.ggpht.com/x=s88">').avatar).toBe("https://yt3.ggpht.com/x=s240");
    expect(youtubeProfileFromHtml("<html></html>")).toEqual({ avatar: null, name: null });
  });
  it("reads a TikTok embed's picture and name", () => {
    expect(tiktokVideosFromEmbedHtml(embed({ uniqueId: "me", nickname: " Me ", avatarThumbUrl: "https://p16-sign.tiktokcdn.com/a.jpeg?x-expires=1&x-signature=s" }), "me")).toMatchObject({
      ok: true,
      profile: { avatar: "https://p16-sign.tiktokcdn.com/a.jpeg?x-expires=1&x-signature=s", name: "Me" },
    });
    expect(tiktokVideosFromEmbedHtml(embed({ avatarThumb: "https://t/thumb", avatarLarger: "https://t/large" }), "me")).toMatchObject({ profile: { avatar: "https://t/large", name: null } });
    expect(tiktokVideosFromEmbedHtml(embed({}), "me")).toMatchObject({ profile: { avatar: null } });
  });
  it("reports a missing or private TikTok embed", () => {
    expect(tiktokVideosFromEmbedHtml("<html></html>", "x")).toMatchObject({ ok: false, retry: true });
    const html = `<script id="__FRONTITY_CONNECT_STATE__">${JSON.stringify({ source: { data: { "/embed/@x": { isError: true } } } })}</script>`;
    expect(tiktokVideosFromEmbedHtml(html, "x")).toMatchObject({ ok: false });
  });
});

describe("fetchSocial", () => {
  let dir = "";
  let now = Date.parse("2026-11-25T12:00:00Z");
  let asked: string[] = [];
  let tiktokBusy = 0;
  let youtubeDown = false;
  const fake = async (url: string): Promise<Response> => {
    asked.push(url);
    if (youtubeDown && url.includes("youtube.com")) return new Response("no", { status: 500 });
    if (url === "https://www.youtube.com/@Chan") return new Response(`<html>{"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"}<meta property="og:title" content="Chan"><meta property="og:image" content="https://yt3.ggpht.com/p=s900"></html>`);
    if (url === "https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA") return new Response(FEED);
    if (url === "https://www.tiktok.com/embed/@me") {
      if (tiktokBusy-- > 0) return new Response("overload", { status: 503 });
      return new Response(embed({ uniqueId: "me", nickname: "Me", avatarLarger: "https://p16/me.jpg" }, [{ id: tid(1_770_000_000), desc: "hi", coverUrl: "https://p16/c", playCount: 7 }]));
    }
    return new Response("not found", { status: 404 });
  };
  const make = () => createSocials({ dir, fetch: fake, now: () => now, wait: async () => {} });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "persons-socials-"));
    now = Date.parse("2026-11-25T12:00:00Z");
    asked = [];
    tiktokBusy = 0;
    youtubeDown = false;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a YouTube handle: the channel page (picture, name) then the feed", async () => {
    const s = make();
    const r = await s.fetchSocial("youtube.com/@Chan");
    expect(r).toMatchObject({ platform: "youtube", handle: "@Chan", url: "https://www.youtube.com/@Chan", photo: "https://yt3.ggpht.com/p=s240", name: "Chan" });
    expect(r?.uploads.map((u) => u.url)).toEqual(["https://www.youtube.com/shorts/b", "https://www.youtube.com/watch?v=a", "https://www.youtube.com/watch?v=c"]);
    expect(r?.uploads[0]).toEqual({ title: "Tom & Jerry's b", url: "https://www.youtube.com/shorts/b", thumb: "https://i.ytimg.com/vi/b/hqdefault.jpg", at: "2026-11-20T00:00:00Z", views: 22000 });
    expect(asked.every((u) => u.startsWith("https://www.youtube.com/"))).toBe(true);
  });

  it("reads TikTok through its overload answers; Instagram is a link only", async () => {
    tiktokBusy = 2;
    const s = make();
    expect(await s.fetchSocial("https://www.tiktok.com/@me")).toMatchObject({ platform: "tiktok", handle: "@me", photo: "https://p16/me.jpg", name: "Me", uploads: [{ title: "hi", views: 7 }] });
    expect(asked).toHaveLength(3);
    expect(await s.fetchSocial("instagram.com/someone")).toMatchObject({ platform: "instagram", unsupported: true, uploads: [] });
    expect(await s.fetchSocial("https://example.com/x")).toBeNull();
  });

  it("caches 3 hours in memory and on disk; a failed read keeps what was read before", async () => {
    const s = make();
    await s.fetchSocial("youtube.com/@Chan");
    const n = asked.length;
    now += 2 * 3600_000;
    await s.fetchSocial("https://www.youtube.com/@chan");
    expect(asked.length).toBe(n);
    await s.flush();
    const disk = JSON.parse(readFileSync(join(dir, "socials-cache.json"), "utf8"));
    expect(Object.keys(disk.entries)).toEqual(["youtube|handle|chan"]);
    const again = make();
    expect(again.cached("youtube.com/@Chan")?.name).toBe("Chan");
    now += 2 * 3600_000;
    youtubeDown = true;
    const r = await again.fetchSocial("youtube.com/@Chan");
    expect(r).toMatchObject({ name: "Chan", photo: "https://yt3.ggpht.com/p=s240", error: "YouTube channel page HTTP 500" });
    expect(r?.uploads).toHaveLength(3);
    expect(isFresh(r, now)).toBe(true);
    expect(isFresh(r, now + 11 * 60_000)).toBe(false);
  });
});
