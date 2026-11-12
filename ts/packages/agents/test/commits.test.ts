import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cm from "../src/commits.ts";

const base = mkdtempSync(join(tmpdir(), "hts-commits-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
// No hooks of this PC's own in the test repositories.
Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" });

const toks = (s: string): string[] => cm.tokens(s).map(([a, z]) => s.slice(a, z));

test("hashes_are_found_and_lookalikes_are_not", () => {
  expect(toks("Pushed 7dfbd05 and 35cbb88.")).toEqual(["7dfbd05", "35cbb88"]);
  expect(toks("full: 35cbb88a1f2e3d4c5b6a79880716253443526170, done")).toEqual(["35cbb88a1f2e3d4c5b6a79880716253443526170"]);
  expect(toks("(ac358de)")).toEqual(["ac358de"]);
  // Too short, too long (a sha256), no digit, no letter, uppercase.
  expect(toks("abc12f 1234567 deadbeefcafe ABCDEF1")).toEqual([]);
  expect(toks("a1".repeat(32))).toEqual([]);
  for (const s of ["#a1b2c3d4", "550e8400-e29b-41d4-a716-446655440000", "/tmp/a1b2c3d4/x", "https://x.dev/c/a1b2c3d4", "0xa1b2c3d4", "SHA256:ab12cd34ef56", "ab:cd:ef:12:34:56:78", "a1b2c3d4@host", "a1b2c3d4.png", "id=a1b2c3d4", "port a1b2c3d:80"])
    expect([s, toks(s)]).toEqual([s, []]);
  // Words around it are fine, glued ones aren't.
  expect(toks("x7dfbd05 7dfbd05y 7dfbd05_")).toEqual([]);
});

test("markdown_sites_skip_code_blocks_and_links", () => {
  const md = "Fixed in 7dfbd05 and `35cbb88`.\n\n```\ngit show ac358de\n```\n\n    1ab0034 indented\n\n[see a8f7125](https://x.dev) and `git show ce77938`\n\n- item **b4b7522**\n";
  const s = cm.sites(md);
  expect(s.map((x) => [x.token, x.code])).toEqual([
    ["7dfbd05", false],
    ["35cbb88", true],
    ["b4b7522", false],
  ]);
  const r = s[1]?.range ?? [0, 0];
  expect(md.slice(r[0], r[1])).toBe("`35cbb88`");
  expect(cm.sites("no hashes here")).toEqual([]);
});

const commit = (sha: string): cm.Commit => ({ sha, short: sha.slice(0, 7), subject: "Fix it", author: "A", at: 1 });

test("pills_replace_only_known_commits", () => {
  const full = "7dfbd05c2aa1b2c3d4e5f60718293a4b5c6d7e8f";
  const known = new Map([["7dfbd05c2", commit(full)]]);
  const md = "Shipped `7dfbd05c2`, not 35cbb88.";
  const pill = cm.pillText(commit(full));
  expect(cm.pillsMd(md, known)).toBe(`Shipped [\`${pill}\`](${cm.SCHEME}${full}), not 35cbb88.`);
  expect(pill).toContain("7dfbd05");
  expect(pill).not.toContain("7dfbd05c");
  expect(cm.pillsMd(md, new Map())).toBe(md);
  expect((cm.wire(new Map([["35cbb88", commit("35cbb88a1f2e3d4c5b6a79880716253443526170")]]))["35cbb88a1f2e3d4c5b6a79880716253443526170"] as cm.Commit).short).toBe("35cbb88");
});

test("github_urls_from_remotes", () => {
  for (const u of [
    "git@github.com:o/r.git",
    "git@github.com:o/r",
    "ssh://git@github.com/o/r.git",
    "ssh://git@github.com:22/o/r",
    "https://github.com/o/r.git",
    "https://github.com/o/r/",
    "http://github.com/o/r",
    "https://user:ghp_secret@github.com/o/r.git",
    "git://github.com/o/r.git",
    "https://www.GitHub.com/o/r",
  ])
    expect([u, cm.githubBase(u)]).toEqual([u, "https://github.com/o/r"]);
  for (const u of ["git@gitlab.com:o/r.git", "https://example.org/o/r", "/srv/git/r.git", "https://github.com/o", "https://github.com/o/r/tree/x", "file:///tmp/r"]) expect([u, cm.githubBase(u)]).toEqual([u, null]);
});

test("resolves_real_commits_only", async () => {
  const dir = join(base, "repo");
  mkdirSync(dir);
  const g = (...args: string[]): string => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
    if (!r.success) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  g("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  g("add", "a.txt");
  g("commit", "-q", "-m", "Add a\n\nThe body.");
  g("remote", "add", "origin", "git@github.com:o/r.git");
  const sha = g("rev-parse", "HEAD");
  const tree = g("rev-parse", "HEAD^{tree}");
  // A short id as the app links one (shaLike: a digit and a letter, so plain numbers stay text). Nine
  // characters alone are all digits for about 1 commit in 70.
  let short = sha.slice(0, 9);
  for (let n = 10; !cm.shaLike(short); n++) short = sha.slice(0, n);
  const fake = "0123abc0123abc0";
  const found = await cm.resolve(dir, [short, fake, tree.slice(0, 10)]);
  // A tree or an unknown id isn't a commit.
  expect(found.size).toBe(1);
  expect(found.get(short)).toMatchObject({ sha, subject: "Add a", author: "T" });
  const d = await cm.detail(dir, short);
  expect(d.body).toBe("The body.");
  expect(d.email).toBe("t@example.com");
  expect(d.files).toEqual([{ path: "a.txt", adds: 2, dels: 0 }]);
  expect(d.url).toBe(`https://github.com/o/r/commit/${sha}`);
  expect(await cm.diff(dir, sha)).toContain("+two");
  await expect(cm.detail(dir, fake)).rejects.toThrow();
  // Looked up once, then known.
  let done = 0;
  expect(cm.known(dir, [short], () => done++).size).toBe(0);
  for (let i = 0; i < 100 && done === 0; i++) await Bun.sleep(20);
  expect(cm.known(dir, [short], () => done++).get(short)?.sha).toBe(sha);
});
