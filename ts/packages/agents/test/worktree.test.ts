import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as wt from "../src/worktree.ts";

const base = mkdtempSync(join(tmpdir(), "hts-wt-"));
const saved = { ...wt.timing };
// No hooks of this PC's own (a commit or push hook) in the test repositories.
Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" });
beforeAll(() => Object.assign(wt.timing, { nameWaitMs: 1000 }));
afterAll(() => {
  Object.assign(wt.timing, saved);
  rmSync(base, { recursive: true, force: true });
});

function repo(tag: string): string {
  const d = join(base, tag);
  mkdirSync(d, { recursive: true });
  const g = (...args: string[]): void => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: d, env: process.env, stdout: "ignore", stderr: "pipe" });
    if (!r.success) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`);
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "a");
  g("add", ".");
  g("commit", "-qm", "a");
  g("branch", "feature/login");
  return d;
}

test("ranks branches", () => {
  const b = { local: ["main", "feature/login"], remote: ["origin/main", "origin/fix-ui"] };
  const all = wt.rank(b, "", 10);
  // Remote copies of local branches are left out.
  expect(all.map((r) => r.name)).toEqual(["main", "feature/login", "origin/fix-ui"]);
  expect(all[2]?.remote).toBe(true);
  expect(wt.rank(b, "login", 10)[0]?.name).toBe("feature/login");
  // Letters in order.
  expect(wt.rank(b, "fxu", 10)[0]?.name).toBe("origin/fix-ui");
});

test("switches, creates and cleans up", async () => {
  const d = repo("ops");
  expect((await wt.head(d))?.branch).toBe("main");
  await wt.switchTo(d, "feature/login", false);
  expect((await wt.head(d))?.branch).toBe("feature/login");
  await expect(wt.create(d, "bad name..")).rejects.toThrow();
  await wt.create(d, "wip/one");
  expect((await wt.head(d))?.branch).toBe("wip/one");
  // A worktree from main, then removed (clean), its merged branch with it.
  const root = `${d}.wts`;
  let m = await wt.makeIn(root, d, "main", "", null);
  const h = await wt.head(m.dir);
  expect(h?.branch.startsWith("harbor/")).toBe(true);
  await wt.remove(d, m.dir);
  expect(existsSync(m.dir)).toBe(false);
  expect((await wt.branches(d)).local).not.toContain(h?.branch);
  // Uncommitted changes keep it.
  m = await wt.makeIn(root, d, "", "", null);
  writeFileSync(join(m.dir, "new.txt"), "x");
  await expect(wt.remove(d, m.dir)).rejects.toThrow("1 uncommitted change");
  expect(existsSync(m.dir)).toBe(true);
});

test("a new worktree says its branch and base", async () => {
  const d = repo("made");
  const root = `${d}.wts`;
  // From the checkout's branch (""): that's its base.
  let m = await wt.makeIn(root, d, "", "Fix the login bug", null);
  expect([m.branch, m.base]).toEqual(["harbor/fix-login-bug", "main"]);
  const [text, detail] = wt.madeNotice(m, "Working in a new worktree");
  expect(text).toBe(`Working in a new worktree · ${wt.madeName(m)} on branch harbor/fix-login-bug (from main)`);
  expect(detail).toContain("Branch: harbor/fix-login-bug (from main)");
  m = await wt.makeIn(root, d, "feature/login", "", null);
  expect(m.base).toBe("feature/login");
  // Nothing to name it after: 6 hex.
  expect(m.branch).toMatch(/^harbor\/[0-9a-f]{6}$/);
});

test("Claude names new worktrees", async () => {
  const d = repo("claude");
  const root = `${d}.wts`;
  const proj = wt.projectPart(d);
  const say = (a: string): wt.Namer => async () => wt.cleanName(a);
  // In time: made with Claude's name, folder and branch.
  let m = await wt.makeIn(root, d, "", "Remove this, i only want the worktree here", say("worktree-menu-cleanup"));
  expect([m.branch, wt.madeName(m)]).toEqual(["harbor/worktree-menu-cleanup", `${proj}-worktree-menu-cleanup`]);
  expect(m.late).toBeNull();
  expect(existsSync(join(root, `${proj}-remove-only-want-worktree`))).toBe(false);
  expect((await wt.head(m.dir))?.branch).toBe("harbor/worktree-menu-cleanup");
  expect(await wt.git(d, ["worktree", "list", "--porcelain"])).toContain(`worktree ${m.dir}`);
  // Taken: a number, as for slugs.
  expect((await wt.makeIn(root, d, "", "Something else", say("worktree-menu-cleanup"))).branch).toBe("harbor/worktree-menu-cleanup-2");
  // No answer (offline, no account, nonsense): the slug.
  expect((await wt.makeIn(root, d, "", "Fix the login bug", async () => null)).branch).toBe("harbor/fix-login-bug");
  expect((await wt.makeIn(root, d, "", "Fix the login bug", say("I can't name this: it's not a task."))).branch).toBe("harbor/fix-login-bug-2");
  // Late: the slug now, the answer still to come.
  const slow: wt.Namer = () => new Promise((r) => setTimeout(() => r("late-name"), wt.timing.nameWaitMs + 500));
  const t = Date.now();
  m = await wt.makeIn(root, d, "", "Sidebar chips", slow);
  expect(Date.now() - t).toBeLessThan(wt.timing.nameWaitMs + 400);
  expect(m.branch).toBe("harbor/sidebar-chips");
  expect(await m.late).toBe("late-name");
});

test("Claude's answers are cleaned into names", () => {
  expect(wt.cleanName("inline-chat-mention-links")).toBe("inline-chat-mention-links");
  expect(wt.cleanName("  `Harbor/Fix_Login Redirect`.\n")).toBe("fix-login-redirect");
  expect(wt.cleanName('"dark-mode"\nBecause the user wants…')).toBe("dark-mode");
  expect(wt.cleanName("one-two-three-four-five-six-seven")).toBe("one-two-three-four-five");
  expect((wt.cleanName("averyveryverylongwordthatgoeson-andanotherlongword") ?? "").length).toBeLessThanOrEqual(40);
  // A sentence.
  expect(wt.cleanName("Here is a name for the task you asked for")).toBeNull();
  expect(wt.cleanName("Name: fix-it")).toBeNull();
  expect(wt.cleanName("日本語")).toBeNull();
  expect(wt.cleanName("42")).toBeNull();
  expect(wt.cleanName("")).toBeNull();
});

test("names come from what the chat is about", () => {
  expect(wt.slug("Main thread per project")).toBe("main-thread-per-project");
  expect(wt.slug("Fix the login bug where users get logged out")).toBe("fix-login-bug-users-get");
  expect(wt.slug("\n  Can you make the sidebar's chips blue? https://example.com/x")).toBe("make-sidebars-chips-blue");
  expect(wt.slug("Quero que a migração funcione")).toBe("migracao-funcione");
  // Only filler: kept rather than nothing.
  expect(wt.slug("the and of")).toBe("the-and-of");
  expect(wt.slug("日本語")).toBe("");
  expect(wt.slug("supercalifragilisticexpialidocious and more").length).toBe(32);
  expect(wt.folderPart("harbor/fix-login")).toBe("fix-login");
  expect(wt.folderPart("Feature/A b")).toBe("feature-a-b");
  expect(wt.isNamed("app-fix", "app-fix") && wt.isNamed("app-fix-2", "app-fix") && !wt.isNamed("app-fix-it", "app-fix")).toBe(true);
});

test("named worktrees are unique and their folder follows a rename", async () => {
  const d = repo("names");
  const root = `${d}.wts`;
  const proj = wt.projectPart(d);
  const a = await wt.makeIn(root, d, "", "Main thread per project", null);
  expect([a.branch, wt.madeName(a)]).toEqual(["harbor/main-thread-per-project", `${proj}-main-thread-per-project`]);
  const b = await wt.makeIn(root, d, "", "Main thread per project", null);
  expect([b.branch, wt.madeName(b)]).toEqual(["harbor/main-thread-per-project-2", `${proj}-main-thread-per-project-2`]);
  // A branch only on a remote is taken too.
  await wt.git(d, ["update-ref", "refs/remotes/origin/harbor/sidebar", "HEAD"]);
  expect((await wt.makeIn(root, d, "", "Sidebar", null)).branch).toBe("harbor/sidebar-2");
  // Bad and taken names are refused, plainly.
  await expect(wt.renameBranch(a.dir, "bad..name", false)).rejects.toThrow("isn't a valid branch name");
  await expect(wt.renameBranch(a.dir, "main", false)).rejects.toThrow("already exists");
  const r = await wt.renameBranch(a.dir, " harbor/per-project-lead ", false);
  expect(r).toEqual({ old: "harbor/main-thread-per-project", branch: "harbor/per-project-lead", remote: null });
  expect((await wt.head(a.dir))?.branch).toBe("harbor/per-project-lead");
  // The folder follows: git finds it at its new place, and removes it from there.
  const to = wt.folderFor(d, a.dir, r.branch) ?? "";
  expect(basename(to)).toBe(`${proj}-per-project-lead`);
  wt.moveDir(a.dir, to);
  expect(existsSync(a.dir)).toBe(false);
  expect((await wt.head(to))?.branch).toBe("harbor/per-project-lead");
  expect(await wt.git(d, ["worktree", "list", "--porcelain"])).toContain(`worktree ${to}`);
  // Already named for it.
  expect(wt.folderFor(d, to, r.branch)).toBeNull();
  // A taken folder gets a number.
  expect(basename(wt.folderFor(d, b.dir, "harbor/per-project-lead") ?? "")).toBe(`${proj}-per-project-lead-2`);
  await wt.remove(d, to);
  expect(existsSync(to)).toBe(false);
});

test("a pushed branch is renamed on its remote or let go", async () => {
  const d = repo("push");
  const bare = `${d}.git`;
  expect(Bun.spawnSync(["git", "init", "-q", "--bare", bare]).success).toBe(true);
  await wt.git(d, ["remote", "add", "origin", bare]);
  const root = `${d}.wts`;
  const m = await wt.makeIn(root, d, "", "Push branch", null);
  expect(await wt.pushedAs(m.dir)).toBeNull();
  await wt.git(m.dir, ["push", "-q", "-u", "origin", "harbor/push-branch"]);
  expect(await wt.pushedAs(m.dir)).toBe("origin/harbor/push-branch");
  // Not GitHub: the new name is pushed and tracked; the old one stays there.
  let r = await wt.renameBranch(m.dir, "harbor/pushed", true);
  expect(r.remote?.startsWith("Pushed as origin/harbor/pushed; origin/harbor/push-branch is still there")).toBe(true);
  expect(await wt.pushedAs(m.dir)).toBe("origin/harbor/pushed");
  const there = await wt.git(bare, ["branch", "--format=%(refname:short)"]);
  expect(there).toContain("harbor/pushed");
  expect(there).toContain("harbor/push-branch");
  // Here only: it stops tracking the remote branch, which keeps its name.
  r = await wt.renameBranch(m.dir, "harbor/local-only", false);
  expect(r.remote).toBe("origin/harbor/pushed keeps its name; push again to publish harbor/local-only");
  expect(await wt.pushedAs(m.dir)).toBeNull();
});

test("a folder name is one plain name, not taken", () => {
  const root = join(base, "fname");
  const dir = join(root, "app-fix");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "app-other"));
  const p = (n: string): string | null => wt.folderNameProblem(dir, n);
  expect(p("app-login")).toBeNull();
  // Its own name is fine (nothing moves).
  expect(p(" app-fix ")).toBeNull();
  expect(p("")).toContain("type");
  expect(p("a/b")).toContain("no “/”");
  expect(p("..")).toContain("can't start with “.”");
  expect(p("-x")).toContain("can't start with “-”");
  expect(p("my app")).toContain("no spaces");
  expect(p("app-other")).toContain("already there");
});

test("GitHub remotes and what a rename says", () => {
  expect(wt.githubRepo("git@github.com:o/r.git")).toBe("o/r");
  expect(wt.githubRepo("https://x-token@github.com/o/r/")).toBe("o/r");
  expect(wt.githubRepo("https://gitlab.com/o/r")).toBeNull();
  const renamed = { old: "harbor/a", branch: "harbor/b", remote: "Pushed as origin/harbor/b" };
  expect(wt.renameSaid({ kind: "branch", renamed, folder: "p-b", waits: null })).toBe("Renamed to harbor/b · folder p-b. Pushed as origin/harbor/b");
  expect(wt.renameSaid({ kind: "folder", renamed, folder: "p-b", waits: "a turn runs" })).toBe("The worktree folder is renamed once nothing works in it (a turn runs)");
});
