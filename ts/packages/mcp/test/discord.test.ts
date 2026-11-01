import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decode, fromDiscord, notes } from "../src/discord.ts";
import { sandbox } from "./discordkit.ts";

let box: ReturnType<typeof sandbox>;
beforeAll(() => {
  box = sandbox();
});
afterAll(() => box.restore());

test("base64 comes back the same", () => {
  for (const data of [Buffer.from(""), Buffer.from("a"), Buffer.from("ab"), Buffer.from("abc"), Buffer.from("abcd"), Buffer.from([0, 255, 16, 128, 7])]) {
    expect(decode(data.toString("base64"))?.equals(data)).toBe(true);
  }
  expect(decode("a*b=")).toBeUndefined();
});

test("attachments only come from Discord", () => {
  expect(fromDiscord("https://cdn.discordapp.com/attachments/1/2/a.png")).toBe(true);
  expect(fromDiscord("https://media.discordapp.net/attachments/1/2/a.png")).toBe(true);
  expect(fromDiscord("http://cdn.discordapp.com/a.png")).toBe(false);
  expect(fromDiscord("https://cdn.discordapp.com.example.org/a.png")).toBe(false);
  expect(fromDiscord("file:///etc/passwd")).toBe(false);
});

test("notes save, recall by id and forget", () => {
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

test("low-level tools aren't on the agents' list", () => {
  const t: unknown = JSON.parse(readFileSync(join(import.meta.dir, "../../../../discord/tools.json"), "utf8"));
  const names = (t as { name: string }[]).map((x) => x.name);
  for (const gone of ["discord_eval", "discord_click", "discord_key", "discord_query", "discord_findModule", "discord_config", "discord_wait", "discord_console", "discord_reload"]) {
    expect(names).not.toContain(gone);
  }
  expect(names).toContain("discord_send");
  expect(names).toContain("discord_waitForMessage");
});
