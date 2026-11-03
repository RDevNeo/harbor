import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { decode, fromDiscord, notes, postNotice, serve, statusText, tools } from "../src/discord.ts";
import * as setup from "../src/discordsetup.ts";
import { sandbox } from "./discordkit.ts";

let box: ReturnType<typeof sandbox>;
beforeAll(() => {
  box = sandbox();
});
afterAll(() => box.restore());

test("base64_comes_back_the_same: base64 comes back the same", () => {
  for (const data of [Buffer.from(""), Buffer.from("a"), Buffer.from("ab"), Buffer.from("abc"), Buffer.from("abcd"), Buffer.from([0, 255, 16, 128, 7])]) {
    expect(decode(data.toString("base64"))?.equals(data)).toBe(true);
  }
  expect(decode("a*b=")).toBeUndefined();
});

test("attachments_only_come_from_discord: attachments only come from Discord", () => {
  expect(fromDiscord("https://cdn.discordapp.com/attachments/1/2/a.png")).toBe(true);
  expect(fromDiscord("https://media.discordapp.net/attachments/1/2/a.png")).toBe(true);
  expect(fromDiscord("http://cdn.discordapp.com/a.png")).toBe(false);
  expect(fromDiscord("https://cdn.discordapp.com.example.org/a.png")).toBe(false);
  expect(fromDiscord("file:///etc/passwd")).toBe(false);
});

test("notes_save_recall_by_id_and_forget: notes save, recall by id and forget", () => {
  const p = join(box.dir, "notes.json");
  rmSync(p, { force: true });
  expect(notes(p, { action: "recall" })).toContain("no saved notes");
  notes(p, { action: "save", key: "friend:ana", value: "likes tea", topic: "friends", userId: "1" });
  notes(p, { action: "save", key: "group:x", value: "main", channelId: "2" });
  expect(() => notes(p, { action: "save", value: "v" })).toThrow();
  const all = notes(p, { action: "recall" });
  expect(all).toContain("friends");
  expect(all).toContain("general");
  expect(notes(p, { action: "recall", userId: "1" })).toContain("likes tea");
  expect(notes(p, { action: "recall", userId: "1" })).not.toContain("group:x");
  expect(notes(p, { action: "recall", channelId: "9" })).toContain("no entries");
  notes(p, { action: "forget", key: "group:x" });
  expect(() => notes(p, { action: "forget", key: "group:x" })).toThrow();
  expect(existsSync(p)).toBe(true);
  expect(readFileSync(p, "utf8")).not.toContain("group:x");
});

test("low_level_tools_arent_on_the_agents_list: low-level tools aren't on the agents' list", () => {
  const t: unknown = JSON.parse(readFileSync(join(import.meta.dir, "../../../../discord/tools.json"), "utf8"));
  const names = (t as { name: string }[]).map((x) => x.name);
  for (const gone of ["discord_eval", "discord_click", "discord_key", "discord_query", "discord_findModule", "discord_config", "discord_wait", "discord_console", "discord_reload"]) {
    expect(names).not.toContain(gone);
  }
  expect(names).toContain("discord_send");
  expect(names).toContain("discord_waitForMessage");
});

test("without its shell, Discord offers discord_status saying why, never an empty tool list", async () => {
  // A build that doesn't know its commit can't fetch the shell (installed ones always do).
  setup.configure({ shellRef: () => undefined });
  const list = (await tools()) as { name: string; description: string }[];
  expect(list.map((t) => t.name)).toEqual(["discord_status"]);
  expect(list[0]?.description).toContain("built from source without its commit");
  expect(await statusText()).toStartWith("Discord's tools aren't available on this PC: This Harbor was built from source");
  // One that does: the download is tried at that commit, and its failure is the reason.
  process.env.HARBOR_DISCORD_SHELL_ORIGIN = "http://127.0.0.1:9";
  setup.configure({ shellRef: () => "0123456789abcdef0123456789abcdef01234567" });
  try {
    expect(await statusText()).toContain("couldn't download its Discord shell (main.js from http://127.0.0.1:9/RDevNeo/harbor/0123456789abcdef0123456789abcdef01234567/discord)");
    expect(readdirSync(setup.root()).filter((n) => n.includes(".tmp"))).toEqual([]);
  } finally {
    delete process.env.HARBOR_DISCORD_SHELL_ORIGIN;
    setup.configure({ shellRef: () => undefined });
  }
});

test("a tool list still coming when the input ends is answered before the server goes", async () => {
  // A slow GitHub: the first list waits for the shell's download.
  const slow = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(400); return new Response("404: Not Found", { status: 404 }); } });
  process.env.HARBOR_DISCORD_SHELL_ORIGIN = `http://127.0.0.1:${slow.port}`;
  setup.configure({ shellRef: () => "0123456789abcdef0123456789abcdef01234567" });
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (d: Buffer) => (out += d.toString()));
    const done = serve(input, output);
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await done;
    const reply = JSON.parse(out.split("\n").find((l) => l.includes('"id":2')) ?? "{}") as { result?: { tools?: { name: string }[] } };
    expect(reply.result?.tools?.map((t) => t.name)).toEqual(["discord_status"]);
  } finally {
    delete process.env.HARBOR_DISCORD_SHELL_ORIGIN;
    setup.configure({ shellRef: () => undefined });
    slow.stop(true);
  }
});

test("a captcha's notices go into its chat as the card and its outcome, and the notification opens that chat", () => {
  const items: [number, string, string, string][] = [];
  const told: unknown[][] = [];
  const sink = {
    chat: (id: number) => (id === 3 ? { id: 3, gid: "pc1:3" } : undefined),
    notice: (id: number, icon: string, text: string, detail: string) => void items.push([id, icon, text, detail]),
    changed: () => {},
    notify: (...a: unknown[]) => void told.push(a),
  };
  postNotice({ kind: "discord", key: "discord-captcha", title: "Discord needs a captcha", body: "b", chat: 3, captcha: { captcha: "ab", state: "pending", guild: "G" }, line: "Discord needs a captcha to join G" }, sink);
  expect(items).toEqual([[3, "captcha", "Discord needs a captcha to join G", '{"captcha":"ab","state":"pending","guild":"G"}']]);
  expect(told[0]).toEqual(["discord", "discord-captcha", "Discord needs a captcha", "b", "pc1:3"]);
  // A chat this PC doesn't have, or none: only the notification, which opens the overlay.
  postNotice({ kind: "discord", key: "discord-captcha", title: "t", body: "b", chat: 9, captcha: { captcha: "cd", state: "pending", guild: null } }, sink);
  expect(items.length).toBe(1);
  expect(told[1]).toEqual(["discord", "discord-captcha", "t", "b"]);
});
