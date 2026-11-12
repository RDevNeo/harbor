// Folders moved for real (renamed project, moved Projects folder, moved worktree, project in the
// Trash) under a temporary home, with real Git checkouts and worktrees: Harbor follows each.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Chat, Store } from "../packages/store/src/index.ts";
import { Engine, foldermove as fm, movechat, worktree as wt } from "../packages/agents/src/index.ts";
import { FolderTracker } from "../foldertrack.ts";

setDefaultTimeout(30_000);

const base = mkdtempSync(join(tmpdir(), "hts-foldertrack-"));
const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
beforeAll(() => {
  process.env.XDG_STATE_HOME = join(base, "state");
  process.env.XDG_DATA_HOME = join(base, "data");
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function chat(store: Store, repoId: number | null, over: Partial<Chat> = {}): Chat {
  return store.createChat({
    id: 0,
    repoId,
    title: "t",
    sessionId: crypto.randomUUID(),
    started: true,
    account: "claude",
    model: "",
    effort: "",
    access: "full",
    settled: false,
    updated: 0,
    role: "lead",
    parent: null,
    name: "lead",
    device: "",
    gid: "",
    home: "",
    homeId: 0,
    retired: false,
    ...over,
  });
}

let n = 0;
/** A home with ~/Projects/app (a checkout with a worktree under .worktrees), ~/Projects/notes (a plain folder) and a chats folder, all known to Harbor. */
function setup() {
  const home = join(base, `home${n++}`);
  const projects = join(home, "Projects");
  const app = join(projects, "app");
  const notes = join(projects, "notes");
  mkdirSync(app, { recursive: true });
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "todo.md"), "x");
  git(app, "init", "-q", "-b", "main");
  writeFileSync(join(app, "README.md"), "app");
  git(app, "add", ".");
  git(app, "commit", "-qm", "first");
  const wt = join(projects, ".worktrees", "app-fix");
  git(app, "worktree", "add", "-q", "-b", "fix", wt);
  mkdirSync(join(projects, "chats"));
  const store = Store.openTemp();
  store.set("projects_dir", projects);
  const appId = store.addRepo(app);
  const notesId = store.addRepo(notes);
  const inApp = chat(store, appId);
  const inWt = chat(store, appId);
  store.set(`worktree:${inWt.id}`, wt);
  const inNotes = chat(store, notesId);
  const loose = chat(store, null);
  store.set(`chat_dir:${loose.id}`, join(projects, "chats"));
  store.set(`untrusted:${app}`, "1");
  const e = new Engine({ store, accounts: () => [], changed: () => {} });
  e.reload();
  const cfg = join(home, ".claude");
  const t = new FolderTracker({ store, engine: () => e, touch: () => {}, home, configs: () => [cfg], limits: { dirs: 5000, depth: 5, ms: 10_000 } });
  return { home, projects, app, notes, wt, store, e, t, cfg, appId, notesId, inApp, inWt, inNotes, loose };
}

const notices = (e: Engine, id: number): string[] => e.transcript(id).items.flatMap((i) => (i.kind === "notice" ? [i.text] : []));
const repoPath = (s: Store, id: number): string | undefined => s.repos().find((r) => r.id === id)?.path;

test("a renamed project: its row, chats, worktree links, Claude sessions and folder-named settings follow", async () => {
  const x = setup();
  expect(await x.t.check()).toEqual([]);
  // Claude's sessions of the checkout, kept by its path.
  const sessions = movechat.sessionDir(x.cfg, x.app);
  mkdirSync(join(sessions, "memory"), { recursive: true });
  writeFileSync(join(sessions, `${x.inApp.sessionId}.jsonl`), "{}\n");
  const app2 = join(x.projects, "app-renamed");
  renameSync(x.app, app2);
  const moved = await x.t.check();
  expect(moved).toEqual([{ from: x.app, to: app2, kind: "project" }]);
  expect(repoPath(x.store, x.appId)).toBe(app2);
  expect(x.e.chatCwd(x.e.chat(x.inApp.id) as Chat)).toBe(app2);
  expect(x.store.get(`untrusted:${app2}`)).toBe("1");
  expect(x.store.get(`untrusted:${x.app}`)).toBeNull();
  expect(JSON.parse(x.store.get(`path_was:${x.appId}`) ?? "[]")).toEqual([x.app]);
  // The worktree's link back to its checkout, repaired.
  expect(git(x.wt, "rev-parse", "--git-common-dir").trim()).toBe(join(app2, ".git"));
  expect(git(app2, "worktree", "list")).toContain(x.wt);
  expect(existsSync(join(movechat.sessionDir(x.cfg, app2), `${x.inApp.sessionId}.jsonl`))).toBe(true);
  expect(notices(x.e, x.inApp.id)).toEqual([`Project moved to ${wt.tilde(app2)}`]);
  expect(x.store.get(`worktree_note:${x.inApp.id}`)).toContain(app2);
  // The worktree's own chat runs where it did: no notice.
  expect(notices(x.e, x.inWt.id)).toEqual([]);
  expect(await x.t.check()).toEqual([]);
});

test("the whole Projects folder moved: the setting, every project, worktree and chats folder follow it", async () => {
  const x = setup();
  await x.t.check();
  const to = join(x.home, "Documents", "harbor-projects");
  mkdirSync(join(x.home, "Documents"));
  renameSync(x.projects, to);
  const moved = await x.t.check();
  expect(moved).toEqual([{ from: x.projects, to, kind: "projects" }]);
  expect(x.store.get("projects_dir")).toBe(to);
  expect(repoPath(x.store, x.appId)).toBe(join(to, "app"));
  expect(repoPath(x.store, x.notesId)).toBe(join(to, "notes"));
  expect(x.store.get(`worktree:${x.inWt.id}`)).toBe(join(to, ".worktrees", "app-fix"));
  expect(x.store.get(`chat_dir:${x.loose.id}`)).toBe(join(to, "chats"));
  expect(x.e.chatCwd(x.e.chat(x.loose.id) as Chat)).toBe(join(to, "chats"));
  // Both ends of the worktree's link moved: repaired both ways.
  expect(git(join(to, ".worktrees", "app-fix"), "status", "--short")).toBe("");
  expect(git(join(to, "app"), "worktree", "list")).toContain(join(to, ".worktrees", "app-fix"));
  expect(notices(x.e, x.inWt.id)).toEqual([`Worktree moved to ${wt.tilde(join(to, ".worktrees", "app-fix"))}`]);
  expect(notices(x.e, x.inNotes.id)).toEqual([`Project moved to ${wt.tilde(join(to, "notes"))}`]);
  expect(notices(x.e, x.loose.id)).toEqual([`Folder moved to ${wt.tilde(join(to, "chats"))}`]);
});

test("a worktree moved on its own: the chat follows it and its checkout knows where it is", async () => {
  const x = setup();
  await x.t.check();
  const to = join(x.home, "elsewhere", "fix-moved");
  mkdirSync(join(x.home, "elsewhere"));
  renameSync(x.wt, to);
  expect(await x.t.check()).toEqual([{ from: x.wt, to, kind: "worktree" }]);
  expect(x.e.chatCwd(x.e.chat(x.inWt.id) as Chat)).toBe(to);
  expect(git(x.app, "worktree", "list")).toContain(to);
  expect(git(to, "status", "--short")).toBe("");
});

test("a project in the Trash is gone, not followed, and its chat says where it is; restored, it's found again", async () => {
  const x = setup();
  await x.t.check();
  const trash = fm.trashDir(x.home);
  mkdirSync(join(trash, "info"), { recursive: true });
  mkdirSync(join(trash, "files"), { recursive: true });
  renameSync(x.notes, join(trash, "files", "notes"));
  writeFileSync(join(trash, "info", "notes.trashinfo"), `[Trash Info]\nPath=${encodeURI(x.notes)}\nDeletionDate=2026-11-11T10:00:00\n`);
  expect(await x.t.check(true)).toEqual([]);
  expect(repoPath(x.store, x.notesId)).toBe(x.notes);
  expect(x.t.goneLine(x.e.chat(x.inNotes.id) as Chat)).toContain("is in the Trash");
  // Restored somewhere else: found there.
  const back = join(x.home, "restored-notes");
  renameSync(join(trash, "files", "notes"), back);
  rmSync(join(trash, "info", "notes.trashinfo"));
  expect(await x.t.check(true)).toEqual([{ from: x.notes, to: back, kind: "project" }]);
  expect(x.t.goneLine(x.e.chat(x.inNotes.id) as Chat)).toBeNull();
});

test("a turn in a folder that moved waits for it to be found, then starts there", async () => {
  const x = setup();
  await x.t.check();
  const started: [number, string][] = [];
  x.e.startTurn = (id: number, prompt: string) => void started.push([id, prompt]);
  const to = join(x.projects, "app-v2");
  renameSync(x.app, to);
  const c = x.e.chat(x.inApp.id) as Chat;
  expect(x.t.hold(c, "go on", [])).toBe(true);
  for (let i = 0; i < 200 && started.length === 0; i++) await Bun.sleep(20);
  expect(started).toEqual([[x.inApp.id, "go on"]]);
  expect(x.e.chatCwd(x.e.chat(x.inApp.id) as Chat)).toBe(to);
  // A folder really deleted: looked for once, then the turn's usual error.
  rmSync(x.notes, { recursive: true });
  const nc = x.e.chat(x.inNotes.id) as Chat;
  expect(x.t.hold(nc, "hi", [])).toBe(true);
  for (let i = 0; i < 200 && started.length === 1; i++) await Bun.sleep(20);
  expect(started.at(-1)).toEqual([x.inNotes.id, "hi"]);
  expect(x.t.hold(nc, "hi", [])).toBe(false);
  // A folder Harbor never saw: not held.
  expect(x.t.hold(x.e.chat(x.loose.id) as Chat, "x", [])).toBe(false);
});

test("a chat without a project runs in the Projects folder's chats folder once one is chosen; older ones stay home", () => {
  const home = join(base, `home${n++}`);
  mkdirSync(join(home, "P"), { recursive: true });
  const store = Store.openTemp();
  const e = new Engine({ store, accounts: () => [], changed: () => {} });
  const old = chat(store, null);
  const fresh = chat(store, null, { started: false });
  e.reload();
  const h = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(e.chatCwd(e.chat(old.id) as Chat)).toBe(home);
    expect(e.chatCwd(e.chat(fresh.id) as Chat)).toBe(home);
    store.set("projects_dir", join(home, "P"));
    expect(e.chatCwd(e.chat(old.id) as Chat)).toBe(home);
    expect(e.chatCwd(e.chat(fresh.id) as Chat)).toBe(join(home, "P", "chats"));
  } finally {
    if (h === undefined) delete process.env.HOME;
    else process.env.HOME = h;
  }
});
