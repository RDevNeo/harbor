import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Item, Store, blankChat, itemJson, parseItem } from "../src/index.ts";

const SOURCE = join(process.env.HOME ?? "", ".cache/hts/tmp/harbor-copy.db");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function synthetic(path: string): void {
  const s = Store.openAt(path);
  const repo = s.addRepo("/work/proj");
  const items: Item[] = [
    { kind: "user", text: "héllo \"quoted\" \\ \n tab\t", files: ["/a.png"], at: 5, mentions: [{ item: 1, from: "me", at: 2, text: "t", len: 1, excerpt: true, note: "n", kind: "chat", chat: "g", title: "T" }], sender: "phone", intent: "steer" },
    { kind: "text", text: "reply", at: 6 },
    { kind: "thinking", text: "hm" },
    { kind: "tool", id: "t1", name: "Bash", summary: "ls", input: "{}", result: null, is_error: false },
    { kind: "tool", id: "t2", name: "Bash", summary: "", input: "{}", result: "out", is_error: true },
    { kind: "result", cost_usd: 0.1849, duration_ms: 12, turns: 2, input_tokens: 100, output_tokens: 5, cached: 3, at: 7, account: "claude", model: "m" },
    { kind: "result", cost_usd: 2, duration_ms: 1, turns: 1, input_tokens: 1, output_tokens: 1, cached: 0, at: 8, account: "", model: "" },
    { kind: "error", text: "boom" },
    { kind: "notice", icon: "clock", text: "wait", detail: "" },
    { kind: "message", from: "a", to: "b", text: "hi" },
  ];
  for (let i = 0; i < 3; i++) {
    const c = s.createChat(blankChat({ repoId: repo, title: `chat ${i}`, role: i === 0 ? "lead" : "chat" }));
    s.saveItems(c.id, items);
  }
  s.addTimer(1, 10, "wake");
  s.addLimitTimer(1, 11, "{}");
  s.addWebhook(repo, "ci", "tok", "d");
  s.setQuiet("theme", "dark");
  s.close();
}

function database(): string {
  const dir = mkdtempSync(join(tmpdir(), "hstore-real-"));
  dirs.push(dir);
  const path = join(dir, "harbor.db");
  if (existsSync(SOURCE)) copyFileSync(SOURCE, path);
  else synthetic(path);
  return path;
}

test("opens a copy of a real harbor.db and reads every table", () => {
  const s = Store.openAt(database());
  const repos = s.repos();
  const chats = s.chats();
  expect(repos.length).toBeGreaterThan(0);
  expect(chats.length).toBeGreaterThan(0);
  let items = 0;
  for (const c of chats) items += s.items(c.id).length;
  const rows = (s.db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
  expect(items).toBeLessThanOrEqual(rows);
  expect(items).toBeGreaterThan(0);
  expect(s.results().length).toBeGreaterThan(0);
  s.timers();
  s.limitTimers();
  s.procs();
  s.webhooks();
  s.mainChats();
  s.withPrefix("");
  s.close();
});

test("every stored item serialises back to the same bytes", () => {
  const s = Store.openAt(database());
  const rows = s.db.query("SELECT body FROM items").all() as { body: string }[];
  expect(rows.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const r of rows) {
    const it = parseItem(r.body);
    if (!it || (itemJson(it) !== r.body && !(it.kind === "result" && !r.body.includes('"cached"')))) bad.push(r.body.slice(0, 200));
  }
  expect(bad.slice(0, 5)).toEqual([]);
  s.close();
});
