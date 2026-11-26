// Ported from Person Hub's src/lib/discord-core.test.ts (shell/discord-core.cjs), plus the file rules
// (shell/files.cjs) and the session helper's answer.
import { describe, expect, it } from "bun:test";
import * as core from "../src/conn/discord-core.ts";
import type { Message } from "../src/model/types.ts";

describe("Discord helpers", () => {
  it("builds avatar URLs, with Discord’s default avatar as fallback", () => {
    expect(core.avatarUrl({ id: "581633588764606504", avatar: "abc" }, 64)).toBe("https://cdn.discordapp.com/avatars/581633588764606504/abc.png?size=64");
    expect(core.avatarUrl({ id: "1", avatar: "a_anim" })).toContain(".gif");
    const def = core.avatarUrl({ id: "581633588764606504", avatar: null });
    expect(def).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    expect(def).toBe(`https://cdn.discordapp.com/embed/avatars/${Number((581633588764606504n >> 22n) % 6n)}.png`);
    expect(core.defaultAvatarUrl("1", "1234")).toBe("https://cdn.discordapp.com/embed/avatars/4.png");
  });

  it("slims users and messages", () => {
    const raw = { id: "1", username: "ana", global_name: "Ana", avatar: "h", discriminator: "0", email: "x" };
    expect(core.slimUser(raw)).toEqual({ id: "1", username: "ana", globalName: "Ana", avatar: "h" });
    expect(core.slimUser({ id: "2", username: "old", discriminator: "1234", bot: true })).toEqual({ id: "2", username: "old", globalName: null, avatar: null, discriminator: "1234", bot: true });
    expect(core.slimUser(null)).toBeNull();
    const m = core.slimMessage({ id: "10", channel_id: "5", author: { id: "me" }, content: "hi", timestamp: "t", attachments: [{ filename: "a.png", url: "u" }] }, "me");
    expect(m).toEqual({ id: "10", channelId: "5", authorId: "me", fromMe: true, content: "hi", timestamp: "t", attachments: [{ name: "a.png", url: "u" }] });
    expect(core.slimMessage({ id: "11", channel_id: "5", author: { id: "u" }, content: "", embeds: [{}], edited_timestamp: "x" }, "me")).toMatchObject({ embed: true, edited: true, fromMe: false });
  });

  it("shows forwards (their snapshot) and stickers instead of an empty bubble", () => {
    const fwd = core.slimMessage({ id: "12", channel_id: "5", author: { id: "u" }, content: "", message_snapshots: [{ message: { content: "look", attachments: [{ filename: "s.jpg", url: "v" }] } }] }, "me");
    expect(fwd).toMatchObject({ forwarded: true, content: "look", attachments: [{ name: "s.jpg", url: "v" }] });
    const st = core.slimMessage({ id: "13", channel_id: "5", author: { id: "u" }, content: "", sticker_items: [{ id: "99", name: "wave", format_type: 1 }, { id: "98", name: "dance", format_type: 3 }] }, "me");
    expect(st.attachments).toEqual([{ name: "wave.png", url: "https://media.discordapp.net/stickers/99.png?size=160", type: "image/png", width: 160, height: 160 }]);
    expect(st.content).toBe("[Sticker: dance]");
  });

  it("keeps replies (quoted message) and voice waveforms", () => {
    const m = core.slimMessage({ id: "20", channel_id: "5", author: { id: "u" }, content: "yes", type: 19, message_reference: { message_id: "10" }, referenced_message: { id: "10", author: { id: "me" }, content: "question?" } }, "me");
    expect(m.reply).toEqual({ id: "10", authorId: "me", fromMe: true, content: "question?" });
    expect(core.slimMessage({ id: "21", channel_id: "5", author: { id: "u" }, content: "x", type: 19, message_reference: { message_id: "9" }, referenced_message: null }, "me").reply).toEqual({ id: "9", deleted: true });
    expect(core.slimAttachment({ filename: "voice-message.ogg", url: "u", duration_secs: 3, waveform: "AAEC" })).toMatchObject({ duration: 3, waveform: "AAEC" });
    const v = core.slimMessage(
      {
        id: "22",
        channel_id: "5",
        author: { id: "me" },
        content: "ok",
        type: 19,
        message_reference: { message_id: "11" },
        referenced_message: { id: "11", author: { id: "u" }, content: "", flags: 8192, attachments: [{ filename: "voice-message.ogg", url: "u", duration_secs: 47 }] },
      },
      "me",
    );
    expect(v.reply).toMatchObject({ id: "11", voice: true, attachments: 1, attachment: { name: "voice-message.ogg", duration: 47 } });
  });

  it("ranks username matches: exact username, display name, prefix, contains", () => {
    const users = [
      { id: "1", username: "yagasnask_alt", globalName: null },
      { id: "2", username: "someone", globalName: "yagasnask" },
      { id: "3", username: "yagasnask", globalName: "Yagas" },
      { id: "4", username: "xyagasnask", globalName: null },
      { id: "5", username: "other", globalName: "Other" },
    ];
    expect(core.rankUsers(users, "@YagasNask").map((u) => u.id)).toEqual(["3", "2", "1", "4"]);
    expect(core.rankUsers(users, "name#1234")).toEqual([]);
    expect(core.rankUsers(users, "")).toEqual([]);
  });

  it("paces sends: the first goes at once, close ones wait a human gap", () => {
    let t = 1000;
    const p = core.createPacer({ minGap: 2000, maxGap: 4000, now: () => t, random: () => 0.5 });
    expect(p.reserve()).toBe(0);
    expect(p.reserve()).toBe(3000);
    expect(p.reserve()).toBe(6000);
    t += 60_000;
    expect(p.reserve()).toBe(0);
  });

  it("limits gateway member searches", () => {
    let t = 0;
    const b = core.createBucket({ capacity: 2, perMs: 1000, now: () => t });
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    t = 500;
    expect(b.take()).toBe(true);
  });

  it("merges conversations by peer without duplicates, in snowflake order", () => {
    const c = core.createConversations(3);
    const msg = (id: string, content = id): Message => ({ id, channelId: "c1", authorId: "u", fromMe: false, content, timestamp: "" });
    expect(c.merge("u", [msg("9"), msg("10")])).toBe(true);
    expect(c.merge("u", [msg("10")])).toBe(false);
    expect(c.peerOf("c1")).toBe("u");
    c.merge("u", [msg("8"), msg("11"), msg("10", "edited")]);
    expect(c.get("u")?.messages.map((m) => m.id)).toEqual(["9", "10", "11"]);
    expect(c.get("u")?.messages[1]?.content).toBe("edited");
    expect(c.remove("c1", "10")).toBe("u");
    expect(c.remove("c1", "10")).toBeNull();
    expect(c.lastId("u")).toBe("11");
    const copy = core.createConversations();
    copy.load(JSON.parse(JSON.stringify(c.toJSON())));
    expect(copy.channelOf("u")).toBe("c1");
    expect(copy.get("u")?.messages.map((m) => m.id)).toEqual(["9", "11"]);
    copy.load({ bad: null, worse: { messages: "x" }, ok: { channelId: "c2", messages: [null, { id: "1" }] } });
    expect(copy.get("ok")?.messages).toHaveLength(1);
    expect(copy.peerOf("c2")).toBe("ok");
  });

  it("finds the partner of a DM in both READY shapes", () => {
    const users = new Map([["7", { id: "7", username: "z", globalName: null, avatar: null }]]);
    expect(core.dmPeer({ type: 1, recipient_ids: ["7"] }, users)).toEqual({ id: "7", user: { id: "7", username: "z", globalName: null, avatar: null } });
    expect(core.dmPeer({ type: 1, recipients: [{ id: "8", username: "y" }] })?.id).toBe("8");
    expect(core.dmPeer({ type: 3, recipient_ids: ["7", "8"] }, users)).toBeNull();
  });

  it("reads super properties safely", () => {
    expect(core.decodeSuperProps(Buffer.from(JSON.stringify({ os: "Linux" })).toString("base64"))).toEqual({ os: "Linux" });
    expect(core.decodeSuperProps("%%%")).toBeNull();
  });

  it("reads presences from READY / READY_SUPPLEMENTAL, friends and member chunks", () => {
    const a = "100000000000000001";
    const b = "100000000000000002";
    const c = "100000000000000003";
    const ready = core.readyPresences({
      presences: [{ user: { id: a }, status: "idle" }],
      merged_presences: { friends: [{ user_id: b, status: "online" }], guilds: [[{ user_id: c, status: "dnd" }, { user_id: "x", status: "online" }], []] },
    });
    expect(Object.fromEntries(ready)).toEqual({ [a]: "idle", [b]: "online", [c]: "dnd" });
    expect(core.readyPresences({}).size).toBe(0);
    expect(core.presenceEntry({ user_id: a, status: "weird" })).toBeNull();
    expect([...core.friendIds([{ id: a, type: 1 }, { id: b, type: 2 }, { user_id: c, type: 1 }])]).toEqual([a, c]);
    const chunk = core.chunkPresences({ members: [{ user: { id: a } }, { user: { id: b } }], presences: [{ user: { id: a }, status: "online" }] });
    expect(Object.fromEntries(chunk)).toEqual({ [a]: "online", [b]: "offline" });
  });

  it("plans member subscriptions: one guild each, shared guilds first, bounded", () => {
    expect(core.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    const guildsOf = new Map<string, string[]>([
      ["u1", ["g1", "g2"]],
      ["u2", ["g2"]],
      ["u3", ["g3", "g2"]],
      ["u4", []],
    ]);
    expect(core.planMemberSubscriptions(guildsOf)).toEqual({ g2: ["u1", "u2", "u3"] });
    // already following someone in g1: it's reused, and kept
    expect(core.planMemberSubscriptions(new Map([["u5", ["g1", "g2"]]]), { g1: ["u1"] })).toEqual({ g1: ["u1", "u5"] });
    // per-guild cap moves people to their other guild; the total cap stops
    expect(core.planMemberSubscriptions(guildsOf, {}, { perGuild: 2 })).toEqual({ g2: ["u1", "u2"], g3: ["u3"] });
    expect(Object.values(core.planMemberSubscriptions(guildsOf, {}, { total: 1 })).flat()).toHaveLength(1);
  });

  it("compares and makes snowflakes", () => {
    expect(core.cmpId("9", "10")).toBe(-1);
    expect(core.cmpId("10", "10")).toBe(0);
    expect(core.isSnowflake("581633588764606504")).toBe(true);
    expect(core.isSnowflake("12")).toBe(false);
    const t = Date.UTC(2026, 0, 1);
    expect(core.snowflakeTime(core.nowSnowflake(t))).toBe(new Date(t).toISOString());
  });
});

describe("files", () => {
  it("makes safe file names", () => {
    expect(core.safeFileName("../a/b\\c.txt")).toBe("_a_b_c.txt");
    expect(core.safeFileName("\u0001")).toBe("file");
    expect(core.safeFileName(".hidden", "x")).toBe("hidden");
  });

  it("checks uploads: count, size, type, voice", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(core.checkUploads(undefined)).toEqual([]);
    expect(core.checkUploads([{ name: "a.png", type: "image/png", data }])).toEqual([{ name: "a.png", type: "image/png", data }]);
    expect(core.checkUploads([{ name: "x", type: "bad type", data }])[0]?.type).toBe("application/octet-stream");
    expect(() => core.checkUploads([{ name: "e", type: "text/plain", data: new Uint8Array() }])).toThrow("e is empty");
    expect(() => core.checkUploads(Array.from({ length: 11 }, () => ({ name: "a", type: "text/plain", data })))).toThrow("At most 10");
    expect(() => core.checkUploads([{ name: "big", type: "text/plain", data: new Uint8Array(core.MAX_UPLOAD + 1) }])).toThrow("10 MB");
    const v = core.checkUploads([{ name: "voice-message.ogg", type: "audio/ogg", data, voice: { duration: 3.14159, waveform: "AAEC" } }]);
    expect(v[0]?.voice).toEqual({ duration: 3.14, waveform: "AAEC" });
    expect(() => core.checkUploads([{ name: "v", type: "audio/ogg", data, voice: { duration: 0, waveform: "" } }])).toThrow("Invalid voice message");
  });

  it("downloads Discord's CDN only, under a stable name", () => {
    expect(core.isAttachmentUrl("https://cdn.discordapp.com/attachments/1/2/a.png")).toBe(true);
    expect(core.isAttachmentUrl("https://media.discordapp.net/attachments/1/2/a.png")).toBe(true);
    expect(core.isAttachmentUrl("http://cdn.discordapp.com/a")).toBe(false);
    expect(core.isAttachmentUrl("https://evil.example/a")).toBe(false);
    expect(core.isAttachmentUrl("http://127.0.0.1:9/a", "127.0.0.1:9")).toBe(true);
    expect(core.isAttachmentUrl("not a url")).toBe(false);
    expect(core.attachmentFileName("https://cdn.discordapp.com/attachments/1/222/photo.png?ex=1", null)).toBe("222-photo.png");
    expect(core.attachmentFileName("https://cdn.discordapp.com/attachments/1/222/photo.png", "My file.png")).toBe("222-My file.png");
  });
});

describe("session", () => {
  it("keeps Person Hub's partitions and file names", () => {
    expect(core.partitionOf("stores")).toBe("persist:discord");
    expect(core.partitionOf("spokpay")).toBe("persist:discord-spokpay");
    expect(core.partitionOf("creators-discord-1a2b")).toBe("persist:conn-creators-discord-1a2b");
    expect(core.partitionFolder("spokpay")).toBe("discord-spokpay");
    expect(core.discordFiles("stores").cache).toBe("discord-cache.json");
    expect(core.discordFiles("spokpay").cache).toBe("discord-cache-spokpay.json");
    expect(core.discordFiles("x1").cache).toBe("discord-cache-x1.json");
  });

});
