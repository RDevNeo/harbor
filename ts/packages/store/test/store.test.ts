import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Item, Store, blankChat, digest, f64Json, itemJson, parseItem, repoDir } from "../src/index.ts";

const dirs: string[] = [];
const stores: Store[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "hstore-"));
  dirs.push(d);
  return d;
}

function open(path: string): Store {
  const s = Store.openAt(path);
  stores.push(s);
  return s;
}

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const text = (s: string): Item => ({ kind: "text", text: s, at: 1 });
const texts = (store: Store, chat: number): string[] => store.items(chat).map((it) => (it.kind === "text" ? it.text : ""));

test("removing_a_repo_drops_its_webhooks", () => {
  const dir = tmp();
  const s = open(join(dir, "harbor.db"));
  const repo = s.addRepo(dir);
  s.addWebhook(repo, "ci", "tok", "");
  expect(s.webhooks().length).toBe(1);
  s.removeRepo(repo);
  expect(s.webhooks()).toEqual([]);
});

test("a_shared_projects_folder_is_kept_per_pc", () => {
  const dir = tmp();
  const s = open(join(dir, "harbor.db"));
  const owner = "/home/owner/Documents/proj";
  const id = s.addRepo(owner);
  let r = s.repos()[0];
  expect([r?.remote, r?.local, r && repoDir(r)]).toEqual(["", null, owner]);
  s.setRepoRemote(id, "git@github.com:o/proj.git");
  s.setRepoLocal(id, dir);
  r = s.repos()[0];
  expect(r?.path).toBe(owner);
  expect([r?.remote, r && repoDir(r)]).toEqual(["git@github.com:o/proj.git", dir]);
  s.setRepoLocal(id, null);
  const back = s.repos()[0];
  expect(back && repoDir(back)).toBe(owner);
});

test("settled_projects_come_back", () => {
  const dir = tmp();
  const path = join(dir, "harbor.db");
  const s = open(path);
  const repo = s.addRepo(dir);
  s.db.exec("UPDATE repos SET settled=1; PRAGMA user_version=6;");
  s.close();
  const again = open(path);
  const row = again.db.query("SELECT settled FROM repos WHERE id=?1").get(repo) as { settled: number };
  expect(row.settled).toBe(0);
  expect(again.repos().length).toBe(1);
});

test("saves_only_what_changed", () => {
  const dir = tmp();
  const path = join(dir, "harbor.db");
  const s = open(path);
  const repo = s.addRepo(dir);
  const chat = (st: Store) => st.createChat(blankChat({ repoId: repo, title: "t" })).id;
  const a = chat(s);
  const items = ["one", "two", "three"].map(text);
  s.saveItems(a, items);
  expect(texts(s, a)).toEqual(["one", "two", "three"]);
  items[1] = text("TWO");
  items.push(text("four"));
  s.saveItems(a, items);
  expect(texts(s, a)).toEqual(["one", "TWO", "three", "four"]);
  // Shorter (undo): the rest goes, also for a store that hasn't saved this chat yet.
  const fresh = open(path);
  fresh.saveItems(a, items.slice(0, 2));
  expect(texts(fresh, a)).toEqual(["one", "TWO"]);
  // A deleted chat's id, reused, doesn't count as saved.
  fresh.deleteChat(a);
  const b = chat(fresh);
  fresh.saveItems(b, items.slice(0, 1));
  expect(texts(fresh, b)).toEqual(["one"]);
});

test("a_deleted_main_chat_is_forgotten", () => {
  const dir = tmp();
  const path = join(dir, "harbor.db");
  let s = open(path);
  const repo = s.addRepo(dir);
  const chat = (st: Store) => st.createChat(blankChat({ repoId: repo, title: "t", role: "lead" })).id;
  expect(s.mainChats().size).toBe(0);
  const a = chat(s);
  s.setMainChat(repo, a);
  expect(s.mainChats()).toEqual(new Map([[repo, a]]));
  // Kept across a restart (and the column isn't added twice).
  s.close();
  s = open(path);
  expect(s.mainChats().get(repo)).toBe(a);
  // Deleted, its id may come back for a new chat: that one isn't main.
  s.deleteChat(a);
  expect(s.mainChats().size).toBe(0);
  const b = chat(s);
  expect(b).toBe(a);
  expect(s.mainChats().size).toBe(0);
  s.setMainChat(repo, b);
  s.setMainChat(repo, null);
  expect(s.mainChats().size).toBe(0);
});

test("a_retired_agent_stays_retired", () => {
  const path = join(tmp(), "harbor.db");
  let s = open(path);
  const c = s.createChat(blankChat({ title: "t", role: "sub", parent: 1, name: "tests" }));
  s.saveItems(c.id, [text("its report")]);
  expect(s.chats()[0]?.retired).toBe(false);
  c.retired = true;
  s.saveChat(c);
  s.close();
  s = open(path);
  expect(s.chats()[0]?.retired).toBe(true);
  expect(texts(s, c.id)).toEqual(["its report"]);
});

test("a_database_from_before_retiring_gets_the_column", () => {
  const path = join(tmp(), "harbor.db");
  let s = open(path);
  const c = s.createChat(blankChat({ title: "t", role: "sub", parent: 1, name: "tests" }));
  s.db.exec("ALTER TABLE chats DROP COLUMN retired;");
  s.close();
  s = open(path);
  expect(s.chats().find((x) => x.id === c.id)?.retired).toBe(false);
});

test("chats_have_global_ids_and_copies_keep_theirs", () => {
  const s = open(join(tmp(), "harbor.db"));
  const mk = (gid: string, home: string, homeId: number, updated: number) => blankChat({ title: "t", role: "lead", gid, home, homeId, updated });
  const own = s.createChat(mk("", "", 0, 5));
  expect(own.gid.length).toBe(36);
  expect(own.updated).toBeGreaterThan(5);
  const copy = s.createChat(mk("abc", "ts:desk", 7, 5));
  expect([copy.gid, copy.updated]).toEqual(["abc", 5]);
  const back = s.chats();
  const c = back.find((x) => x.id === copy.id);
  expect(c?.home === "ts:desk" && c.homeId === 7).toBe(true);
  expect(back.find((x) => x.id === own.id)?.home).toBe("");
  // The same items digest the same, wherever they are.
  const items: Item[] = [{ kind: "text", text: "a", at: 1 }, { kind: "error", text: "b" }];
  expect(digest(items)).toBe(digest([...items]));
  expect(digest(items)).not.toBe(digest(items.slice(0, 1)));
});

test("kv settings keep their values and prefixes", () => {
  const s = open(join(tmp(), "harbor.db"));
  expect(s.get("theme")).toBeNull();
  s.setQuiet("theme", "dark");
  s.setQuiet("worktree:1", "a");
  s.setQuiet("worktree:2", "");
  s.setQuiet("other", "x");
  expect(s.get("theme")).toBe("dark");
  expect(s.withPrefix("worktree:")).toEqual([["worktree:1", "a"]]);
});

test("timers, processes and limit timers round trip", () => {
  const s = open(join(tmp(), "harbor.db"));
  const c = s.createChat(blankChat({ title: "t" }));
  const t = s.addTimer(c.id, 10, "wake up");
  s.addLimitTimer(c.id, 5, "{}");
  expect(s.timers()).toEqual([{ id: t, chatId: c.id, at: 10, reason: "wake up" }]);
  expect(s.limitTimers().length).toBe(1);
  s.deleteTimer(t);
  expect(s.timers()).toEqual([]);
  const p = { lead: 1, repoId: null, owner: 1, name: "dev", cmd: "bun dev", cwd: "/x", pid: 42, startTicks: 7, log: "/l", url: null };
  const id = s.addProc(p);
  s.setProcUrl(id, "http://localhost:1");
  expect(s.procs()).toEqual([{ ...p, id, url: "http://localhost:1" }]);
  s.deleteProc(id);
  expect(s.procs()).toEqual([]);
});

test("items are written as serde_json writes them", () => {
  const result: Item = { kind: "result", cost_usd: 0.1, duration_ms: 5, turns: 1, input_tokens: 2, output_tokens: 3, cached: 0, at: 9, account: "claude", model: "m" };
  expect(itemJson(result)).toBe('{"kind":"result","cost_usd":0.1,"duration_ms":5,"turns":1,"input_tokens":2,"output_tokens":3,"cached":0,"at":9,"account":"claude","model":"m"}');
  expect(itemJson({ ...result, cost_usd: 2 } as Item)).toContain('"cost_usd":2.0,');
  expect(itemJson({ kind: "user", text: "hi", files: [], at: 0, mentions: [], sender: "", intent: "" })).toBe('{"kind":"user","text":"hi","files":[],"at":0}');
  expect(parseItem('{"kind":"nope"}')).toBeNull();
  expect(parseItem('{"kind":"tool","id":"1","name":"Bash","input":"{}","is_error":false}')).toEqual({
    kind: "tool", id: "1", name: "Bash", summary: "", input: "{}", result: null, is_error: false,
  });
  expect([0, -0, 1, 1.5, 100, 1e15, 1e16, 1e17, 1e21, 0.001, 1e-5, 1e-6, 123456789.123].map(f64Json)).toEqual([
    "0.0", "-0.0", "1.0", "1.5", "100.0", "1000000000000000.0", "1e16", "1e17", "1e21", "0.001", "0.00001", "1e-6", "123456789.123",
  ]);
});

test("a database from the first schema migrates to the current one", () => {
  const path = join(tmp(), "harbor.db");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE repos(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
    CREATE TABLE chats(id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      title TEXT NOT NULL, session_id TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL, permission_mode TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE items(chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(chat_id, seq));
    CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    INSERT INTO repos(id, path, name) VALUES(1, '/p/a', 'a'), (2, '/p/b', 'B');
    INSERT INTO chats VALUES(1, 1, 'one', 's1', 1, 'opus', 'acceptEdits', 10), (2, 2, 'two', 's2', 0, 'custom', 'plan', 20), (3, 2, 'three', 's3', 0, 'haiku', 'default', 30);
    INSERT INTO items VALUES(1, 0, '{"kind":"text","text":"hi"}');`);
  old.close();
  const s = open(path);
  expect((s.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(8);
  const chats = s.chats();
  expect(chats.map((c) => [c.id, c.model, c.access, c.account, c.role, c.retired])).toEqual([
    [3, "claude-haiku-5-5", "full", "claude", "chat", false],
    [2, "custom", "plan", "claude", "chat", false],
    [1, "claude-opus-5-5", "edits", "claude", "chat", false],
  ]);
  expect(new Set(chats.map((c) => c.gid)).size).toBe(3);
  expect(chats.every((c) => c.gid.length === 36)).toBe(true);
  expect(s.repos().map((r) => [r.name, r.sort])).toEqual([["a", 1], ["B", 2]]);
  expect(texts(s, 1)).toEqual(["hi"]);
  expect(s.mainChats().size).toBe(0);
  s.addWebhook(1, "ci", "t", "d");
  s.close();
  const again = open(path);
  expect(again.chats().length).toBe(3);
  expect(again.webhooks().length).toBe(1);
});

test("a store opens while another process holds the write lock for a moment, as rusqlite's busy wait does", async () => {
  const path = join(tmp(), "harbor.db");
  const holder = Bun.spawn([process.execPath, "-e", `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(path)}); db.exec("PRAGMA journal_mode=WAL"); db.exec("BEGIN IMMEDIATE"); console.log("held"); setTimeout(() => { db.exec("COMMIT"); db.close(); }, 600);`], { stdout: "pipe" });
  const reader = holder.stdout.getReader();
  await reader.read();
  const t0 = Date.now();
  const s = open(path);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  expect(s.repos()).toEqual([]);
  expect(await holder.exited).toBe(0);
});

test("a_settled_project_settles_its_chats_and_unsettle_brings_them_back", () => {
  const dir = tmp();
  const path = join(dir, "harbor.db");
  let s = open(path);
  const repo = s.addRepo(dir);
  const other = s.addRepo(join(dir, "other"));
  const lead = (title: string, r = repo) => s.createChat(blankChat({ repoId: r, title, role: "lead" }));
  const a = lead("a");
  const b = lead("b");
  const before = lead("settled before");
  s.saveChat({ ...before, settled: true });
  const copy = s.createChat(blankChat({ repoId: repo, title: "copy", role: "lead", home: "pc:laptop", homeId: 4 }));
  const elsewhere = lead("elsewhere", other);
  const at = Math.floor(Date.now() / 1000) + 10;
  s.settleProject(repo, true, at);
  expect(s.settledProjects()).toEqual(new Map([[repo, at]]));
  expect([a, b, before, copy, elsewhere].map((c) => s.chat(c.id)?.settled)).toEqual([true, true, true, false, false]);
  // Kept across a restart.
  s.close();
  s = open(path);
  expect(s.settledProjects().get(repo)).toBe(at);
  s.settleProject(repo, false);
  expect(s.settledProjects().size).toBe(0);
  // What the settle settled comes back; a chat settled before stays settled.
  expect([a, b, before].map((c) => s.chat(c.id)?.settled)).toEqual([false, false, true]);
});

test("new_activity_in_a_settled_project_unsettles_it", () => {
  const dir = tmp();
  const s = open(join(dir, "harbor.db"));
  const repo = s.addRepo(dir);
  const a = s.createChat(blankChat({ repoId: repo, title: "a", role: "lead" }));
  const b = s.createChat(blankChat({ repoId: repo, title: "b", role: "lead" }));
  const at = Math.floor(Date.now() / 1000) + 100;
  s.settleProject(repo, true, at);
  // Saved again with no newer time (a rename): still settled.
  const fresh = s.chat(a.id);
  if (!fresh) throw new Error("gone");
  s.saveChat({ ...fresh, title: "renamed" });
  expect(s.settledProjects().has(repo)).toBe(true);
  // A turn in it: the project and that chat come back, the other stays settled.
  const active = { ...fresh, updated: at + 5 };
  s.saveChat(active);
  expect(active.settled).toBe(false);
  expect(s.settledProjects().has(repo)).toBe(false);
  expect(s.chat(a.id)?.settled).toBe(false);
  expect(s.chat(b.id)?.settled).toBe(true);
  // A new chat of this PC in a settled project unsettles it; a copy arriving from another PC doesn't.
  s.settleProject(repo, true, at);
  s.createChat(blankChat({ repoId: repo, title: "copy", role: "lead", home: "pc:laptop", homeId: 9, updated: 1 }));
  expect(s.settledProjects().has(repo)).toBe(true);
  s.createChat(blankChat({ repoId: repo, title: "new", role: "lead" }));
  expect(s.settledProjects().has(repo)).toBe(false);
});

test("notices with an icon are read from every chat, in order, and nothing else", () => {
  const dir = tmp();
  const s = open(join(dir, "harbor.db"));
  const repo = s.addRepo(dir);
  const a = s.createChat(blankChat({ repoId: repo, title: "a" })).id;
  const b = s.createChat(blankChat({ repoId: repo, title: "b" })).id;
  const note = (icon: string, detail: string): Item => ({ kind: "notice", icon, text: "t", detail });
  s.saveItems(a, [text("hi"), note("captcha", "1"), note("users", "x"), note("captcha", "2")]);
  s.saveItems(b, [note("captcha", "3")]);
  expect(s.noticeDetails("captcha")).toEqual([
    [a, "1"],
    [a, "2"],
    [b, "3"],
  ]);
  expect(s.noticeDetails("nothing")).toEqual([]);
});
