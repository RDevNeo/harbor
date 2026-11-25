// The agents' Discord tools on a stand-in link: a world fed with a READY, and an API that answers from a table and
// records what was asked (no network, nothing sent anywhere).
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordTools, parseEmoji, parseInviteCode, isoToSnowflake, snowflakeToIso } from "../src/agent/discord.ts";
import { pace, PaceLog } from "../src/agent/pace.ts";
import { readFolders, withFolders } from "../src/agent/folders.ts";
import { ApiError, type DiscordLink } from "../src/conn/discord.ts";
import { createWorld } from "../src/conn/discord-world.ts";
import type { ConnStatus } from "../src/model/types.ts";

const ME = "100000000000000001";
const ANA = "100000000000000002";
const BOB = "100000000000000003";
const DM_ANA = "200000000000000001";
const GROUP = "200000000000000002";
const G1 = "300000000000000001";
const G2 = "300000000000000002";
const GENERAL = "400000000000000001";
const NEWS = "400000000000000002";

type Handler = (body: unknown, path: string) => unknown;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function msg(id: string, channel: string, author: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, channel_id: channel, author: { id: author, username: author === ME ? "me" : author === ANA ? "ana" : "bob", global_name: author === ANA ? "Ana" : null }, content, timestamp: snowflakeToIso(id), ...extra };
}

function rig(opts: { status?: ConnStatus; ready?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-discord-"));
  dirs.push(dir);
  const world = createWorld();
  if (opts.ready !== false)
    world.apply(
      "READY",
      {
        user: { id: ME, username: "me" },
        users: [
          { id: ANA, username: "ana", global_name: "Ana" },
          { id: BOB, username: "bob" },
        ],
        guilds: [
          { id: G1, properties: { name: "Guild One", owner_id: BOB }, channels: [{ id: GENERAL, type: 0, name: "general", last_message_id: "500000000000000009" }], emojis: [{ id: "600000000000000001", name: "pepega", animated: false }] },
          { id: G2, name: "Guild Two", owner_id: ME, channels: [{ id: NEWS, type: 5, name: "news", last_message_id: null }], emojis: [{ id: "600000000000000002", name: "dance", animated: true }] },
        ],
        private_channels: [
          { id: DM_ANA, type: 1, recipient_ids: [ANA], last_message_id: "500000000000000005" },
          { id: GROUP, type: 3, name: "", recipient_ids: [ANA, BOB], last_message_id: "500000000000000001" },
        ],
        relationships: [{ id: ANA, type: 1, nickname: "Aninha" }],
        read_state: { entries: [{ id: DM_ANA, last_message_id: "500000000000000003", mention_count: 2 }, { id: GROUP, last_message_id: "500000000000000001", mention_count: 0 }, { id: GENERAL, last_message_id: "500000000000000001", mention_count: 1 }] },
        user_guild_settings: { entries: [{ guild_id: G1, muted: false, mute_config: null }] },
        user_settings_proto: withFolders("", [
          { guildIds: [G2], id: null, name: null, color: null },
          { guildIds: [G1], id: "77", name: "Work", color: 3447003 },
        ]),
      },
      ME,
    );
  const calls: { method: string; path: string; body: unknown }[] = [];
  const routes = new Map<string, Handler>();
  const listeners = new Set<(t: string, d: unknown) => void>();
  let status: ConnStatus = opts.status ?? "connected";
  const link: DiscordLink = {
    status: () => status,
    me: () => ({ id: ME, username: "me", globalName: null, avatar: null }),
    gatewayUp: () => true,
    async api<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      const key = `${method} ${path.split("?")[0]}`;
      const h = routes.get(key);
      if (!h) throw new ApiError(`no route ${key}`, 404);
      return h(body, path) as T;
    },
    async upload(_cid, files) {
      calls.push({ method: "UPLOAD", path: _cid, body: files.map((f) => f.name) });
      return files.map((f, i) => ({ id: String(i), filename: f.name, uploaded_filename: `up/${f.name}` }));
    },
    world,
    presence: (uid) => (uid === ANA ? "online" : null),
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const tools = new DiscordTools({ link: () => link, about: () => ({ label: "Stores Discord", status, error: null }), paceFile: join(dir, "pace.json"), sleep: (ms) => Bun.sleep(Math.min(ms, 1)), confirmMs: 200 });
  const run = async (name: string, args: Record<string, unknown> = {}, chat: number | null = 1): Promise<Record<string, unknown>> => {
    const r = await tools.call(name, args, chat);
    return ("json" in r ? r.json : { text: r.text }) as Record<string, unknown>;
  };
  return { dir, world, calls, routes, link, tools, run, emit: (t: string, d: unknown) => [...listeners].forEach((l) => l(t, d)), setStatus: (s: ConnStatus) => (status = s) };
}

describe("agents' Discord tools", () => {
  it("say how to sign in when the account is signed out, and there's no Discord at all", async () => {
    const r = rig({ status: "signed-out" });
    expect((await r.run("discord_status")).text).toContain("Persons tab: Stores › + › Discord");
    await expect(r.tools.call("discord_dms", {})).rejects.toThrow("signed out. Sign in in Hub's Persons tab");
    const none = new DiscordTools({ link: () => null, about: () => null, paceFile: join(r.dir, "p.json") });
    await expect(none.call("discord_send", { channelId: DM_ANA, content: "x" })).rejects.toThrow("no Discord account for its agents");
    expect(((await none.call("discord_status", {})) as { text: string }).text).toContain("Not signed in");
  });

  it("status says who's signed in and that there's no page; screenshot has no picture but the channel as text", async () => {
    const r = rig();
    const s = (await r.run("discord_status")).text as string;
    expect(s).toContain("Signed in as me (@me), the Stores Discord account");
    expect(s).toContain("no Discord page");
    expect((await r.run("discord_screenshot", { savePath: "/tmp/x.png" })).text).toContain("Nothing was saved to /tmp/x.png");
  });

  it("lists DMs in sidebar order with friend nicknames, ranked by a query", async () => {
    const r = rig();
    const all = await r.run("discord_dms");
    expect(all.total).toBe(2);
    const dms = all.dms as { channelId: string; kind: string; name: string }[];
    expect(dms.map((d) => [d.channelId, d.kind, d.name])).toEqual([
      [DM_ANA, "dm", "Aninha"],
      [GROUP, "group", "Aninha, bob"],
    ]);
    const q = await r.run("discord_dms", { query: "aninha" });
    expect((q.dms as { channelId: string }[])[0]?.channelId).toBe(DM_ANA);
    expect(q.matched).toBe(2);
  });

  it("open picks this chat's channel; view reads its newest messages over the API, oldest first", async () => {
    const r = rig();
    await expect(r.run("discord_view")).rejects.toThrow("No channel is open in this chat");
    const o = await r.run("discord_open", { channelId: DM_ANA });
    expect(o).toMatchObject({ ok: true, currentChannelId: DM_ANA, path: `/channels/@me/${DM_ANA}` });
    r.routes.set(`GET /channels/${DM_ANA}/messages`, () => [
      msg("500000000000000005", DM_ANA, ANA, "second", { message_reference: { message_id: "500000000000000004" }, referenced_message: msg("500000000000000004", DM_ANA, ME, "first") }),
      msg("500000000000000004", DM_ANA, ME, "first"),
    ]);
    const v = await r.run("discord_view");
    expect((v.channel as { id: string }).id).toBe(DM_ANA);
    const ms = v.messages as { id: string; content: string; replyTo?: { authorName: string } }[];
    expect(ms.map((m) => m.content)).toEqual(["first", "second"]);
    expect(ms[1]?.replyTo?.authorName).toBe("me");
    expect(v.participants).toContainEqual({ userId: ANA, name: "Ana", presence: "online", typing: false });
    // another chat has its own open channel
    await expect(r.run("discord_view", {}, 2)).rejects.toThrow("No channel is open");
    // the channel is the default for tools without channelId
    const h = await r.run("discord_history", { limit: 5 });
    expect((h.channel as { id: string }).id).toBe(DM_ANA);
    expect(h.count).toBe(2);
    expect(h.newestId).toBe("500000000000000005");
  });

  it("history pages back 100 at a time, filters, and says where to go on", async () => {
    const r = rig();
    const page = (from: bigint, n: number) => Array.from({ length: n }, (_, i) => msg(String(from - BigInt(i)), GENERAL, i % 2 ? ANA : BOB, i % 3 ? "hello" : "bye"));
    r.routes.set(`GET /channels/${GENERAL}/messages`, (_b, p) => (p.includes("before=") ? page(500000000000000800n, 100) : page(500000000000000999n, 100)));
    const h = await r.run("discord_history", { channelId: GENERAL, limit: 40, contains: "BYE", select: ["id", "author"] });
    expect(h.count).toBe(40);
    expect(h.pagesFetched).toBe(2);
    expect(h.hasMoreBefore).toBe(true);
    expect(typeof h.nextBefore).toBe("string");
    const first = (h.messages as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(["author", "id"]);
  });

  it("send paces, checks a reply exists, shows typing, uploads files and posts the message as the client does", async () => {
    const r = rig();
    r.routes.set(`GET /channels/${DM_ANA}/messages`, (_b, p) => (p.includes("around=500000000000000004") ? [msg("500000000000000004", DM_ANA, ANA, "hi")] : []));
    r.routes.set(`POST /channels/${DM_ANA}/typing`, () => null);
    r.routes.set(`POST /channels/${DM_ANA}/messages`, () => msg("500000000000000099", DM_ANA, ME, "ok"));
    await expect(r.run("discord_send", { channelId: DM_ANA, content: "x", replyToMessageId: "500000000000000003" })).rejects.toThrow("not found in channel");
    const s = await r.run("discord_send", { channelId: DM_ANA, content: "hey", replyToMessageId: "500000000000000004", typing: true, files: [{ name: "a.txt", mime: "text/plain", base64: Buffer.from("abc").toString("base64") }] });
    expect(s).toMatchObject({ ok: true, channel: { id: DM_ANA, name: "(DM)", guildId: null, guildName: null }, messageId: "500000000000000099", fileCount: 1, replyTo: "500000000000000004", tts: false });
    const post = r.calls.find((c) => c.method === "POST" && c.path === `/channels/${DM_ANA}/messages`);
    expect(post?.body).toMatchObject({ content: "hey", message_reference: { channel_id: DM_ANA, message_id: "500000000000000004" }, attachments: [{ filename: "a.txt", uploaded_filename: "up/a.txt" }] });
    expect(r.calls.some((c) => c.path === `/channels/${DM_ANA}/typing`)).toBe(true);
    // a second upload within 20 s is paced: told, not sent
    const again = await r.run("discord_send", { channelId: DM_ANA, files: [{ name: "b.txt", base64: Buffer.from("b").toString("base64") }] });
    expect(again.paced).toBe(true);
    expect(String(again.note)).toContain("Tell the user");
    await expect(r.run("discord_send", { channelId: DM_ANA })).rejects.toThrow("`content` is required");
  });

  it("a send Discord answers with a captcha says to send it from the Discord app", async () => {
    const r = rig();
    r.routes.set(`POST /channels/${DM_ANA}/messages`, () => {
      throw new ApiError("captcha", 400, undefined, true);
    });
    await expect(r.run("discord_send", { channelId: DM_ANA, content: "hey" })).rejects.toThrow("captcha");
  });

  it("react, edit and delete check the message first; edit and delete only touch the account's own", async () => {
    const r = rig();
    r.routes.set(`GET /channels/${DM_ANA}/messages`, (_b, p) => (p.includes("around=500000000000000004") ? [msg("500000000000000004", DM_ANA, ANA, "hi")] : p.includes("around=500000000000000006") ? [msg("500000000000000006", DM_ANA, ME, "mine")] : []));
    r.routes.set(`PUT /channels/${DM_ANA}/messages/500000000000000004/reactions/${encodeURIComponent("pepega:600000000000000001")}/@me`, () => null);
    r.routes.set(`PATCH /channels/${DM_ANA}/messages/500000000000000006`, () => ({}));
    r.routes.set(`DELETE /channels/${DM_ANA}/messages/500000000000000006`, () => null);
    expect(await r.run("discord_react", { channelId: DM_ANA, messageId: "500000000000000004", emoji: "<:pepega:600000000000000001>" })).toMatchObject({ ok: true, emoji: "<:pepega:600000000000000001>", action: "add" });
    await expect(r.run("discord_react", { channelId: DM_ANA, messageId: "500000000000000001", emoji: "👍" })).rejects.toThrow("not found");
    await expect(r.run("discord_react", { channelId: DM_ANA, messageId: "500000000000000004", emoji: ":thumbsup:" })).rejects.toThrow("Shortcode");
    await expect(r.run("discord_edit", { channelId: DM_ANA, messageId: "500000000000000004", content: "x" })).rejects.toThrow("only allows editing your own");
    expect(await r.run("discord_edit", { channelId: DM_ANA, messageId: "500000000000000006", content: "fixed" })).toMatchObject({ ok: true, content: "fixed" });
    expect(await r.run("discord_delete", { channelId: DM_ANA, messageId: "500000000000000006" })).toMatchObject({ ok: true, deletedContentPreview: "mine" });
  });

  it("dm_open reuses a DM, paces new ones, and opens it in the chat", async () => {
    const r = rig();
    r.routes.set("POST /users/@me/channels", (b) => {
      const ids = (b as { recipients: string[] }).recipients;
      return ids[0] === ANA ? { id: DM_ANA, type: 1, recipients: [{ id: ANA, username: "ana" }], last_message_id: "500000000000000005" } : { id: "200000000000000077", type: 1, recipients: [{ id: ids[0], username: "new" }], last_message_id: null };
    });
    expect(await r.run("discord_dm_open", { userId: ANA })).toMatchObject({ channelId: DM_ANA, kind: "dm", name: "Aninha", created: false, existed: true });
    const n = await r.run("discord_dm_open", { userId: "100000000000000077" });
    expect(n).toMatchObject({ channelId: "200000000000000077", created: true });
    expect(await r.run("discord_dm_open", { userId: "100000000000000078" })).toMatchObject({ paced: true });
    expect((await r.run("discord_open", { channelId: "200000000000000077" })).currentChannelId).toBe("200000000000000077");
  });

  it("emoji, guild sidebar from the settings proto, and organize writes the folders back", async () => {
    const r = rig();
    const e = await r.run("discord_emoji", { query: "dan" });
    expect(e.emojis).toEqual([{ name: "dance", id: "600000000000000002", animated: true, guildId: G2, guildName: "Guild Two", url: "https://cdn.discordapp.com/emojis/600000000000000002.gif?size=96", shortcode: "<a:dance:600000000000000002>" }]);
    const g = await r.run("discord_guilds");
    expect(g.sidebar).toEqual([
      { kind: "guild", guildId: G2, name: "Guild Two" },
      { kind: "folder", id: "77", name: "Work", color: 3447003, expanded: true, guildIds: [G1], guilds: [{ id: G1, name: "Guild One" }] },
    ]);
    const bad = await r.run("discord_organize", { sidebar: [{ kind: "guild", guildId: G1 }] });
    expect(bad.applied).toBe(false);
    expect(String((bad.errors as string[])[0])).toContain("missing guilds");
    const dry = await r.run("discord_organize", { sidebar: [{ kind: "folder", guildIds: [G1, G2], name: "All", id: "5" }] });
    expect(dry).toMatchObject({ applied: false, dryRun: true });
    let saved = "";
    r.routes.set("GET /users/@me/settings-proto/1", () => ({ settings: r.world.settingsProto }));
    r.routes.set("PATCH /users/@me/settings-proto/1", (b) => {
      saved = (b as { settings: string }).settings;
      return { settings: saved };
    });
    expect(await r.run("discord_organize", { sidebar: [{ kind: "folder", guildIds: [G1, G2], name: "All", id: "5" }], apply: true })).toMatchObject({ applied: true, entries: 1 });
    expect(readFolders(saved)).toEqual([{ guildIds: [G1, G2], id: "5", name: "All", color: null }]);
  });

  it("unread reads Discord's read state and counts the top ones; ack marks a channel read", async () => {
    const r = rig();
    r.routes.set(`GET /channels/${DM_ANA}/messages`, () => [msg("500000000000000005", DM_ANA, ANA, "b"), msg("500000000000000004", DM_ANA, ANA, "a")]);
    const u = await r.run("discord_unread");
    expect(u.count).toBe(1);
    expect((u.channels as Record<string, unknown>[])[0]).toMatchObject({ channelId: DM_ANA, kind: "dm", name: "Aninha", mentionCount: 2, unreadCount: 2, oldestUnreadId: "500000000000000004", lastReadMessageId: "500000000000000003" });
    const withGuilds = await r.run("discord_unread", { includeGuilds: true, countTop: 0 });
    expect((withGuilds.channels as { channelId: string }[]).map((c) => c.channelId)).toEqual([DM_ANA, GENERAL]);
    expect(withGuilds.channelsNotCounted).toBe(2);
    r.routes.set(`POST /channels/${DM_ANA}/messages/500000000000000005/ack`, () => ({}));
    expect(await r.run("discord_ack", { channelId: DM_ANA })).toMatchObject({ ok: true, ackedMessageId: "500000000000000005" });
    expect((await r.run("discord_unread")).count).toBe(0);
  });

  it("join previews, reports a captcha instead of solving it, and joins when the gateway confirms", async () => {
    const r = rig();
    r.routes.set("GET /invites/abc", () => ({ guild: { id: "300000000000000009", name: "New" }, channel: { id: "1", name: "welcome" }, approximate_member_count: 10, inviter: { id: BOB, username: "bob" } }));
    expect(parseInviteCode("https://discord.gg/abc?x=1")).toBe("abc");
    expect(await r.run("discord_join", { invite: "discord.gg/abc" })).toMatchObject({ joined: false, dryRun: true, guild: { id: "300000000000000009", name: "New" }, approxMembers: 10 });
    r.routes.set("POST /invites/abc", () => {
      throw new ApiError("captcha", 400, undefined, true);
    });
    const c = await r.run("discord_join", { invite: "abc", apply: true });
    expect(c).toMatchObject({ joined: false, captchaRequired: true });
    expect(String(c.note)).toContain("own Discord app");
    r.routes.set("POST /invites/abc", () => {
      setTimeout(() => r.world.apply("GUILD_CREATE", { id: "300000000000000009", name: "New", channels: [] }, ME), 5);
      return { guild: { id: "300000000000000009" } };
    });
    expect(await r.run("discord_join", { invite: "abc", apply: true })).toMatchObject({ joined: true });
    expect(await r.run("discord_join", { invite: "abc" })).toMatchObject({ alreadyMember: true });
    r.routes.set("GET /invites/gone", () => {
      throw new ApiError("Unknown Invite", 404, 10006);
    });
    expect(await r.run("discord_join", { invite: "gone" })).toMatchObject({ joined: false, error: "Invite is invalid, expired, or revoked." });
  });

  it("leave and mute are dry runs unless applied, refuse an owned server, and confirm what Discord did", async () => {
    const r = rig();
    expect(await r.run("discord_leave", { guildId: G2 })).toMatchObject({ left: false, ownsGuild: true });
    expect(await r.run("discord_leave", { guildId: G1 })).toMatchObject({ left: false, dryRun: true, guild: { id: G1, name: "Guild One", ownerId: BOB } });
    r.routes.set(`DELETE /users/@me/guilds/${G1}`, () => {
      setTimeout(() => r.world.apply("GUILD_DELETE", { id: G1 }, ME), 5);
      return null;
    });
    expect(await r.run("discord_leave", { guildId: G1, apply: true })).toMatchObject({ left: true, stillMember: false });
    expect(await r.run("discord_leave", { guildId: G1 })).toMatchObject({ alreadyAbsent: true });
    expect(await r.run("discord_mute_guild", { guildId: G2 })).toMatchObject({ applied: false, dryRun: true, action: "mute", duration: "forever" });
    r.routes.set(`PATCH /users/@me/guilds/${G2}/settings`, (b) => ({ ...(b as object), guild_id: G2 }));
    const m = await r.run("discord_mute_guild", { guildId: G2, duration: "1h", apply: true });
    expect(m).toMatchObject({ applied: true, after: { muted: true } });
    expect(await r.run("discord_mute_guild", { guildId: G2, duration: "1h" })).toMatchObject({ unchanged: true });
    expect(await r.run("discord_mute_guild", { guildId: G2, action: "unmute", apply: true })).toMatchObject({ applied: true, after: { muted: false } });
  });

  it("waitForMessage takes the gateway's MESSAGE_CREATE that matches, or times out", async () => {
    const r = rig();
    const p = r.run("discord_waitForMessage", { fromUserId: ANA, contains: "ping", timeoutMs: 5000 });
    await Bun.sleep(5);
    r.emit("MESSAGE_CREATE", msg("500000000000000010", DM_ANA, ME, "ping"));
    r.emit("MESSAGE_CREATE", msg("500000000000000011", DM_ANA, ANA, "no"));
    r.emit("MESSAGE_CREATE", msg("500000000000000012", DM_ANA, ANA, "PING you"));
    const got = await p;
    expect(got).toMatchObject({ done: true, timedOut: false });
    expect((got.matches as { id: string; author: { name: string } }[]).map((m) => [m.id, m.author.name])).toEqual([["500000000000000012", "Ana"]]);
    expect(await r.run("discord_waitForMessage", { timeoutMs: 1000, channelId: GROUP })).toEqual({ done: false, timedOut: true, matches: [] });
  });

  it("find_user searches who the account knows, locally; member reads the profile", async () => {
    const r = rig();
    r.world.apply("MESSAGE_CREATE", { ...msg("500000000000000020", GENERAL, BOB, "x"), guild_id: G1, member: { nick: "Bobby" } }, ME);
    const f = await r.run("discord_find_user", { query: "bobby" });
    expect((f.matches as Record<string, unknown>[])[0]).toMatchObject({ id: BOB, match: "exact name", relationship: "none", serverNicknames: [{ guildId: G1, guildName: "Guild One", nick: "Bobby" }], sharedServers: [{ id: G1, name: "Guild One" }] });
    const a = await r.run("discord_find_user", { query: "@ana" });
    expect((a.matches as Record<string, unknown>[])[0]).toMatchObject({ id: ANA, match: "username", relationship: "friend", friendNickname: "Aninha", dmChannelId: DM_ANA });
    expect(r.calls).toEqual([]);
    r.routes.set(`GET /users/${ANA}/profile`, () => ({ user: { id: ANA, username: "ana", global_name: "Ana", avatar: "abc" }, user_profile: { bio: "hi" }, mutual_guilds: [{ id: G1 }] }));
    expect(await r.run("discord_member", { userId: ANA })).toMatchObject({ id: ANA, globalName: "Ana", bio: "hi", status: "online", mutualGuildCount: 1, avatarUrl: `https://cdn.discordapp.com/avatars/${ANA}/abc.png?size=256` });
    await expect(r.run("discord_member", { userId: "100000000000000099" })).rejects.toThrow("User not found");
  });

  it("search, user messages, pins, threads, resolveMessage, attachment and stats over the API", async () => {
    const r = rig();
    r.routes.set(`GET /guilds/${G1}/messages/search`, (_b, p) => (p.includes("content=wait") ? { code: 110000, retry_after: 3 } : { total_results: 1, messages: [[{ ...msg("500000000000000030", GENERAL, ANA, "found"), hit: true }]] }));
    expect(await r.run("discord_search", { channelId: GENERAL, query: "found" })).toMatchObject({ totalResults: 1, count: 1, messages: [{ id: "500000000000000030", hit: true }] });
    expect(await r.run("discord_search", { channelId: GENERAL, query: "wait" })).toMatchObject({ indexing: true, retryAfter: 3 });
    expect(await r.run("discord_user_messages", { guildId: G1, userId: ANA })).toMatchObject({ count: 1, hasMore: false, nextOffset: null, messages: [{ channelId: GENERAL, guildId: G1 }] });
    r.routes.set(`GET /channels/${GENERAL}/pins`, () => {
      throw new ApiError("gone", 404);
    });
    r.routes.set(`GET /channels/${GENERAL}/messages/pins`, () => ({ items: [{ message: msg("500000000000000031", GENERAL, BOB, "rules") }] }));
    expect(await r.run("discord_pins", { channelId: GENERAL })).toMatchObject({ count: 1, messages: [{ id: "500000000000000031", content: "rules" }] });
    r.routes.set(`GET /guilds/${G1}/threads/active`, () => ({ threads: [{ id: "700000000000000001", name: "t", type: 11, parent_id: GENERAL }] }));
    r.routes.set(`GET /channels/${GENERAL}/threads/archived/public`, () => ({ threads: [] }));
    expect(await r.run("discord_threads", { channelId: GENERAL })).toMatchObject({ parentId: GENERAL, activeCount: 1, archivedCount: 0 });
    r.routes.set(`GET /channels/${GENERAL}/messages`, (_b, p) => {
      if (p.includes("around=500000000000000041")) return [msg("500000000000000041", GENERAL, ANA, "child", { message_reference: { message_id: "500000000000000040" }, attachments: [{ filename: "a.png", url: "https://cdn.discordapp.com/a.png", size: 3, content_type: "image/png" }] })];
      if (p.includes("around=500000000000000040")) return [msg("500000000000000040", GENERAL, BOB, "parent")];
      return [msg("500000000000000041", GENERAL, ANA, "see https://www.example.com/x", { message_reference: { message_id: "500000000000000040" } }), msg("500000000000000040", GENERAL, BOB, "parent words words")];
    });
    const res = await r.run("discord_resolveMessage", { channelId: GENERAL, messageId: "500000000000000041" });
    expect((res.replyChain as { content: string }[]).map((m) => m.content)).toEqual(["parent"]);
    expect(await r.run("discord_attachment", { channelId: GENERAL, messageId: "500000000000000041" })).toMatchObject({ index: 0, attachmentCount: 1, name: "a.png", url: "https://cdn.discordapp.com/a.png", contentType: "image/png" });
    const st = await r.run("discord_stats", { channelId: GENERAL });
    expect(st.summary).toMatchObject({ total: 2, links: 1, replies: 1, distinctAuthors: 2, scanComplete: true });
    expect(st.replyEdges).toEqual([{ from: ANA, fromName: "Ana", to: BOB, toName: "bob", count: 1 }]);
    expect(st.topDomains).toEqual([{ domain: "example.com", count: 1 }]);
  });

  it("onboarding answers required questions with their first option and agrees to the rules", async () => {
    const r = rig();
    r.routes.set(`GET /guilds/${G1}/onboarding`, () => ({ enabled: true, prompts: [{ id: "p1", required: true, options: [{ id: "o1", title: "A" }, { id: "o2" }] }, { id: "p2", required: false, options: [{ id: "o3" }] }] }));
    let answers: unknown = null;
    r.routes.set(`POST /guilds/${G1}/onboarding-responses`, (b) => ((answers = b), {}));
    r.routes.set(`GET /guilds/${G1}/member-verification`, () => ({ version: "v1", form_fields: [{ field_type: "TERMS", label: "Rules", values: ["be nice"], required: true }] }));
    let agreed: unknown = null;
    r.routes.set(`PUT /guilds/${G1}/requests/@me`, (b) => ((agreed = b), {}));
    const o = await r.run("discord_onboarding", { guildId: G1 });
    expect(o).toMatchObject({ completed: true, handled: 3, startGuild: G1 });
    expect((answers as { onboarding_responses: string[] }).onboarding_responses).toEqual(["o1"]);
    expect((agreed as { form_fields: { response: boolean }[] }).form_fields[0]?.response).toBe(true);
    expect(await r.run("discord_onboarding", {}, 9)).toMatchObject({ completed: false, log: ["No server to onboard: pass `guildId` (or join one with discord_join first)."] });
  });

  it("tools that need the live connection say to wait while it isn't up", async () => {
    const r = rig({ ready: false });
    await expect(r.run("discord_dms")).rejects.toThrow("live connection isn't up yet");
  });
});

describe("pieces", () => {
  it("pace: a gap, an hour's and a day's limit", () => {
    expect(pace("send", [], 1000)).toEqual({ go: true });
    expect(pace("dm", [["dm", 990]], 1000)).toHaveProperty("refuse");
    expect(pace("send", [["send", 999]], 1000)).toEqual({ go: true });
    expect(pace("upload", [["upload", 990]], 1000)).toHaveProperty("refuse");
    expect(pace("upload", [["upload", 983]], 1000)).toEqual({ wait: 3 });
  });

  it("pace log keeps a day in a file", () => {
    const d = mkdtempSync(join(tmpdir(), "pace-"));
    dirs.push(d);
    let t = 10_000;
    const log = new PaceLog(join(d, "p.json"), () => t);
    expect(log.check("upload")).toEqual({ go: true });
    log.note("upload");
    expect(log.check("upload")).toHaveProperty("refuse");
    t += 21;
    expect(log.check("upload")).toEqual({ go: true });
    expect(log.read()).toEqual([["upload", 10_000]]);
  });

  it("folders survive a round trip, and other settings stay byte for byte", () => {
    // field 2 (some other setting) before the folders
    const other = Buffer.from([0x12, 0x03, 0x08, 0x01, 0x10]).toString("base64");
    const f = [{ guildIds: ["300000000000000001", "300000000000000002"], id: "-5", name: "Ünïcode", color: 255 }, { guildIds: ["300000000000000003"], id: null, name: null, color: null }];
    const out = withFolders(other, f);
    expect(readFolders(out)).toEqual(f);
    expect(Buffer.from(out, "base64").subarray(0, 5)).toEqual(Buffer.from(other, "base64"));
    expect(readFolders(withFolders(out, []))).toEqual([]);
    expect(() => readFolders(Buffer.from([0x72, 0x7f]).toString("base64"))).toThrow("damaged");
  });

  it("emoji, invites and snowflakes", () => {
    expect(parseEmoji("<a:dance:123>")).toEqual({ name: "dance", id: "123", animated: true });
    expect(parseEmoji("🔥")).toEqual({ name: "🔥", id: null, animated: false });
    expect(parseInviteCode("https://discord.com/invite/xyz/")).toBe("xyz");
    const s = isoToSnowflake("2024-01-01T00:00:00.000Z") as string;
    expect(snowflakeToIso(s)).toBe("2024-01-01T00:00:00.000Z");
  });
});
