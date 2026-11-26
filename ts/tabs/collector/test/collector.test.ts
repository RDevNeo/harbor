import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOf, ytParseCount, ytSearchParam, ytParseFeed, ytUnwrapRedirect, ytChannelsFromSearch, ytUploadersFromSearch, ytParseAbout } from "../lib/youtube.ts";
import { discoveryAppetite, sweepYouTube, type SweepCtx } from "../lib/sweep.ts";
import { exportText, migrate, defaultData, type CreatorRecord } from "../lib/types.ts";
import { Collector, collectorRoute, type CollectorDeps } from "../engine.ts";
import { compact } from "../view.ts";
import { extractUrls, normalizeUrl, profileKeyOf, kindOf, whatsappOf } from "../lib/links.ts";
import { bestEmail, extractEmails } from "../lib/email.ts";
import { enrich, linktreeLinks } from "../lib/enrich.ts";
import { allKeys } from "../lib/identity.ts";
import { applyFresh, type Fresh } from "../lib/refresh.ts";
import { fillTemplate, loadTemplates, templatesToSave } from "../lib/templates.ts";
import { sweepSocial, type Profile, type SocialClient } from "../lib/social.ts";
import { fakePersons, type SendInput } from "../persons-bridge.ts";

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
  return { yt, query: "q", target, gapDays, isKnown: () => false, enrich: async (r) => r, count: () => out.length, add: (r) => (out.push(r), null), stopped: () => false, log: () => {}, progress: () => {}, sleep: async () => {}, now: () => NOW };
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

describe("daily update", () => {
  it("writes down what changed and keeps a typed email", () => {
    const r = rec({ platform: "youtube", platform_id: "UC1", subscriber_count: 12_000, email: "me@x.com", email_manual: true, email_source: "typed", last_upload_at: "2026-11-01T00:00:00Z", links: [{ label: "X", url: "https://x.com/a" }] });
    const f: Fresh = { name: "UC1", handle: null, profile_url: null, avatar_url: null, subscriber_count: 13_000, video_count: 1, view_count: null, description: null, links: [], country: null, last_upload_at: "2026-11-24T00:00:00Z" };
    const { rec: n, changes } = applyFresh(r, f, { links: [{ label: "Site", url: "https://site.com" }], email: { email: "other@x.com", source: "bio" } }, "2026-11-25T00:00:00Z");
    expect(changes.map((c) => `${c.field}:${c.from}>${c.to}`)).toEqual(["Subscribers:12K>13K", "Last upload:2026-11-01>2026-11-24", "Links added:>site.com", "Links removed:x.com/a>"]);
    expect([n.email, n.email_source, n.updated_at]).toEqual(["me@x.com", "typed", "2026-11-25T00:00:00Z"]);
    expect(n.history?.[0]?.changes.length).toBe(4);
    const same = applyFresh(n, { ...f, links: [] }, { links: n.links, email: null }, "2026-11-26T00:00:00Z");
    expect(same.changes).toEqual([]);
    expect(same.rec.history?.length).toBe(1);
  });
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
  return { offline: false, changed: () => {}, log: () => {}, persons: fakePersons(), sleep: async () => {}, fetch: async () => new Response("", { status: 404 }), daily: false, ...over };
}

const caller = (c: Collector) => (method: string, path: string, body: unknown = null, query: [string, string][] = []) =>
  collectorRoute(c, { method, path: ["v1", "collector", ...path.split("/").filter(Boolean)], query, body, token: "", device: "", global: false } as never);

describe("collector", () => {
  it("exports JSONL, one record per line, with the email and without Hub's own fields", () => {
    const d = defaultData();
    d.creators = [rec({ platform: "youtube", platform_id: "UC1", email: "a@b.com", email_source: "bio", history: [], email_manual: false }), rec({ platform: "youtube", platform_id: "UC2" })];
    const lines = exportText(d).split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.platform_id)).toEqual(["UC1", "UC2"]);
    expect([lines[0].email, "history" in lines[0], "email" in lines[1]]).toEqual(["a@b.com", false, false]);
    expect(migrate({ settings: { gapDays: 3, targets: { creators: "120", servers: 5 }, tab: "servers" }, servers: [{ invite: "x" }] }).settings).toMatchObject({ gapDays: 14, target: 120 });
    expect(compact(3_110_000)).toBe("3.1M");
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
    const v = (await call("GET", ""))!.body as { counts: { creators: number }; run: { running: boolean; found: number } };
    expect([v.counts.creators, v.run.running, v.run.found]).toEqual([2, false, 2]);
    expect(((await call("GET", "export"))!.body as { count: number }).count).toBe(2);
    await c.flush();
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).creators.length).toBe(2);
  });
  it("never collects anyone twice: not after Clear, not on another platform, not when they're in Persons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const yt = fakeYt({ UCa: 1, UCb: 1 });
    // UCb's About links TikTok @tb; @pp is in Persons › Creators already.
    yt.about = async (id: string) => ({ name: `N ${id}`, handle: `@${id}`, profileUrl: `https://www.youtube.com/@${id}`, avatarUrl: null, subscribers: 10, videos: 2, views: 3, description: null, country: null, links: id === "UCb" ? [{ label: "TikTok", url: "https://www.tiktok.com/@tb" }] : [] });
    const tt = fakeSocial("tiktok", { tb: {}, pp: {}, fresh: {} });
    const c = new Collector(dir, deps({ youtube: yt as never, tiktok: tt, persons: fakePersons({ keys: ["tiktok:@pp"] }) }));
    const call = caller(c);
    await call("POST", "start", { platform: "youtube", query: "q", target: 0, gapDays: 0 });
    await c.settled();
    await call("POST", "clear");
    await call("POST", "start", { platform: "youtube", query: "q", target: 0, gapDays: 0 });
    await c.settled();
    expect(c.data.creators.length).toBe(0);
    await call("POST", "start", { platform: "tiktok", query: "q", target: 0, gapDays: 14 });
    await c.settled();
    expect(c.data.creators.map((x) => x.handle)).toEqual(["@fresh"]);
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
  it("the daily update reads each creator again and writes the changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const yt = fakeYt({ UC1: 1 });
    yt.about = async (id: string) => ({ name: "Kauã", handle: "@kaua", profileUrl: `https://www.youtube.com/@kaua`, avatarUrl: null, subscribers: 25_000, videos: 3, views: 3, description: "parcerias@kaua.com", country: null, links: [] });
    const c = new Collector(dir, deps({ youtube: yt as never }));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "Kauã", subscriber_count: 20_000, captured_at: new Date(Date.now() - 2 * DAY).toISOString() }));
    expect(c.refreshAll(false)).toBeNull();
    expect(c.refreshAll(false)).toBe("The update is already going.");
    while (c.data.refresh.running) await Bun.sleep(5);
    const x = c.data.creators[0]!;
    expect([x.subscriber_count, x.email, x.email_source]).toEqual([25_000, "parcerias@kaua.com", "YouTube About"]);
    expect(x.history?.[0]?.changes.map((ch) => ch.field)).toContain("Subscribers");
    expect(c.data.refresh.status).toContain("1 changed");
  });
});
