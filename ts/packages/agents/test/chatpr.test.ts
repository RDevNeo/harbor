import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Chat, Store } from "@harbor/store";
import * as pr from "../src/chatpr.ts";

// Windows runs git and starts processes several times slower: its tests get the time (setDefaultTimeout holds per file).
if (process.platform === "win32") setDefaultTimeout(30_000);

const base = mkdtempSync(join(tmpdir(), "hts-chatpr-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
// No hooks of this PC's own in the test repositories.
Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" });

function sh(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: process.env, stdout: "ignore", stderr: "pipe" });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

test("picks_the_branch_owners_pr_open_first", () => {
  const list = [
    { number: 9, state: "OPEN", isDraft: false, url: "u9", title: "fork's", headRefName: "feat", headRepositoryOwner: { login: "someone" } },
    { number: 7, state: "CLOSED", isDraft: false, url: "u7", title: "old", headRefName: "feat", headRepositoryOwner: { login: "Sam" } },
    { number: 8, state: "OPEN", isDraft: true, url: "u8", title: "new", headRefName: "feat", headRepositoryOwner: { login: "sam" } },
  ];
  const p = pr.pick(list, "feat", "sam", "harbor/abc123");
  expect(p && [p.number, p.state, p.branch]).toEqual([8, "draft", "harbor/abc123"]);
  expect(p && pr.label(p)).toBe("PR #8 · Draft");
  const merged = [{ number: 3, state: "MERGED", isDraft: false, url: "u3", title: "t", headRefName: "feat", headRepositoryOwner: { login: "sam" } }];
  expect(pr.pick(merged, "feat", "sam", "feat")?.state).toBe("merged");
  expect(pr.pick([], "feat", "sam", "feat")).toBeNull();
  // Another branch whose name only starts the same isn't it.
  const other = [{ number: 4, state: "OPEN", isDraft: false, url: "u4", title: "t", headRefName: "feat-2", headRepositoryOwner: { login: "sam" } }];
  expect(pr.pick(other, "feat", "sam", "feat")).toBeNull();
});

test("json_round_trips_for_peers", () => {
  const p: pr.ChatPr = { number: 12, state: "merged", url: "https://github.com/o/r/pull/12", title: "Fix it", branch: "b" };
  const v = pr.prJson(p);
  expect(v.state).toBe("merged");
  expect(v.label).toBe("PR #12 · Merged");
  expect(pr.prFrom(v)).toEqual({ ...p, branch: "" });
  expect(pr.prFrom(null)).toBeNull();
});

test("only_pushed_branches_off_the_default_have_a_place", async () => {
  const bare = join(base, "origin.git");
  const dir = join(base, "work");
  mkdirSync(dir, { recursive: true });
  sh(base, "init", "-q", "--bare", "-b", "main", bare);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one");
  sh(dir, "remote", "add", "origin", bare);
  sh(dir, "push", "-q", "origin", "main");
  // Not a GitHub remote: no place.
  expect(await pr.place(dir, "main", false)).toBeNull();
  sh(dir, "remote", "set-url", "origin", "git@github.com:sam/proj.git");
  sh(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  // The default branch never has one.
  expect(await pr.place(dir, "main", false)).toBeNull();
  sh(dir, "switch", "-q", "-c", "harbor/abc123");
  // Not pushed yet: none, unless a PR was found for it before.
  expect(await pr.place(dir, "harbor/abc123", false)).toBeNull();
  expect((await pr.place(dir, "harbor/abc123", true))?.head).toBe("harbor/abc123");
  // Pushed under another name with an upstream: that name, in the fork's parent first.
  sh(dir, "update-ref", "refs/remotes/origin/fix-it", "HEAD");
  sh(dir, "config", "branch.harbor/abc123.remote", "origin");
  sh(dir, "config", "branch.harbor/abc123.merge", "refs/heads/fix-it");
  sh(dir, "remote", "add", "upstream", "https://github.com/acme/proj");
  expect(await pr.place(dir, "harbor/abc123", false)).toEqual({ head: "fix-it", repos: ["acme/proj", "sam/proj"], owner: "sam" });
});

test("a lookup that lands after stop leaves the closed store alone", async () => {
  const dir = join(base, "stopped");
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "harbor/gone");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one");
  const store = Store.openTemp();
  const chat = { id: 1, role: "lead", home: "", device: "" } as unknown as Chat;
  let changed = 0;
  const prs = new pr.ChatPrs({ store, chats: () => store.chats(), chat: (id) => (id === 1 ? chat : undefined), folders: () => ({ repo: dir, dir }), changed: () => void changed++ });
  // Known before; the lookup finds none now (no remote), so landing would save and read the chats.
  prs.found.set(1, { number: 5, state: "open", url: "u", title: "t", branch: "harbor/gone" });
  const errors: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    prs.want(1, null);
    prs.stop();
    store.close();
    await prs.idle();
  } finally {
    console.error = was;
  }
  expect(errors).toEqual([]);
  expect(changed).toBe(0);
  expect(prs.found.get(1)?.number).toBe(5);
  // Nothing new starts once stopped.
  prs.want(1, null);
  await prs.idle();
  expect(changed).toBe(0);
});
