import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { blankChat, type Chat, dataDir, Store } from "../packages/store/src/index.ts";
import { type RunningHub, startHub } from "../hub.ts";

// The lead's checkout tools (checkouttools.ts) through the hub's Engine, on a real repository: the picker's state follows them.

// Windows' git takes ten times as long per command.
if (process.platform === "win32") setDefaultTimeout(90_000);

let root: string;
let h: RunningHub;
let repoId = 0;
let repoDir = "";
let lead: Chat;
const saved = { ...process.env };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const sh = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

function commit(dir: string, file: string, text: string): void {
  writeFileSync(join(dir, file), text);
  sh(dir, "add", file);
  sh(dir, "commit", "-qm", file);
}

const read = (p: string): string => readFileSync(p, "utf8").replaceAll("\r\n", "\n");
const tool = (name: string, args: Record<string, unknown> = {}, who: Chat = lead): Promise<string> => h.engine.tool(who.id, name, args);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hts-checkout-"));
  Object.assign(process.env, {
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "run"),
    HARBOR_SOCK: join(root, "run", "harbor.sock"),
    HARBOR_LISTEN: "127.0.0.1",
    HARBOR_NO_DISCOVERY: "1",
    HARBOR_TEST_NO_SIGNIN: "1",
    HARBOR_PROFILE_RULES: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  });
  repoDir = join(root, "home", "proj");
  for (const d of ["run", "state", repoDir]) mkdirSync(d, { recursive: true });
  sh(repoDir, "init", "-q", "-b", "main");
  sh(repoDir, "config", "user.name", "t");
  sh(repoDir, "config", "user.email", "t@example.com");
  commit(repoDir, "a.txt", "a\n");
  const store = Store.open(dataDir());
  store.set("hub_api_port", String(await freePort()));
  repoId = store.addRepo(repoDir);
  h = await startHub({ version: "9.9.9", hookPort: await freePort(), store });
  lead = h.store.createChat(blankChat({ repoId, title: "Login work", role: "lead", account: "claude", updated: 1 }));
  h.engine.chats.push(lead);
});

afterAll(async () => {
  await h.stop();
  h.store.close();
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

const notices = (c: Chat): string[] => h.engine.transcript(c.id).items.flatMap((i) => (i.kind === "notice" ? [i.text] : []));

test("the_lead_sees_creates_and_switches_its_checkout_and_the_picker_follows", async () => {
  const st = await tool("checkout_status");
  expect(st).toContain(`This chat works in the project's checkout ${repoDir}.`);
  expect(st).toContain("Branch: main · no uncommitted changes · not pushed");
  expect(st).toContain("Default branch: main");
  const made = await tool("create_branch", { name: "fix-login" });
  const dir = h.store.get(`worktree:${lead.id}`) ?? "";
  expect(basename(dir)).toBe("proj-fix-login");
  expect(made).toContain(`Created branch fix-login from main`);
  expect(made).toContain(`Your shell is still in ${repoDir}`);
  expect(h.engine.chatCwd(lead)).toBe(dir);
  expect(notices(lead).at(-1)).toBe("Working in a new worktree · proj-fix-login on branch fix-login (from main)");
  expect(h.engine.takeNote(lead.id, "next")).toContain("the lead moved this thread to a new worktree");
  expect(await tool("checkout_status")).toContain("(here) · used by this chat");
  // Back to the project's checkout, and into the worktree again by its branch.
  expect(await tool("switch_branch", { worktree: "checkout" })).toContain(`This chat works in ${repoDir} now, on main.`);
  expect(h.store.get(`worktree:${lead.id}`)).toBe("");
  expect(await tool("switch_branch", { branch: "fix-login" })).toContain(`works in ${dir} now, on fix-login`);
  expect(h.store.get(`worktree:${lead.id}`)).toBe(dir);
  await expect(tool("switch_branch", {})).rejects.toThrow("give branch or worktree");
  await expect(tool("switch_branch", { branch: "nope" })).rejects.toThrow("no branch 'nope'");
});

test("the_lead_merges_its_work_then_cleans_up_but_never_deletes_where_it_stands", async () => {
  const dir = h.store.get(`worktree:${lead.id}`) ?? "";
  commit(dir, "login.txt", "fixed\n");
  await expect(tool("delete_branch", { branch: "fix-login" })).rejects.toThrow("this chat works in");
  await expect(tool("delete_branch", { branch: "main" })).rejects.toThrow("is checked out in the project's checkout");
  expect(await tool("merge_branch")).toContain("Merged fix-login into main (fast-forward)");
  expect(read(join(repoDir, "login.txt"))).toBe("fixed\n");
  expect(notices(lead).at(-1)).toStartWith("Merged fix-login into main · fast-forward");
  await tool("switch_branch", { worktree: "checkout" });
  const gone = await tool("delete_branch", { branch: "fix-login" });
  expect(gone).toContain("Removed the worktree proj-fix-login");
  expect(gone).toContain("merged into main");
  expect(existsSync(dir)).toBe(false);
  expect(sh(repoDir, "branch", "--list", "fix-login")).toBe("");
});

test("unmerged_work_and_uncommitted_changes_are_kept_unless_forced", async () => {
  await tool("create_branch", { name: "spike", worktree: false });
  expect(sh(repoDir, "branch", "--show-current")).toBe("spike");
  commit(repoDir, "spike.txt", "s\n");
  expect(await tool("rename_branch", { name: "spike-2" })).toBe("Renamed spike to spike-2.");
  await tool("switch_branch", { branch: "main" });
  await expect(tool("delete_branch", { branch: "spike-2" })).rejects.toThrow("1 commit that aren't merged into main or pushed");
  expect(await tool("delete_branch", { branch: "spike-2", force: true })).toContain("Deleted branch spike-2");
  // A worktree with uncommitted changes, and one another chat works in.
  const out = await tool("create_branch", { name: "hub/side", switch: false });
  expect(out).toContain("Nothing works there yet");
  const side = /in a new worktree (.+)\. Nothing/.exec(out)?.[1] ?? "";
  expect(basename(side)).toBe("proj-side");
  writeFileSync(join(side, "a.txt"), "dirty\n");
  await expect(tool("delete_branch", { worktree: "proj-side" })).rejects.toThrow("1 uncommitted change");
  const other = h.store.createChat(blankChat({ repoId, title: "Other thread", role: "lead", account: "claude", updated: 2 }));
  h.engine.chats.push(other);
  h.store.set(`worktree:${other.id}`, side);
  await expect(tool("delete_branch", { worktree: "proj-side" })).rejects.toThrow("Chat “Other thread” works in");
  expect(await tool("delete_branch", { worktree: "proj-side", force: true })).toContain("discarded its 1 uncommitted change");
  expect(h.store.get(`worktree:${other.id}`)).toBe("");
  // The branch stayed: only the worktree was named.
  expect(sh(repoDir, "branch", "--list", "hub/side")).toContain("hub/side");
});

test("a_conflicting_merge_stops_and_leaves_the_checkout_clean", async () => {
  sh(repoDir, "switch", "-qc", "theirs");
  commit(repoDir, "a.txt", "theirs\n");
  sh(repoDir, "switch", "-q", "main");
  commit(repoDir, "a.txt", "ours\n");
  const before = sh(repoDir, "rev-parse", "HEAD");
  await expect(tool("merge_branch", { branch: "theirs" })).rejects.toThrow("conflicts in a.txt");
  expect(sh(repoDir, "rev-parse", "HEAD")).toBe(before);
  expect(sh(repoDir, "status", "--porcelain")).toBe("");
  expect(notices(lead).at(-1)).toBe("Merge conflict · theirs into main: nothing merged");
  await expect(tool("merge_branch", { branch: "theirs", mode: "squash" })).rejects.toThrow("mode is");
});

test("a_subagent_gets_its_own_worktree_and_only_the_lead_has_the_tools", async () => {
  const made = await h.engine.host.makeWorktree?.(lead, "hub/tests", "");
  expect(made?.branch).toBe("hub/tests");
  expect(made?.base).toBe("main");
  const sub = h.store.createChat(blankChat({ repoId, title: "Tests", role: "sub", parent: lead.id, name: "tests", account: "claude", updated: 3 }));
  h.engine.chats.push(sub);
  expect(h.engine.chatCwd(sub)).toBe(repoDir);
  h.store.set(`worktree:${sub.id}`, made?.dir ?? "");
  expect(h.engine.chatCwd(sub)).toBe(made?.dir ?? "");
  // The lead's own folder is still the checkout.
  expect(h.engine.chatCwd(lead)).toBe(repoDir);
  expect(await tool("checkout_status", { agent: "tests" })).toContain(`Agent tests works in its own worktree proj-tests`);
  // A second one of that name gets the next free branch.
  expect((await h.engine.host.makeWorktree?.(lead, "hub/tests", ""))?.branch).toBe("hub/tests-2");
  commit(made?.dir ?? "", "t.txt", "t\n");
  expect(await tool("merge_branch", { branch: "hub/tests", into: "main" })).toContain("Merged harbor/tests into main");
  // Back to sharing the lead's folder.
  expect(await tool("switch_branch", { agent: "tests", worktree: "checkout" })).toContain(`Agent tests works in ${repoDir} now`);
  expect(h.store.get(`worktree:${sub.id}`)).toBe("");
  await expect(tool("checkout_status", {}, sub)).rejects.toThrow("only available to the lead");
  await expect(tool("checkout_status", { agent: "nobody" })).rejects.toThrow("no agent named 'nobody'");
});
