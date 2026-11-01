import "../sandbox.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Group, Issue, IssueFetched, IssueFilters, Source } from "../../src/ghapi.ts";
import {
  type GhRun, type GhRunner, accounts, activeFilters, assignees, authors, createIssuesPort, defaultFilters, fetchIssues, graphql, groups, isoSecs, labels, merge, milestones, notes, otherProjects,
  owner, parse, parseBaseQuery, parseQuery, query, runGh, shortError, sortGroup, sortLabel, stateOf, trusted,
} from "../../src/github/issues.ts";

const issue = (n: number, author: string): Issue => ({
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
  repo: "o/r",
  state: "open",
  created: n,
  updated: n,
  comments: 0,
  author,
  avatar: "",
  labels: [],
  assignees: [],
  milestone: null,
  mentions: [],
  accounts: [],
  linked_pr: false,
  author_trusted: true,
});

const filters = (over: Partial<IssueFilters> = {}): IssueFilters => ({ ...defaultFilters(), ...over });
const keys = (g: Group<Issue>[]): [string, number][] => g.map((x) => [x.key, x.items.length]);

test("query_syntax", () => {
  const q = parseQuery("crash label:bug assignee:@me milestone:v1 -label:wontfix");
  expect(q.base.text).toBe("crash");
  expect(q.base.labels).toEqual([["bug"]]);
  expect(q.base.excluded).toEqual(["wontfix"]);
  expect(q.assignee).toEqual({ kind: "login", login: "me" });
  expect(q.milestone).toBe("v1");
  const none = parseQuery("no:assignee no:milestone");
  expect([none.assignee, none.milestone]).toEqual([{ kind: "nobody" }, null]);
  expect(parseQuery("assignee:none").assignee).toEqual({ kind: "nobody" });
});

test("states", () => {
  expect(stateOf("OPEN", "")).toBe("open");
  expect(stateOf("CLOSED", "COMPLETED")).toBe("done");
  expect(stateOf("CLOSED", "NOT_PLANNED")).toBe("not_planned");
  expect(stateOf("closed", "")).toBe("done");
});

test("grouping_and_filters", () => {
  const a = issue(1, "you");
  a.assignees = ["Me"];
  const b = issue(2, "me");
  b.labels = [["bug", [255, 0, 0]]];
  b.milestone = "v1";
  const c = issue(3, "them");
  c.mentions = ["me"];
  const d = issue(4, "them");
  d.state = "done";
  d.comments = 9;
  const data: IssueFetched = { viewer: "me", items: [a, b, c, d], sources: [] };
  expect(keys(groups(data, filters(), "", "updated"))).toEqual([["assigned", 1], ["authored", 1], ["mentioned", 1]]);
  expect(groups(data, filters(), "label:bug", "updated")[0]?.items[0]?.number).toBe(2);
  const all = filters({ state: "all" });
  expect(keys(groups(data, all, "", "updated")).at(-1)).toEqual(["others", 1]);
  expect(groups(data, filters({ state: "closed" }), "", "updated")[0]?.items[0]?.number).toBe(4);
  expect(groups(data, filters({ involvement: "mentioned" }), "", "updated")[0]?.items[0]?.number).toBe(3);
  expect(groups(data, filters({ assignee: { kind: "nobody" }, milestone: "V1" }), "", "updated")[0]?.items[0]?.number).toBe(2);
  expect(groups(data, all, "#3", "updated")[0]?.items[0]?.number).toBe(3);
  expect(milestones(data)).toEqual([["v1", 1]]);
});

test("sorts", () => {
  const items = [1, 2, 3, 4].map((n) => issue(n, "x"));
  const first = (): number | undefined => items[0]?.number;
  if (items[1]) items[1].comments = 5;
  sortGroup(items, "most_commented", "");
  expect(first()).toBe(2);
  sortGroup(items, "oldest", "");
  expect(first()).toBe(1);
  sortGroup(items, "updated", "");
  expect(first()).toBe(4);
  sortGroup(items, "stale", "");
  expect(first()).toBe(1);
});

test("parses_search_nodes", () => {
  const v = {
    data: {
      viewer: { login: "me" },
      assigned: { nodes: [] },
      mentioned: {
        nodes: [
          {
            number: 5, title: "T", url: "https://github.com/o/r/issues/5", state: "CLOSED", stateReason: "NOT_PLANNED",
            createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", repository: { nameWithOwner: "o/r" },
            author: { login: "a", avatarUrl: "x" }, labels: { nodes: [{ name: "bug", color: "ff0000" }] },
            assignees: { nodes: [{ login: "b" }] }, milestone: { title: "v2" }, comments: { totalCount: 3 },
          },
        ],
      },
      p0: { nodes: [{ number: 5, url: "https://github.com/o/r/issues/5" }] },
    },
  };
  const f = parse(v);
  expect(f.items.length).toBe(1);
  const i = f.items[0];
  expect(i?.mentions).toEqual(["me"]);
  expect(i?.accounts).toEqual(["me"]);
  expect(i?.state).toBe("not_planned");
  expect(i?.comments).toBe(3);
  expect([i?.assignees, i?.milestone]).toEqual([["b"], "v2"]);
  expect(i?.labels[0]).toEqual(["bug", [255, 0, 0]]);
});

const src = (pc: string, name: string, login: string, projects: string[]): Source => ({ pc, name, login, projects });
const part = (viewer: string, items: Issue[]): IssueFetched => ({ viewer, items: items.map((i) => ({ ...i, accounts: [viewer] })), sources: [] });

test("merges_accounts_and_filters_by_one", () => {
  const one = issue(1, "kim");
  one.updated = 10;
  const oneB = issue(1, "kim");
  oneB.updated = 20;
  oneB.title = "newer";
  const two = issue(2, "x");
  two.assignees = ["sam"];
  const three = issue(3, "x");
  three.mentions = ["kim"];
  const off: Source = { ...src("ts:old", "old", "", []), error: "unreachable" };
  const data = merge([
    [src("", "desk", "", ["o/r"]), part("kim", [one, three])],
    [src("ts:lap", "laptop", "", []), part("sam", [oneB, two])],
    [off, undefined],
  ]);
  expect(data.viewer).toBe("kim");
  expect(data.items.length).toBe(3);
  const i1 = data.items.find((i) => i.number === 1);
  if (!i1) throw new Error("no #1");
  expect([i1.title, i1.accounts]).toEqual(["newer", ["kim", "sam"]]);
  expect(accounts(data)).toEqual([["kim", "desk", 2], ["sam", "laptop", 2]]);
  expect(notes(data)).toEqual(["old: unreachable"]);
  const by = (f: IssueFilters): [string, number[]][] => groups(data, f, "", "updated").map((g) => [g.key, g.items.map((i) => i.number)]);
  expect(by(filters())).toEqual([["assigned", [2]], ["authored", [1]], ["mentioned", [3]]]);
  const sam = filters({ account: "SAM" });
  expect(by(sam)).toEqual([["assigned", [2]], ["others", [1]]]);
  expect(by({ ...sam, involvement: "authored" })).toEqual([]);
  expect(by(filters({ involvement: "mentioned", account: "kim" }))).toEqual([["others", [3]]]);
  const i2 = data.items.find((i) => i.number === 2);
  if (!i2) throw new Error("no #2");
  expect(owner(data, i2, undefined, false)?.pc).toBe("ts:lap");
  expect(owner(data, i1, undefined, false)?.pc).toBe("");
  expect(owner(data, i1, "sam", false)?.pc).toBe("ts:lap");
  expect(owner(data, i2, undefined, true)?.pc).toBe("");
  expect(owner(data, { ...i2, repo: "o/other" }, undefined, true)).toBeUndefined();
});

test("project_choices_cover_every_pc", () => {
  const lone = issue(9, "x");
  lone.repo = "z/solo";
  const crm = issue(8, "x");
  crm.repo = "o/crm";
  const data = merge([
    [src("", "desk", "", ["o/r"]), part("kim", [issue(1, "x"), lone])],
    [src("ts:lap", "laptop", "", ["o/crm", "o/tools", "O/R"]), part("sam", [crm])],
    [src("ts:pc3", "pc3", "", ["o/crm"]), part("sam", [])],
  ]);
  expect(otherProjects(data, ["o/r"])).toEqual([
    ["crm", "o/crm", "laptop, pc3"],
    ["tools", "o/tools", "laptop"],
    ["z/solo", "z/solo", ""],
  ]);
  const f = filters({ project: "o/crm", state: "all" });
  expect(groups(data, f, "", "updated").flatMap((g) => g.items.map((i) => i.number))).toEqual([8]);
});

test("short_errors", () => {
  expect(shortError("Not signed in to GitHub. Run `gh auth login`.")).toBe("GitHub not connected");
  expect(shortError("boom\nmore")).toBe("boom");
});

test("short errors cut a long first line at 80 characters", () => {
  expect(shortError("x".repeat(80))).toBe("x".repeat(80));
  expect(shortError("é".repeat(81))).toBe(`${"é".repeat(79)}…`);
  expect(shortError("The GitHub CLI (gh) isn't installed. Install it")).toBe("GitHub not connected");
});

test("the base query keeps free text and reads label, author, draft, review and checks", () => {
  const q = parseBaseQuery('fix "two words" label:"a, b" -label:x,y type:bug author:@kim draft:true review:changes_requested status:failure scope:/x review:maybe');
  expect(q.text).toBe('fix "two words" scope:/x review:maybe');
  expect(q.labels).toEqual([["a, b"], ["type:bug"]]);
  expect(q.excluded).toEqual(["x", "y"]);
  expect([q.author, q.draft, q.review, q.checks]).toEqual(["@kim", true, "changes", "failing"]);
  expect(parseBaseQuery("-author:kim label: http://x").text).toBe("-author:kim label: http://x");
});

test("the issue query reads the milestone and assignee in any case", () => {
  expect(parseQuery('MILESTONE:"v1"').milestone).toBe("v1");
  expect(parseQuery("Milestone:NONE").milestone).toBeNull();
  expect(parseQuery("Assignee:@@Kim").assignee).toEqual({ kind: "login", login: "Kim" });
  expect(parseQuery("assignee: milestone:").base.text).toBe("assignee: milestone:");
});

test("free text ranks a title match before a newer author match", () => {
  const a = issue(1, "crash");
  a.updated = 50;
  const b = issue(2, "x");
  b.title = "crash on start";
  b.updated = 1;
  const c = issue(3, "x");
  c.title = "crash";
  c.updated = 2;
  const data: IssueFetched = { viewer: "", items: [a, b, c], sources: [] };
  const got = groups(data, filters(), "crash", "updated").flatMap((g) => g.items.map((i) => i.number));
  expect(got).toEqual([3, 2, 1]);
  expect(groups(data, filters(), "crash", "newest").flatMap((g) => g.items.map((i) => i.number))).toEqual([3, 2, 1]);
});

test("iso dates become seconds since 1970", () => {
  expect(isoSecs("1970-01-01T00:00:00Z")).toBe(0);
  expect(isoSecs("2026-01-02T03:04:05Z")).toBe(Date.parse("2026-01-02T03:04:05Z") / 1000);
  expect(isoSecs("2024-02-29")).toBe(Date.parse("2024-02-29T00:00:00Z") / 1000);
  expect(isoSecs("2026-01")).toBeUndefined();
  expect(isoSecs("")).toBeUndefined();
});

test("only owners, members and collaborators are trusted", () => {
  expect(["OWNER", "MEMBER", "COLLABORATOR"].every(trusted)).toBe(true);
  expect(["CONTRIBUTOR", "NONE", "", "owner"].some(trusted)).toBe(false);
});

test("counts, tallies and labels", () => {
  const a = issue(1, "Kim");
  a.assignees = ["sam", "kim"];
  a.labels = [["bug", [1, 2, 3]], ["ui", [4, 5, 6]]];
  a.milestone = "v1";
  const b = issue(2, "kim");
  b.assignees = ["kim"];
  b.labels = [["bug", [9, 9, 9]]];
  const c = issue(3, "sam");
  const data: IssueFetched = { viewer: "", items: [a, b, c], sources: [] };
  expect(authors(data)).toEqual([["Kim", 1], ["kim", 1], ["sam", 1]]);
  expect(assignees(data)).toEqual([["kim", 2], ["sam", 1]]);
  expect(labels(data)).toEqual([["bug", [1, 2, 3], 2], ["ui", [4, 5, 6], 1]]);
  expect(activeFilters(defaultFilters())).toBe(0);
  expect(activeFilters(filters({ state: "all", labels: ["a", "b"], milestone: null, account: "x" }))).toBe(5);
  expect(sortLabel("most_commented")).toBe("Most commented");
});

test("merge does not change its inputs and an older copy only adds accounts", () => {
  const newer = issue(1, "x");
  newer.updated = 20;
  newer.mentions = ["kim"];
  const older = issue(1, "x");
  older.updated = 5;
  older.title = "old";
  older.mentions = ["KIM", "sam"];
  const first = part("kim", [newer]);
  const second = part("sam", [older]);
  const data = merge([[src("", "a", "", []), first], [src("ts:b", "b", "", []), second]]);
  expect(data.items[0]?.title).toBe("Issue 1");
  expect(data.items[0]?.accounts).toEqual(["kim", "sam"]);
  expect(data.items[0]?.mentions).toEqual(["kim", "sam"]);
  expect(first.items[0]?.accounts).toEqual(["kim"]);
  expect(second.items[0]?.mentions).toEqual(["KIM", "sam"]);
  expect(data.sources.map((s) => s.login)).toEqual(["kim", "sam"]);
});

test("the graphql query asks for every account's issues and chunks the repos by five", () => {
  const repos = ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6", 'b/"7"'];
  const q = query("open", repos);
  expect(q.startsWith("query { viewer { login } assigned: search(query: \"is:issue assignee:@me archived:false sort:updated-desc is:open\", type: ISSUE, first: 50)")).toBe(true);
  expect(q).toContain('p0: search(query: "is:issue sort:updated-desc is:open repo:a/1 repo:a/2 repo:a/3 repo:a/4 repo:a/5", type: ISSUE, first: 100)');
  expect(q).toContain('p1: search(query: "is:issue sort:updated-desc is:open repo:a/6 repo:b/7", type: ISSUE, first: 100)');
  expect(q.endsWith("} } }")).toBe(true);
  expect(q).not.toContain("p2:");
  expect(query("all", [])).not.toContain("is:open");
  expect(query("closed", [])).toContain("mentions:@me archived:false sort:updated-desc is:closed");
});

const answer = {
  data: {
    viewer: { login: "kim" },
    assigned: { nodes: [{ number: 7, title: "Seven", url: "https://github.com/o/r/issues/7", state: "OPEN", updatedAt: "2026-01-02T00:00:00Z", authorAssociation: "OWNER", closedByPullRequestsReferences: { nodes: [{ state: "OPEN" }] } }] },
  },
};
const exit = (stdout: string, ok = true, stderr = ""): GhRun => ({ kind: "exit", ok, stdout, stderr });
const failsWith = (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: unknown) => (e instanceof Error ? e.message : String(e)));

test("fetch asks gh api graphql and parses the answer", async () => {
  const calls: string[][] = [];
  const run: GhRunner = async (args, ms) => {
    calls.push([...args, String(ms)]);
    return exit(JSON.stringify(answer));
  };
  const got = await createIssuesPort(run).fetch("open", ["o/r"]);
  expect(calls.length).toBe(1);
  expect(calls[0]?.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
  expect(calls[0]?.[3]).toBe(`query=${query("open", ["o/r"])}`);
  expect(calls[0]?.[4]).toBe("90000");
  expect(got.viewer).toBe("kim");
  expect(got.items[0]).toMatchObject({ number: 7, accounts: ["kim"], linked_pr: true, author_trusted: true, author: "ghost", state: "open", milestone: null });
});

test("a partial answer counts and an unreadable one is empty", async () => {
  const partial = await fetchIssues(async () => exit(JSON.stringify(answer), false, "one search failed"), "all", []);
  expect(partial.items.length).toBe(1);
  const empty = await fetchIssues(async () => exit("not json"), "all", []);
  expect(empty).toEqual({ viewer: "", items: [], sources: [] });
});

test("gh failures say what to do", async () => {
  expect(await failsWith(graphql(async () => ({ kind: "missing" }), "q", "issues"))).toBe("The GitHub CLI (gh) isn't installed. Install it and run `gh auth login` to see your issues.");
  expect(await failsWith(graphql(async () => ({ kind: "failed", why: "timed out after 90s" }), "q", "issues"))).toBe("gh: timed out after 90s");
  expect(await failsWith(graphql(async () => exit("", false, "To get started with GitHub CLI, please run:  gh auth login\n"), "q", "issues"))).toBe("Not signed in to GitHub. Run `gh auth login`.");
  expect(await failsWith(graphql(async () => exit("", false, "you are not logged in"), "q", "issues"))).toBe("Not signed in to GitHub. Run `gh auth login`.");
  expect(await failsWith(graphql(async () => exit('{"data":null}', false, " rate limited \n"), "q", "issues"))).toBe("rate limited");
});

let work = "";
let pathBefore: string | undefined;
let tokenBefore: string | undefined;

function fakeGh(body: string): void {
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "gh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "harbor-issues-"));
  pathBefore = process.env.PATH;
  tokenBefore = process.env.GH_TOKEN;
  process.env.PATH = `${join(work, "bin")}:${pathBefore ?? ""}`;
  process.env.GH_TOKEN = "personal-token";
});

afterAll(() => {
  if (pathBefore === undefined) delete process.env.PATH;
  else process.env.PATH = pathBefore;
  if (tokenBefore === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = tokenBefore;
  rmSync(work, { recursive: true, force: true });
});

test("the real runner runs gh with Harbor's agent environment", async () => {
  const log = join(work, "args.log");
  fakeGh(`printf '%s\\n' "$@" > '${log}'\nprintf 'token=%s config=%s\\n' "\${GH_TOKEN-unset}" "\${GH_CONFIG_DIR-unset}" >> '${log}'\ncat <<'EOF'\n${JSON.stringify(answer)}\nEOF`);
  const got = await createIssuesPort().fetch("closed", ["o/r"]);
  expect(got.items.map((i) => i.number)).toEqual([7]);
  const lines = readFileSync(log, "utf8").split("\n");
  expect(lines.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
  expect(lines[3]).toStartWith("query=query { viewer { login } assigned: search(");
  const env = lines.at(-2) ?? "";
  expect(env).toContain("token=unset");
  expect(env).not.toContain("config=unset");
  expect(env).not.toContain("personal-token");
});

test("the real runner reports a failing gh and its exit", async () => {
  fakeGh(`echo 'To get started with GitHub CLI, please run:  gh auth login' >&2\nexit 4`);
  expect(await failsWith(createIssuesPort().fetch("open", []))).toBe("Not signed in to GitHub. Run `gh auth login`.");
  fakeGh(`echo '{"data":{"viewer":{"login":"kim"}}}'\necho 'one search failed' >&2\nexit 1`);
  expect((await createIssuesPort().fetch("open", [])).viewer).toBe("kim");
  const r = await runGh(["x"], 5000);
  expect(r).toEqual({ kind: "exit", ok: false, stdout: '{"data":{"viewer":{"login":"kim"}}}\n', stderr: "one search failed\n" });
});

test("the real runner stops a gh that does not answer", async () => {
  fakeGh("exec sleep 30");
  const started = Date.now();
  const r = await runGh(["api"], 1000);
  expect(r).toEqual({ kind: "failed", why: "timed out after 1s" });
  expect(Date.now() - started).toBeLessThan(5000);
});

test("the real runner says so when gh is not installed", async () => {
  const empty = mkdtempSync(join(work, "empty-"));
  const keep = process.env.PATH;
  process.env.PATH = empty;
  try {
    expect(await runGh(["api"], 1000)).toEqual({ kind: "missing" });
    expect(await failsWith(createIssuesPort().fetch("open", []))).toContain("The GitHub CLI (gh) isn't installed");
  } finally {
    if (keep === undefined) delete process.env.PATH;
    else process.env.PATH = keep;
  }
});
