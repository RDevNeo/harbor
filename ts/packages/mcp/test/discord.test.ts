// The `discord` app: its tool list, which calls go to Hub (a stand-in for the control socket's route) and which it
// answers itself (the notebook, an attachment's bytes from Discord's CDN), and the card's line from Persons.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type HubCall, call, cardLine, decode, fromDiscord, notes, phoneInfo, provide, sendFiles, serve, tools, available, signedIn, accountName } from "../src/discord.ts";
import type { Json } from "../src/discordjson.ts";

const dir = mkdtempSync(join(tmpdir(), "discord-app-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOOL_NAMES = [
  "discord_status", "discord_view", "discord_screenshot", "discord_notes", "discord_onboarding", "discord_open", "discord_dms", "discord_send", "discord_history", "discord_search",
  "discord_user_messages", "discord_stats", "discord_react", "discord_edit", "discord_delete", "discord_pins", "discord_threads", "discord_find_user", "discord_member", "discord_resolveMessage",
  "discord_attachment", "discord_dm_open", "discord_emoji", "discord_unread", "discord_ack", "discord_guilds", "discord_mute_guild", "discord_organize", "discord_leave", "discord_join", "discord_waitForMessage",
];

const textOf = (r: Json): string => ((r as { content: { text?: string }[] }).content.find((c) => c.text !== undefined)?.text ?? "");

test("the same 31 tools as before, with no page or browser left in their descriptions", () => {
  const list = tools() as { name: string; description: string; inputSchema: { type: string } }[];
  expect(list.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  for (const t of list) {
    expect(t.inputSchema.type).toBe("object");
    expect(t.description).not.toMatch(/Vencord|webpack|MessageStore|Harbor/);
  }
  expect(list.find((t) => t.name === "discord_screenshot")?.description).toContain("has no page or screen");
});

test("the server answers initialize, tools/list, tools/call and ping", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  output.on("data", (d: Buffer) => {
    for (const l of d.toString().split("\n")) if (l.trim()) lines.push(JSON.parse(l));
  });
  const done = serve(input, output, async (name) => ({ content: [{ type: "text", text: `ran ${name}` }], isError: false }));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "discord_dms", arguments: {} } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "nope" })}\n`);
  await Bun.sleep(20);
  input.end();
  await done;
  const byId = new Map(lines.map((l) => [l.id, l]));
  expect((byId.get(1)?.result as { serverInfo: { name: string }; instructions: string }).serverInfo.name).toBe("discord");
  expect(((byId.get(2)?.result as { tools: unknown[] }).tools).length).toBe(31);
  expect(textOf(byId.get(3)?.result as Json)).toBe("ran discord_dms");
  expect(byId.get(4)?.result).toEqual({});
  expect((byId.get(5)?.error as { code: number }).code).toBe(-32601);
});

test("tool calls go to Hub's route; objects come back as sorted JSON, errors as errors", async () => {
  const seen: [string, Json, number][] = [];
  const hub: HubCall = async (tool, args, waitMs) => {
    seen.push([tool, args, waitMs]);
    if (tool === "discord_dms") return { status: 200, body: { json: { total: 1, dms: [{ name: "Ana", channelId: "2" }] } } };
    if (tool === "discord_status") return { status: 200, body: { text: "Signed in as me" } };
    if (tool === "discord_view") return { status: 200, body: { error: "No channel is open in this chat" } };
    return { status: 503, body: { error: "Persons is starting" } };
  };
  expect(textOf(await call("discord_dms", { query: "ana" }, hub))).toBe(JSON.stringify({ dms: [{ channelId: "2", name: "Ana" }], total: 1 }, null, 2));
  expect(textOf(await call("discord_status", {}, hub))).toBe("Signed in as me");
  const v = (await call("discord_view", {}, hub)) as { isError: boolean };
  expect(v.isError).toBe(true);
  expect(textOf(v as unknown as Json)).toBe("No channel is open in this chat");
  expect(textOf(await call("discord_pins", {}, hub))).toBe("Persons is starting");
  expect(textOf(await call("discord_pins", {}, async () => null))).toContain("Hub isn't running");
  expect(seen[0]?.[0]).toBe("discord_dms");
  expect((await call("discord_waitForMessage", { timeoutMs: 600000 }, async (_t, _a, w) => ({ status: 200, body: { json: { wait: w } } })))).toBeTruthy();
  expect(seen.length).toBe(4);
});

test("send reads its files here and sends their bytes to Hub", async () => {
  const f = join(dir, "pic.png");
  writeFileSync(f, "png!");
  let got: Json = null;
  const r = await call("discord_send", { channelId: "1", files: [f] }, async (_t, a) => ((got = a), { status: 200, body: { json: { ok: true } } }));
  expect(textOf(r)).toContain('"ok": true');
  expect(got).toMatchObject({ channelId: "1", files: [{ name: "pic.png", mime: "image/png", base64: Buffer.from("png!").toString("base64") }] });
  expect(() => sendFiles({ channelId: "1" })).toThrow("Provide `content` and/or `files`");
  expect(textOf(await call("discord_send", { content: "x", files: [join(dir, "missing")] }, async () => null))).toContain("Failed to read file");
});

test("an attachment's bytes come from Discord's CDN only; an image goes to the model as an image", async () => {
  const meta = (url: string, size = 4): HubCall => async () => ({ status: 200, body: { json: { name: "a.png", url, size, contentType: "image/png" } } });
  const cdn = (async () => new Response("abcd")) as unknown as typeof fetch;
  const ok = (await call("discord_attachment", { messageId: "1" }, meta("https://cdn.discordapp.com/attachments/1/2/a.png"), cdn)) as { content: { type: string; data?: string }[] };
  expect(ok.content[0]).toEqual({ type: "image", data: Buffer.from("abcd").toString("base64"), mimeType: "image/png" } as never);
  expect(textOf(await call("discord_attachment", { messageId: "1" }, meta("https://evil.example/a.png"), cdn))).toContain("isn't on Discord's CDN");
  expect(textOf(await call("discord_attachment", { messageId: "1", maxBytes: 2 }, meta("https://cdn.discordapp.com/a.png", 10), cdn))).toContain("> maxBytes 2");
});

test("notes save, recall by id and forget", () => {
  const p = join(dir, "notes.json");
  expect(notes(p, { action: "recall" })).toContain("no saved notes");
  notes(p, { action: "save", key: "friend:ana", value: "likes tea", topic: "friends", userId: "1" });
  notes(p, { action: "save", key: "group:x", value: "main", channelId: "2" });
  expect(() => notes(p, { action: "save", value: "v" })).toThrow();
  expect(notes(p, { action: "recall" })).toContain("friends");
  expect(notes(p, { action: "recall", userId: "1" })).toContain("likes tea");
  expect(notes(p, { action: "recall", userId: "1" })).not.toContain("group:x");
  notes(p, { action: "forget", key: "group:x" });
  expect(() => notes(p, { action: "forget", key: "group:x" })).toThrow();
  expect(existsSync(p) && readFileSync(p, "utf8")).not.toContain("group:x");
});

test("base64 and Discord's URLs", () => {
  expect(decode(Buffer.from("ab").toString("base64"))?.toString()).toBe("ab");
  expect(decode("a*b=")).toBeUndefined();
  expect(fromDiscord("https://media.discordapp.net/x")).toBe(true);
  expect(fromDiscord("https://cdn.discordapp.com.example.org/a.png")).toBe(false);
});

test("the card and the phone read the Persons connection Persons provides", async () => {
  provide(null);
  expect([available(), signedIn(), accountName()]).toEqual([false, false, undefined]);
  let status = "connected";
  const calls: string[] = [];
  provide({
    info: () => ({ connection: "stores", label: "Stores Discord", status, account: status === "connected" ? { id: "1", name: "Ana", username: "ana" } : null, error: null, qr: status === "signing-in" ? "https://discord.com/ra/x" : null }),
    signIn: async () => void calls.push("signIn"),
    cancel: async () => void calls.push("cancel"),
    signOut: async () => void calls.push("signOut"),
  });
  expect([available(), signedIn(), accountName()]).toEqual([true, true, "Ana"]);
  expect(phoneInfo("About")).toMatchObject({ account: { name: "Ana", username: "ana" }, captcha: null, card: { text: "Signed in as Ana (Persons › Stores Discord)", tone: 0 } });
  status = "signing-in";
  expect(phoneInfo("About")).toMatchObject({ account: null, signin: { active: true, qr: "https://discord.com/ra/x" } });
  status = "signed-out";
  expect([available(), signedIn()]).toEqual([true, false]);
  expect(cardLine({ connection: null, label: null, status: "signed-out", account: null, error: null, qr: null }, "About")).toEqual({ text: "About", tone: 0 });
  provide(null);
});
