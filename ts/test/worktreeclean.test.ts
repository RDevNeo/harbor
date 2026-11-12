import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { dataDir, Store } from "../packages/store/src/index.ts";
import { type RunningHub, startHub } from "../hub.ts";
import { projectSaid } from "../worktreeclean.ts";

// Delete merged worktrees on a running hub: a fake gh says the chat's PR was squash-merged.

let root: string;
let h: RunningHub;
let port = 0;
let repoId = 0;
let repo = "";
let ghDir = "";
const saved = { ...process.env };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hts-wtclean-hub-"));
  ghDir = join(root, "gh");
  const bin = join(root, "bin");
  mkdirSync(ghDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // gh pr list --head H …: the JSON in gh/<H with / as _>.json, else none.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nhead=""\nwhile [ $# -gt 0 ]; do [ "$1" = "--head" ] && head="$2"; shift; done\nf="${ghDir}/$(echo "$head" | tr / _).json"\nif [ -f "$f" ]; then cat "$f"; else echo "[]"; fi\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  Object.assign(process.env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
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
  });
  repo = join(root, "home", "proj");
  for (const d of [join(root, "run"), join(root, "state"), repo]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repo, "a.txt"), "a");
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "one");
  // A GitHub project (chatpr only asks gh about those); its pushes are faked with remote-tracking refs.
  sh(repo, "remote", "add", "origin", "git@github.com:sam/proj.git");
  sh(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  port = await freePort();
  const store = Store.open(dataDir());
  store.set("api_port", String(port));
  store.set("api_enabled", "1");
  store.set("api_tokens", JSON.stringify([{ token: "tok", name: "Pixel", created: 0, group: "", fp: "" }]));
  repoId = store.addRepo(repo);
  h = await startHub({ version: "9.9.9", hookPort: await freePort(), store });
});

afterAll(async () => {
  await h.stop();
  h.store.close();
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body = ""): Promise<[number, string]> {
  return new Promise((resolve, reject) => {
    const c = connect(port, "127.0.0.1", () => c.write(`${method} ${path} HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
    let out = Buffer.alloc(0);
    c.on("data", (d: Buffer) => (out = Buffer.concat([out, d])));
    c.on("error", reject);
    c.on("close", () => {
      const t = out.toString("latin1");
      const i = t.indexOf("\r\n\r\n");
      resolve([Number(t.slice(9, 12)), i < 0 ? "" : out.subarray(i + 4).toString()]);
    });
  });
}

async function json(method: string, path: string, body: unknown = {}): Promise<[number, Record<string, unknown>]> {
  const [status, text] = await call(method, path, method === "GET" ? "" : JSON.stringify(body));
  return [status, text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)];
}

/** A chat in a new worktree with a commit on its branch, pushed; GitHub says PR `n` merged it (squashed into main). */
async function mergedChat(title: string, n: number): Promise<{ id: number; dir: string; branch: string }> {
  const [st, made] = await json("POST", "/v1/chats", { project_id: repoId, title, worktree: true });
  expect(st).toBe(200);
  const id = made.id as number;
  const dir = h.store.get(`worktree:${id}`) ?? "";
  const branch = sh(dir, "branch", "--show-current");
  writeFileSync(join(dir, `f${n}.txt`), `${n}\n`);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", title);
  const tip = sh(dir, "rev-parse", "HEAD");
  sh(dir, "update-ref", `refs/remotes/origin/${branch}`, tip);
  sh(repo, "merge", "-q", "--squash", branch);
  sh(repo, "commit", "-q", "-m", `${title} (#${n})`);
  writeFileSync(
    join(ghDir, `${branch.replace(/\//g, "_")}.json`),
    JSON.stringify([{ number: n, state: "MERGED", isDraft: false, url: `https://github.com/sam/proj/pull/${n}`, title, headRefName: branch, headRepositoryOwner: { login: "sam" }, headRefOid: tip }]),
  );
  return { id, dir, branch };
}

const notices = (id: number): string[] => h.store.items(id).flatMap((i) => (i.kind === "notice" ? [i.text] : []));
const hasBranch = (b: string): boolean => Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).success;

async function until(f: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !f(); i++) await Bun.sleep(25);
}

test("a_merged_chats_worktree_and_branch_go_once_its_pr_is_seen_merged_and_the_chat_works_in_the_checkout", async () => {
  const { id, dir, branch } = await mergedChat("Fix the login bug", 11);
  h.prs.want(id, null);
  // The folder goes first; the chat is pointed at the checkout and told once its branch went too.
  await until(() => notices(id).some((t) => t.startsWith("Worktree removed")));
  expect(existsSync(dir)).toBe(false);
  expect(hasBranch(branch)).toBe(false);
  expect(h.store.get(`worktree:${id}`)).toBe("");
  expect(notices(id)).toContain(`Worktree removed: ${branch} was merged (PR #11)`);
  expect(h.engine.takeNote(id, "next")).toContain("was removed");
  // The chat goes on in the project's checkout: the footer says so, and a turn would start there.
  const chat = h.engine.chat(id);
  expect(chat && h.engine.chatCwd(chat)).toBe(repo);
  const [, ws] = await json("GET", `/v1/workspace?chat=${id}`);
  expect(ws).toMatchObject({ git: true, mode: "checkout", branch: "main", can_move: true });
}, 20_000);

test("a_dirty_worktree_stays_and_the_chat_says_why_once", async () => {
  const { id, dir, branch } = await mergedChat("Add a thing", 12);
  writeFileSync(join(dir, "wip.txt"), "wip\n");
  h.prs.want(id, null);
  await until(() => notices(id).some((t) => t.startsWith("Kept the worktree")));
  expect(notices(id)).toContain("Kept the worktree: PR #12 was merged, but it has 1 uncommitted change");
  expect(existsSync(dir)).toBe(true);
  expect(hasBranch(branch)).toBe(true);
  h.prs.want(id, null);
  await Bun.sleep(300);
  expect(notices(id).filter((t) => t.startsWith("Kept the worktree")).length).toBe(1);
  rmSync(join(dir, "wip.txt"));
}, 20_000);

test("clean_up_merged_worktrees_in_the_project_menu_reports_counts_and_keeps_branches_when_asked", async () => {
  h.store.set("wt_clean_merged", "0");
  h.store.set("wt_clean_branch", "0");
  const a = await mergedChat("Make it faster", 13);
  const b = await mergedChat("Tidy the docs", 14);
  // b has a commit the PR didn't.
  writeFileSync(join(b.dir, "late.txt"), "late\n");
  sh(b.dir, "add", "-A");
  sh(b.dir, "commit", "-q", "-m", "late");
  // Turned off: a lookup alone does nothing.
  h.prs.want(a.id, null);
  await Bun.sleep(300);
  expect(existsSync(a.dir)).toBe(true);
  const [, menu] = await json("POST", "/v1/projects/menu", { project: repoId });
  expect((menu.items as { act: string }[]).some((i) => i.act === "clean_worktrees")).toBe(true);
  const [st, done] = await json("POST", "/v1/projects/do", { project: repoId, act: "clean_worktrees" });
  expect(st).toBe(200);
  // a: removed, branch kept; b: kept (late commit); the dirty chat of the last test: now clean, removed.
  expect(done).toMatchObject({ ok: true, removed: 2, branches: 0, kept: 1 });
  expect(String(done.said)).toContain("Removed 2 merged worktrees");
  expect(String(done.said)).toContain(`Tidy the docs: ${b.branch} has commits that aren't in PR #14`);
  expect(existsSync(a.dir)).toBe(false);
  expect(hasBranch(a.branch)).toBe(true);
  expect(existsSync(b.dir)).toBe(true);
  h.store.set("wt_clean_merged", "1");
  h.store.set("wt_clean_branch", "1");
}, 20_000);

test("phone_settings_route_reads_and_sets_the_three_toggles", async () => {
  expect((await json("GET", "/v1/worktrees/settings"))[1]).toEqual({ delete_merged: true, delete_branch: true, delete_remote: false });
  expect((await json("PUT", "/v1/worktrees/settings", { delete_remote: true }))[1]).toEqual({ delete_merged: true, delete_branch: true, delete_remote: true });
  expect(h.store.get("wt_clean_remote")).toBe("1");
  h.store.set("wt_clean_remote", "0");
});

test("the_phone_settings_screen_says_the_same_and_its_checklist_sets_the_toggles", async () => {
  const prims = ["section", "row", "multi", "pick", "do", "url", "native", "native:dictionary"];
  const [st, scr] = await json("POST", "/v1/ui/settings", { prims });
  expect(st).toBe(200);
  const secs = scr.sections as { id: string; title: string; rows: { id: string; sub: string; tap: { kind: string; items?: { key: string; on: boolean }[] } }[] }[];
  expect(secs.map((s) => s.title)).toEqual(["Voice", "Projects", "Worktrees"]);
  const wt = secs[2]?.rows[0];
  expect(wt?.sub).toBe("Once a chat's PR is merged · their branches too");
  expect(wt?.tap.items?.map((i) => [i.key, i.on])).toEqual([["wt_clean_merged", true], ["wt_clean_branch", true], ["wt_clean_remote", false]]);
  const [st2, after] = await json("POST", "/v1/ui/settings/do", { prims, act: "worktrees", values: { wt_clean_remote: true, voice_cleanup: true } });
  expect(st2).toBe(200);
  expect((after.sections as { rows: { sub: string }[] }[])[2]?.rows[0]?.sub).toBe("Once a chat's PR is merged · branches too, here and on GitHub");
  expect(h.store.get("wt_clean_remote")).toBe("1");
  // Only the checklist's own keys.
  expect(h.store.get("voice_cleanup")).not.toBe("1");
  h.store.set("wt_clean_remote", "0");
  // A phone without the dictionary screen gets no Voice section; an unknown act is an error.
  expect(((await json("POST", "/v1/ui/settings", { prims: prims.slice(0, 7) }))[1].sections as { id: string }[]).map((s) => s.id)).toEqual(["projects", "worktrees"]);
  expect((await json("POST", "/v1/ui/settings/do", { prims, act: "nope" }))[0]).toBe(400);
});

test("the_project_line_says_what_it_did", () => {
  expect(projectSaid({ removed: 0, branches: 0, kept: 0, busy: 0, open: 0 }, 0, [])).toBe("No chat of this project has a worktree");
  expect(projectSaid({ removed: 1, branches: 1, kept: 0, busy: 0, open: 2 }, 3, [])).toBe("Removed 1 merged worktree and its branch");
  expect(projectSaid({ removed: 0, branches: 0, kept: 0, busy: 0, open: 2 }, 2, [])).toBe("No merged worktrees: 2 worktrees without a merged PR");
  expect(projectSaid({ removed: 0, branches: 0, kept: 0, busy: 1, open: 0 }, 1, ["Fix: an agent is working in it"])).toBe("Kept 1 (Fix: an agent is working in it)");
});
