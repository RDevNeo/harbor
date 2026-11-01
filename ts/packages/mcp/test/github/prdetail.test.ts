import { expect, test } from "bun:test";
import type { DiffLine } from "../../src/ghapi.ts";
import { type GhOut, type GhRun, GhSpawnError } from "../../src/github/gh.ts";
import { FIELDS, cleanMd, fetch, gh, parse, parseDiff, repoOf } from "../../src/github/prdetail.ts";

const view = {
  number: 7, title: "T", url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: true,
  author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
  baseRefName: "main", headRefName: "feat", additions: 3, deletions: 1, changedFiles: 2,
  labels: [{ name: "bug", color: "ff0000" }],
  reviewRequests: [{ login: "b" }], latestReviews: [{ author: { login: "c" }, state: "APPROVED" }],
  reviews: [{ author: { login: "c" }, state: "APPROVED", body: "", submittedAt: "2026-01-03T00:00:00Z" }],
  comments: [{ author: { login: "d" }, body: "hi", createdAt: "2026-01-02T12:00:00Z" }],
  statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }, { context: "lint", state: "PENDING" }],
  commits: [{ oid: "abcdef0123", messageHeadline: "first", committedDate: "2026-01-01T06:00:00Z", authors: [{ login: "a" }] }],
  mergeable: "CONFLICTING",
};

test("html_in_markdown", () => {
  const s = "<!-- BEGIN -->\nText <b>bold</b> and `<div>` kept\n<!-- a\nb -->\n```\n<div>x</div>\n```\n<div><a href=\"u\"><img src=\"x\"></a></div>\n";
  expect(cleanMd(s)).toBe("\nText bold and `<div>` kept\n\n```\n<div>x</div>\n```\n\n");
  expect(cleanMd("a < b > c, Vec<T>")).toBe("a < b > c, Vec<T>");
});

test("markdown cleaning keeps the rest as it is", () => {
  expect(cleanMd("")).toBe("");
  expect(cleanMd("no newline <br/>end")).toBe("no newline end");
  expect(cleanMd("</DIV>x<Details open>y")).toBe("xy");
  expect(cleanMd("a <!-- x --> b <!-- y")).toBe("a  b ");
  expect(cleanMd("<custom>kept</custom> <span")).toBe("<custom>kept</custom> <span");
  expect(cleanMd("  ```js\n<b>x</b>\n  ```\n<b>y</b>")).toBe("  ```js\n<b>x</b>\n  ```\ny");
  expect(cleanMd("café <i>\u{1F600}</i>")).toBe("café \u{1F600}");
});

test("diff_lines", () => {
  const d = "diff --git a/src/x.rs b/src/x.rs\nindex 1..2 100644\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -1,2 +1,2 @@\n fn a() {}\n-old\n+new\n+more\n\\ No newline at end of file\n";
  const l = parseDiff(d);
  expect(l[0]).toEqual({ t: "file", path: "src/x.rs", adds: 2, dels: 1 });
  expect(l[1]).toEqual({ t: "hunk", text: "@@ -1,2 +1,2 @@" });
  expect(l[2]).toEqual({ t: "ctx", text: "fn a() {}" });
  expect(l[3]).toEqual({ t: "del", text: "old" });
  expect(l).toHaveLength(6);
});

test("a diff of several files, renames, CRLF and empty context lines", () => {
  const d = [
    "diff --git a/a.txt b/a.txt", "new file mode 100644", "--- /dev/null", "+++ b/a.txt", "@@ -0,0 +1,2 @@", "+one\r", "+two",
    "diff --git a/old name.txt b/new b/name.txt", "similarity index 90%", "rename from old name.txt", "rename to new b/name.txt", "@@ -1,3 +1,3 @@", " keep", "", "-x", "+y",
    "diff --git a/bin.png b/bin.png", "Binary files a/bin.png and b/bin.png differ", "",
  ].join("\n");
  const l: DiffLine[] = parseDiff(d);
  expect(l.filter((x) => x.t === "file")).toEqual([
    { t: "file", path: "a.txt", adds: 2, dels: 0 },
    { t: "file", path: "name.txt", adds: 1, dels: 1 },
    { t: "file", path: "bin.png", adds: 0, dels: 0 },
  ]);
  expect(l[2]).toEqual({ t: "add", text: "one" });
  expect(l.filter((x) => x.t === "ctx")).toEqual([{ t: "ctx", text: "keep" }, { t: "ctx", text: "" }]);
  expect(parseDiff("")).toEqual([]);
  expect(parseDiff("--- a\n+++ b\n+not in a hunk")).toEqual([]);
});

test("view_json", () => {
  const f = parse(view);
  expect(f.reviewers).toEqual([["c", "APPROVED"], ["b", "PENDING"]]);
  expect(f.labels[0]).toEqual(["bug", [255, 0, 0]]);
  expect([f.checks[0]?.state, f.checks[1]?.state]).toEqual(["pass", "pending"]);
  expect(f.conflicting && f.draft).toBe(true);
  expect(f.timeline.map((e) => e[2].kind)).toEqual(["opened", "commit", "comment", "review"]);
  expect(repoOf(f.url)).toBe("o/r");
});

test("the rest of a pull request view", () => {
  const f = parse(view);
  expect([f.number, f.title, f.state, f.author, f.base, f.head, f.adds, f.dels, f.files]).toEqual([7, "T", "OPEN", "a", "main", "feat", 3, 1, 2]);
  expect([f.created, f.updated]).toEqual([1_767_225_600, 1_767_225_600 + 86_400]);
  expect(f.comments).toEqual([{ author: "d", at: 1_767_225_600 + 129_600, body: "hi" }]);
  expect(f.timeline[1]).toEqual([1_767_225_600 + 21_600, "a", { kind: "commit", sha: "abcdef0", headline: "first" }]);
  expect(f.timeline[3]).toEqual([1_767_225_600 + 172_800, "c", { kind: "review", state: "APPROVED", body: "" }]);
  const bare = parse({});
  expect([bare.number, bare.author, bare.state, bare.draft, bare.conflicting, bare.reviewers, bare.checks, bare.created]).toEqual([0, "ghost", "", false, false, [], [], 0]);
  expect(bare.timeline).toEqual([[0, "ghost", { kind: "opened" }]]);
});

test("check results and reviewers", () => {
  const states = ["SUCCESS", "FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "SKIPPED", "NEUTRAL", "STALE", "", "IN_PROGRESS"].map((conclusion) => ({ name: conclusion, conclusion }));
  const f = parse({ statusCheckRollup: [...states, { detailsUrl: "https://ci.example.com/1", targetUrl: "https://x", state: "ERROR" }, {}] });
  expect(f.checks.map((c) => c.state)).toEqual(["pass", "fail", "fail", "fail", "fail", "fail", "fail", "skipped", "skipped", "skipped", "pending", "pending", "fail", "pending"]);
  expect(f.checks[12]).toEqual({ name: "check", state: "fail", url: "https://ci.example.com/1" });
  const r = parse({
    latestReviews: [{ author: { login: "c" }, state: "APPROVED" }, { author: { login: "c" }, state: "COMMENTED" }, { author: null, state: "X" }],
    reviewRequests: [{ login: "c" }, { slug: "team" }, { name: "Named" }, {}, { login: "" }],
  });
  expect(r.reviewers).toEqual([["c", "APPROVED"], ["ghost", "X"], ["team", "PENDING"], ["Named", "PENDING"]]);
});

test("descriptions and comments lose their HTML", () => {
  const f = parse({ body: "<p>hi</p><!-- x -->", comments: [{ author: { name: "Bot" }, body: "<b>b</b>", createdAt: "2026-01-01T00:00:00Z" }], reviews: [{ author: { login: "r" }, state: "COMMENTED", body: "<i>ok</i>", submittedAt: "2026-01-02T00:00:00Z" }] });
  expect(f.body).toBe("hi");
  expect(f.comments[0]).toEqual({ author: "Bot", at: 1_767_225_600, body: "b" });
  expect(f.timeline.map((e) => e[2])).toEqual([{ kind: "opened" }, { kind: "comment", body: "b" }, { kind: "review", state: "COMMENTED", body: "ok" }]);
});

test("fetch runs gh pr view with the field list and reads its JSON", async () => {
  const calls: string[][] = [];
  const run: GhRun = async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(view), stderr: "" };
  };
  const f = await fetch("https://github.com/o/r/pull/7", run);
  expect(f.number).toBe(7);
  expect(calls).toEqual([["pr", "view", "https://github.com/o/r/pull/7", "--json", FIELDS]]);
});

const message = (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: Error) => e.message);

test("gh failures say why", async () => {
  const out = (over: Partial<GhOut>): GhRun => async () => ({ code: 1, stdout: "", stderr: "", ...over });
  expect(await message(gh(["pr", "diff", "u"], out({ stderr: " no pull request found\n" })))).toBe("no pull request found");
  expect(await message(gh(["pr", "diff", "u"], out({})))).toBe("gh failed");
  expect(await message(gh(["x"], async () => {
    throw new GhSpawnError("timeout", "timed out after 90s");
  }))).toBe("gh: timed out after 90s");
  expect(await gh(["x"], out({ code: 0, stdout: "diff text" }))).toBe("diff text");
  expect(await message(fetch("u", out({ code: 0, stdout: "not json" })))).toMatch(/JSON/i);
});
