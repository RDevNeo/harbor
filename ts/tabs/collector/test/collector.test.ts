import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOf, ytParseCount, ytSearchParam, ytParseFeed, ytUnwrapRedirect, ytUploadersFromSearch, ytParseAbout } from "../lib/youtube.ts";
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
  it("Restrict keeps a lead out of Available and the export; Unrestrict brings it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const c = new Collector(dir, deps({}));
    c.data.creators.push(rec({ platform: "youtube", platform_id: "UC1", name: "A" }), rec({ platform: "tiktok", platform_id: "7", name: "B" }));
    const call = caller(c);
    expect((await call("POST", "restrict", { id: "nope", restricted: true }))!.status).toBe(404);
    const v = (await call("POST", "restrict", { id: "youtube:UC1", restricted: true }))!.body as { counts: { available: number; restricted: number }; creators: { id: string; restricted: boolean }[] };
    expect(v.counts).toEqual({ available: 1, restricted: 1 });
    expect(v.creators.find((x) => x.id === "youtube:UC1")?.restricted).toBe(true);
    expect(((await call("GET", "export"))!.body as { count: number }).count).toBe(1);
    await call("POST", "restrict", { id: "youtube:UC1", restricted: false });
    expect(c.data.creators.every((x) => !x.restricted)).toBe(true);
  });
});
