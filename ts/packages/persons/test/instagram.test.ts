// Instagram direct messages: the app API's JSON as Persons' messages (instagram-core.ts), and the connection over a
// stand-in fetch (no network): a pasted session checked before it's kept, the inbox read for the people tracked,
// history, a username looked up, and what a send would post (nothing is sent anywhere).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstagram } from "../src/conn/instagram.ts";
import { igAuth, igThread, itemMessage, itemTime, normCookie, withTicks } from "../src/conn/instagram-core.ts";
import type { ConnContext } from "../src/conn/types.ts";
import type { ConnEvent } from "../src/model/types.ts";

const ME = "1001";
const ANA = "4242";
const COOKIE = `sessionid=${ME}%3Aabcdefghijkl%3A1; ds_user_id=${ME}; mid=Zmid`;
const us = (ms: number) => String(ms * 1000);
const T0 = Date.parse("2026-11-26T12:00:00.000Z");

const thread = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  thread_id: "t1",
  users: [{ pk: Number(ANA), pk_id: ANA, username: "ana.s", full_name: "Ana S", profile_pic_url: "https://scontent.cdninstagram.com/a.jpg" }],
  items,
  oldest_cursor: "c-old",
  has_older: true,
  last_seen_at: { [ANA]: { timestamp: us(T0 + 1000), item_id: "i2" } },
  ...extra,
});

describe("instagram-core", () => {
  test("the session: a bare sessionid or a cookie line; the account id from ds_user_id or the sessionid", () => {
    expect(normCookie("Cookie: sessionid=1001%3Aabcdefghijkl%3A1")).toBe("sessionid=1001%3Aabcdefghijkl%3A1");
    expect(normCookie("1001%3Aabcdefghijkl%3A1")).toBe("sessionid=1001%3Aabcdefghijkl%3A1");
    expect(normCookie("csrftoken=x")).toBeNull();
    const a = igAuth("sessionid=1001%3Aabcdefghijkl%3A1")!;
    expect(a.userId).toBe("1001");
    expect(JSON.parse(atob(a.bearer.replace("Bearer IGT:2:", "")))).toEqual({ ds_user_id: "1001", sessionid: "1001:abcdefghijkl:1" });
  });
  test("items by type: text, like, link, a photo, a voice message, a shared post, a reply", () => {
    const m = (x: Record<string, unknown>) => itemMessage({ item_id: "i", user_id: ANA, timestamp: us(T0), ...x }, "t1", ME)!;
    expect(m({ item_type: "text", text: "oi" })).toMatchObject({ content: "oi", fromMe: false, channelId: "t1", authorId: ANA, timestamp: "2026-11-26T12:00:00.000Z" });
    expect(m({ item_type: "like", like: "❤️" }).content).toBe("❤️");
    expect(m({ item_type: "link", link: { text: "olha https://x.com" } })).toMatchObject({ content: "olha https://x.com", embed: true });
    expect(m({ item_type: "media", media: { image_versions2: { candidates: [{ url: "https://s.cdninstagram.com/s.jpg", width: 320, height: 240 }, { url: "https://s.cdninstagram.com/b.jpg", width: 1080, height: 810 }] } } }).attachments).toEqual([{ name: "photo.jpg", url: "https://s.cdninstagram.com/b.jpg", type: "image/jpeg", width: 1080, height: 810 }]);
    const v = m({ item_type: "voice_media", voice_media: { media: { audio: { audio_src: "https://s.cdninstagram.com/v.m4a", duration: 7300 } } } });
    expect(v.voice).toBe(true);
    expect(v.attachments![0]).toMatchObject({ type: "audio/mp4", duration: 7.3 });
    expect(m({ item_type: "media_share", media_share: { code: "ABC", user: { username: "nasa" }, caption: { text: "Mars" } } }).content).toBe("[post by @nasa]\nMars\nhttps://www.instagram.com/p/ABC/");
    const r = m({ item_type: "text", text: "sim", user_id: ME, replied_to_message: { item_id: "i0", user_id: ANA, item_type: "text", text: "vem?" } });
    expect(r.fromMe).toBe(true);
    expect(r.reply).toEqual({ id: "i0", authorId: ANA, fromMe: false, content: "vem?" });
    expect(m({ item_type: "some_new_thing" }).content).toBe("[some new thing]");
    expect(itemMessage({ item_type: "text", text: "" , item_id: "x", user_id: ANA, timestamp: us(T0) }, "t1", ME)).toBeNull();
  });
  test("a thread: one-to-one only, messages oldest first, the other's read mark; own messages get ticks", () => {
    const t = igThread(thread([{ item_id: "i2", user_id: ME, item_type: "text", text: "b", timestamp: us(T0 + 500) }, { item_id: "i1", user_id: ANA, item_type: "text", text: "a", timestamp: us(T0) }]), ME)!;
    expect(t.peer).toBe(ANA);
    expect(t.messages.map((x) => x.id)).toEqual(["i1", "i2"]);
    expect(t.peerSeenAt).toBe(itemTime(us(T0 + 1000)));
    expect(withTicks(t.messages, t.peerSeenAt).map((x) => x.status ?? "")).toEqual(["", "read"]);
    expect(igThread(thread([], { users: [{ pk: 1, username: "a" }, { pk: 2, username: "b" }] }), ME)).toBeNull();
  });
});

describe("the Instagram connection", () => {
  let dir = "";
  let calls: { method: string; url: string; body: string; auth: string }[] = [];
  let events: ConnEvent[] = [];
  let routes: Record<string, (body: string) => { status?: number; json: unknown }> = {};
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", url, body: String(init?.body ?? ""), auth: h.Authorization ?? "" });
    const path = url.replace("https://i.instagram.com/api/v1", "").replace(/\?.*$/, "");
    const r = routes[path];
    if (!r) return new Response(JSON.stringify({ status: "fail", message: "not found" }), { status: 404 });
    const out = r(String(init?.body ?? ""));
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200 });
  }) as typeof fetch;
  const ctx = (): ConnContext => ({ id: "personal-instagram-x", kind: "instagram", section: "personal", dir, emit: (e) => events.push(e), log: () => {}, openExternal: () => {} });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "persons-ig-"));
    calls = [];
    events = [];
    routes = {
      "/accounts/current_user/": () => ({ json: { status: "ok", user: { pk: Number(ME), pk_id: ME, username: "igor", full_name: "Igor" } } }),
      "/direct_v2/inbox/": () => ({ json: { status: "ok", viewer: { pk: Number(ME) }, inbox: { threads: [thread([{ item_id: "i1", user_id: ANA, item_type: "text", text: "oi", timestamp: us(T0) }])] } } }),
      "/users/ana.s/usernameinfo/": () => ({ json: { status: "ok", user: { pk: Number(ANA), pk_id: ANA, username: "ana.s", full_name: "Ana S", profile_pic_url: "https://scontent.cdninstagram.com/a.jpg" } } }),
      "/direct_v2/threads/t1/": () => ({ json: { status: "ok", thread: thread([{ item_id: "i0", user_id: ANA, item_type: "text", text: "antes", timestamp: us(T0 - 60_000) }], { has_older: false }) } }),
      "/direct_v2/threads/broadcast/text/": () => ({ json: { status: "ok", payload: { item_id: "i9", thread_id: "t1", timestamp: us(T0 + 5000) } } }),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("without a session it is signed out and says how to connect; a refused session is not kept", async () => {
    const c = createInstagram(ctx(), { fetch: fakeFetch, gapMs: 0, pollMs: 60_000 });
    await c.start();
    expect(c.state()).toMatchObject({ status: "signed-out", error: "Paste your Instagram session to connect" });
    expect(calls).toEqual([]);
    routes["/accounts/current_user/"] = () => ({ status: 403, json: { status: "fail", message: "login_required" } });
    await expect(c.setSession!(COOKIE)).rejects.toThrow("didn't accept");
    expect(existsSync(join(dir, "instagram-personal-instagram-x.json"))).toBe(false);
    await expect(c.setSession!("nonsense")).rejects.toThrow("That has no session");
    await c.stop();
  });

  test("a session that works is kept (0600) and the account shows; lookup, inbox, history, send", async () => {
    const c = createInstagram(ctx(), { fetch: fakeFetch, gapMs: 0, pollMs: 60_000 });
    await c.start();
    const st = await c.setSession!(COOKIE);
    expect(st).toMatchObject({ status: "connected", me: { id: ME, username: "igor" } });
    const file = join(dir, "instagram-personal-instagram-x.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).account).toBe("igor");
    expect(calls[0]!.auth.startsWith("Bearer IGT:2:")).toBe(true);

    expect((await c.lookup("@ana.s")).matches.map((u) => [u.id, u.username, u.globalName])).toEqual([[ANA, "ana.s", "Ana S"]]);
    expect((await c.lookup("nobody")).notFound).toBe(true);

    await c.track([ANA]);
    // the first inbox read comes right after connecting
    await new Promise((r) => setTimeout(r, 1200));
    const got = events.filter((e): e is Extract<ConnEvent, { type: "messages" }> => e.type === "messages");
    expect(got.map((e) => [e.peerId, e.messages.map((m) => m.content)])).toEqual([[ANA, ["oi"]]]);

    const h = await c.history(ANA);
    expect(h).toMatchObject({ channelId: "t1" });
    expect(h.messages.map((m) => m.content)).toEqual(["antes"]);
    expect(await c.history(ANA, "i0")).toEqual({ channelId: "t1", messages: [] });

    const sent = await c.send(ANA, "tudo bem?");
    expect(sent).toMatchObject({ ok: true, message: { id: "i9", channelId: "t1", fromMe: true, content: "tudo bem?", status: "sent" } });
    const post = calls.find((x) => x.url.endsWith("/direct_v2/threads/broadcast/text/"))!;
    const form = new URLSearchParams(post.body);
    expect([post.method, form.get("thread_ids"), form.get("text"), form.get("action")]).toEqual(["POST", "[t1]", "tudo bem?", "send_item"]);
    expect((await c.send(ANA, "x", [{ name: "a.png", type: "image/png", data: new Uint8Array(1) }])).ok).toBe(false);
    await c.stop();
  });

  test("Instagram signing the session out shows as signed out", async () => {
    const c = createInstagram(ctx(), { fetch: fakeFetch, gapMs: 0, pollMs: 60_000 });
    await c.setSession!(COOKIE);
    routes["/users/ana.s/usernameinfo/"] = () => ({ status: 401, json: { status: "fail", message: "login_required" } });
    await c.lookup("ana.s");
    expect(c.state()).toMatchObject({ status: "signed-out" });
    await c.stop();
  });
});
