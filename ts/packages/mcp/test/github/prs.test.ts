import { expect, test } from "bun:test";
import type { Pr, PrFetched, PrFilters } from "../../src/ghapi.ts";
import { type GhOut, type GhRun, GhSpawnError } from "../../src/github/gh.ts";
import {
  activeFilters, ago, authors, defaultFilters, fetch, githubRepo, graphql, groups, hexRgb, isoSecs, labels, makePrsPort, parse, parseQuery, query, sortGroup, sortLabel, thousands,
} from "../../src/github/prs.ts";

const pr = (n: number, author: string, over: Partial<Pr> = {}): Pr => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, repo: "o/r", state: "open", draft: false, adds: n, dels: 0, created: n, updated: n,
  branch: `b${n}`, head: "", review: "none", checks: "none", conflicting: false, author, avatar: "", labels: [], review_requested: false, ...over,
});

const reply = (stdout: unknown, over: Partial<GhOut> = {}): GhRun => async () => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "", ...over });

test("query_syntax", () => {
  const q = parseQuery("fix label:bug,ui -label:wontfix author:me draft:true review:approved checks:failing type:feat");
  expect(q.text).toBe("fix");
  expect(q.labels).toEqual([["bug", "ui"], ["type:feat"]]);
  expect(q.excluded).toEqual(["wontfix"]);
  expect(q.author).toBe("me");
  expect(q.draft).toBe(true);
  expect(q.review).toBe("approved");
  expect(q.checks).toBe("failing");
  expect(parseQuery('label:"needs review" x').labels).toEqual([["needs review"]]);
  expect(parseQuery("https://x").text).toBe("https://x");
});

test("query syntax keeps what it does not understand as text", () => {
  expect(parseQuery("-author:me draft:maybe review:odd checks:odd label: status:success /x key:/path").text).toBe("-author:me draft:maybe review:odd checks:odd label: /x key:/path");
  expect(parseQuery("status:success review:changes-requested").checks).toBe("passing");
  expect(parseQuery("review:changes-requested").review).toBe("changes");
  expect(parseQuery("review:review-required").review).toBe("required");
  expect(parseQuery("review:none").review).toBe("none");
  expect(parseQuery("type:a:b").labels).toEqual([["a:b"]]);
  expect(parseQuery('"two words" label:"a, b"').labels).toEqual([["a, b"]]);
  expect(parseQuery("label:a,b,c,d,e,f,g,h,i,j,k,l").labels[0]).toHaveLength(10);
});

test("iso", () => {
  expect(isoSecs("1970-01-02T00:00:01Z")).toBe(86401);
  expect(isoSecs("2026-10-22T00:00:00Z")).toBe(1_792_627_200);
});

test("dates without a time, and nonsense", () => {
  expect(isoSecs("1970-01-02")).toBe(86400);
  expect(isoSecs("1970-01")).toBeUndefined();
  expect(isoSecs("")).toBeUndefined();
  expect(isoSecs("abcd-ef-gh")).toBeUndefined();
  expect(isoSecs("2000-03-01T00:00:00Z")).toBe(951_868_800);
  expect(isoSecs("2000-02-29T23:59:59Z")).toBe(951_868_799);
});

test("grouping_and_filters", () => {
  const a = pr(1, "me", { labels: [["bug", [255, 0, 0]]] });
  const b = pr(2, "you", { review_requested: true });
  const c = pr(3, "them");
  const d = pr(4, "them", { state: "merged" });
  const data: PrFetched = { viewer: "Me", items: [a, b, c, d] };
  const g = groups(data, defaultFilters(), "", "updated");
  expect(g.map((x) => [x.key, x.items.length])).toEqual([["authored", 1], ["reviewRequested", 1], ["others", 1]]);
  expect(groups(data, defaultFilters(), "label:bug", "updated")).toHaveLength(1);
  const reviewing: PrFilters = { ...defaultFilters(), state: "all", involvement: "reviewing" };
  expect(groups(data, reviewing, "", "updated")[0]?.items[0]?.number).toBe(2);
  expect(groups(data, { ...defaultFilters(), state: "merged" }, "", "updated")[0]?.items[0]?.number).toBe(4);
  expect(groups(data, defaultFilters(), "#3", "ready")[0]?.items[0]?.number).toBe(3);
});

test("filters from the toolbar and from the search box together", () => {
  const items = [
    pr(1, "ann", { draft: true, review: "approved", checks: "passing", labels: [["bug", [1, 2, 3]], ["ui", [1, 2, 3]]] }),
    pr(2, "Bob", { draft: false, review: "changes", checks: "failing", repo: "o/other", labels: [["bug", [1, 2, 3]]] }),
    pr(3, "ann", { labels: [[" Bug ", [1, 2, 3]]] }),
  ];
  const data: PrFetched = { viewer: "ann", items };
  const numbers = (f: PrFilters, search = ""): number[] => groups(data, f, search, "oldest").flatMap((g) => g.items.map((p) => p.number));
  expect(numbers({ ...defaultFilters(), draft: true })).toEqual([1]);
  expect(numbers({ ...defaultFilters(), draft: false })).toEqual([3, 2]);
  expect(numbers({ ...defaultFilters(), draft: false }, "draft:true")).toEqual([1]);
  expect(numbers({ ...defaultFilters(), review: "changes" })).toEqual([2]);
  expect(numbers({ ...defaultFilters(), checks: "passing" })).toEqual([1]);
  expect(numbers({ ...defaultFilters(), author: "@bob" })).toEqual([2]);
  expect(numbers({ ...defaultFilters(), project: "O/OTHER" })).toEqual([2]);
  expect(numbers({ ...defaultFilters(), labels: ["bug", "ui"] })).toEqual([1]);
  expect(numbers(defaultFilters(), "-label:ui label:bug")).toEqual([3, 2]);
  expect(numbers(defaultFilters(), "label:ui,missing")).toEqual([1]);
  expect(numbers({ ...defaultFilters(), involvement: "authored" })).toEqual([1, 3]);
  expect(numbers(defaultFilters(), "o/other")).toEqual([2]);
  expect(groups(data, { ...defaultFilters(), involvement: "authored" }, "", "oldest").map((g) => [g.key, g.label])).toEqual([["others", ""]]);
  expect(groups({ viewer: "", items }, { ...defaultFilters(), involvement: "authored" }, "", "oldest")).toEqual([]);
});

test("sorts", () => {
  const items: Pr[] = [1, 2, 3, 4].map((n) => pr(n, "x"));
  items[0] = pr(1, "x", { checks: "passing", review: "approved" });
  items[3] = pr(4, "x", { conflicting: true });
  sortGroup(items, "others", "ready", "", "all");
  expect(items[0]?.number).toBe(1);
  expect(items[items.length - 1]?.number).toBe(4);
  sortGroup(items, "others", "largest", "", "all");
  expect(items[0]?.number).toBe(4);
  sortGroup(items, "others", "oldest", "", "all");
  expect(items[0]?.number).toBe(1);
});

test("the other sorts and the ranking of the search text", () => {
  const items: Pr[] = [
    pr(1, "x", { state: "merged", created: 30, updated: 5 }),
    pr(2, "x", { conflicting: true, created: 20, updated: 6, adds: 0 }),
    pr(3, "x", { draft: true, created: 10, updated: 7 }),
    pr(4, "x", { review: "changes", created: 40, updated: 8 }),
    pr(5, "x", { checks: "failing", created: 50, updated: 9 }),
    pr(6, "x", { checks: "passing", review: "approved", created: 60, updated: 4 }),
  ];
  const order = (sort: Parameters<typeof sortGroup>[2], key = "others", inv: Parameters<typeof sortGroup>[4] = "all", text = ""): number[] => {
    const copy = [...items];
    sortGroup(copy, key, sort, text, inv);
    return copy.map((p) => p.number);
  };
  expect(order("updated")).toEqual([5, 4, 3, 2, 1, 6]);
  expect(order("newest")).toEqual([6, 5, 4, 1, 2, 3]);
  expect(order("smallest")).toEqual([1, 3, 4, 5, 6, 2]);
  expect(order("largest")).toEqual([6, 5, 4, 3, 1, 2]);
  expect(order("ready")).toEqual([6, 3, 4, 5, 1, 2]);
  expect(order("blocked", "authored")).toEqual([2, 4, 5, 3, 6, 1]);
  expect(order("blocked", "reviewRequested")).toEqual([5, 4, 3, 2, 6, 1]);
  expect(order("blocked", "others", "authored")).toEqual([2, 4, 5, 3, 6, 1]);
  expect(order("blocked", "others", "all")).toEqual([1, 2, 3, 4, 5, 6]);
  const titled = [pr(1, "x", { title: "fix the build" }), pr(2, "x", { title: "build" }), pr(3, "x", { title: "other", branch: "build-it" }), pr(4, "x", { title: "fix other build tool" })];
  sortGroup(titled, "others", "ready", "build", "all");
  expect(titled.map((p) => p.number)).toEqual([2, 4, 1, 3]);
  sortGroup(titled, "others", "ready", "fix build", "all");
  expect(titled.map((p) => p.number)).toEqual([4, 1, 2, 3]);
});

test("remotes", () => {
  expect(githubRepo("https://github.com/octo/harbor")).toBe("octo/harbor");
  expect(githubRepo("https://gitlab.com/a/b")).toBeUndefined();
  for (const r of ["git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "ssh://git@github.com:22/o/r", "https://github.com/o/r.git", "https://token@github.com/o/r", "git@github.com:o/r/"]) {
    expect(githubRepo(r)).toBe("o/r");
  }
  expect(githubRepo("git@gitlab.com:o/r.git")).toBeUndefined();
  expect(githubRepo("https://github.com/o")).toBeUndefined();
  expect(githubRepo("https://github.com//r")).toBeUndefined();
  expect(githubRepo("  git://github.com/o/r.git \n")).toBe("o/r");
});

test("the query asks for authored, reviewing and project PRs in chunks of five repos", () => {
  const q = query("open", ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"]);
  expect(q.startsWith("query { viewer { login } authored: search(query: \"is:pr author:@me archived:false sort:updated-desc is:open\", type: ISSUE, first: 50)")).toBe(true);
  expect(q).toContain('reviewing: search(query: "is:pr review-requested:@me archived:false sort:updated-desc is:open", type: ISSUE, first: 50)');
  expect(q).toContain('p0: search(query: "is:pr sort:updated-desc is:open repo:a/1 repo:a/2 repo:a/3 repo:a/4 repo:a/5", type: ISSUE, first: 100)');
  expect(q).toContain('p1: search(query: "is:pr sort:updated-desc is:open repo:a/6", type: ISSUE, first: 100)');
  expect(q).not.toContain("p2:");
  expect(q.endsWith("}")).toBe(true);
  expect(query("closed", [])).toContain(" is:closed is:unmerged");
  expect(query("merged", [])).toContain(" is:merged");
  expect(query("all", [])).toContain("sort:updated-desc\"");
  expect(query("all", ['a"b\\c/d'])).toContain("repo:abc/d");
});

const node = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: n, title: `T${n}`, url: `https://github.com/o/r/pull/${n}`, state: "OPEN", isDraft: false, additions: 3, deletions: 1, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: `2026-01-0${n}T00:00:00Z`, headRefName: `b${n}`, headRefOid: "abc", reviewDecision: "APPROVED", mergeable: "MERGEABLE", repository: { nameWithOwner: "o/r" },
  author: { login: "ann", avatarUrl: "https://avatars.example.com/u/1" }, labels: { nodes: [{ name: "bug", color: "ff0000" }, { color: "00ff00" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...over,
});

test("a reply is read into PRs, merged across searches and newest first", () => {
  const v = {
    data: {
      viewer: { login: "ann" },
      reviewing: { nodes: [node(2), {}, null] },
      authored: { nodes: [node(1), node(2)] },
      p0: { nodes: [node(3, { state: "MERGED", reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", isDraft: true }), node(1)] },
      p1: null,
    },
  };
  const d = parse(v);
  expect(d.viewer).toBe("ann");
  expect(d.items.map((p) => p.number)).toEqual([3, 2, 1]);
  expect(d.items.map((p) => p.review_requested)).toEqual([false, true, false]);
  expect(d.items[0]).toEqual({
    number: 3, title: "T3", url: "https://github.com/o/r/pull/3", repo: "o/r", state: "merged", draft: true, adds: 3, dels: 1, created: 1_767_225_600, updated: 1_767_225_600 + 2 * 86400,
    branch: "b3", head: "abc", review: "changes", checks: "passing", conflicting: true, author: "ann", avatar: "https://avatars.example.com/u/1", labels: [["bug", [255, 0, 0]]], review_requested: false,
  });
  expect(parse(null)).toEqual({ viewer: "", items: [] });
});

test("states, decisions and check rollups map as in the list", () => {
  const one = (over: Record<string, unknown>) => parse({ data: { authored: { nodes: [node(1, over)] } } }).items[0];
  expect(one({ state: "CLOSED" })?.state).toBe("closed");
  expect(one({ state: "SOMETHING" })?.state).toBe("open");
  expect(one({ reviewDecision: "REVIEW_REQUIRED" })?.review).toBe("required");
  expect(one({ reviewDecision: null })?.review).toBe("none");
  for (const [state, want] of [["FAILURE", "failing"], ["ERROR", "failing"], ["PENDING", "pending"], ["EXPECTED", "pending"], ["OTHER", "none"]] as const) {
    expect(one({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } })?.checks).toBe(want);
  }
  expect(one({ commits: { nodes: [] } })?.checks).toBe("none");
  const bare = one({ author: null, repository: null, labels: null, additions: -1, createdAt: "bad" });
  expect([bare?.author, bare?.avatar, bare?.repo, bare?.labels, bare?.adds, bare?.created]).toEqual(["ghost", "", "", [], 0, 0]);
  expect(parse({ data: { authored: { nodes: [node(1, { number: "x" }), node(2, { url: null })] } } }).items).toEqual([]);
});

test("hexRgb, ago, thousands and the counts", () => {
  expect(hexRgb("a2eeef")).toEqual([162, 238, 239]);
  expect(hexRgb("")).toEqual([128, 128, 128]);
  expect(hexRgb("zz00ff")).toEqual([128, 0, 255]);
  expect(hexRgb("ff")).toEqual([255, 128, 128]);
  const now = 10_000_000;
  expect([0, 59, 60, 3599, 3600, 86_399, 86_400, 31_535_999, 31_536_000].map((s) => ago(now - s, now))).toEqual([
    "just now", "just now", "1m ago", "59m ago", "1h ago", "23h ago", "1d ago", "364d ago", "1y ago",
  ]);
  expect(ago(now + 100, now)).toBe("just now");
  expect(ago(0)).toMatch(/y ago$/);
  expect([0, 12, 999, 1000, 12_345, 1_234_567].map(thousands)).toEqual(["0", "12", "999", "1,000", "12,345", "1,234,567"]);
  const data: PrFetched = {
    viewer: "",
    items: [pr(1, "Zed", { labels: [["b", [1, 1, 1]], ["a", [2, 2, 2]]] }), pr(2, "amy", { labels: [["a", [9, 9, 9]]] }), pr(3, "Zed")],
  };
  expect(authors(data)).toEqual([["Zed", 2], ["amy", 1]]);
  expect(labels(data)).toEqual([["a", [2, 2, 2], 2], ["b", [1, 1, 1], 1]]);
  expect(sortLabel("blocked")).toBe("Blocked on me");
  expect(activeFilters(defaultFilters(), false)).toBe(0);
  expect(activeFilters({ state: "closed", involvement: "authored", labels: ["x", "y"], draft: false, author: "a" }, true)).toBe(7);
});

test("fetch asks gh for the GraphQL query and reads the answer", async () => {
  const calls: string[][] = [];
  const run: GhRun = async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ data: { viewer: { login: "ann" }, authored: { nodes: [node(1)] } } }), stderr: "" };
  };
  const d = await fetch("open", ["o/r"], run);
  expect(d.items.map((p) => p.number)).toEqual([1]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
  expect(calls[0]?.[3]).toBe(`query=${query("open", ["o/r"])}`);
  const port = makePrsPort(run);
  expect((await port.fetch("open", [])).viewer).toBe("ann");
  expect(port.sortLabel("newest")).toBe("Newest shown");
});

const fails = async (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: Error) => e.message);

test("graphql errors say what to do", async () => {
  const missing: GhRun = async () => {
    throw new GhSpawnError("missing", "No such file or directory (os error 2)");
  };
  expect(await fails(graphql("q", "pull requests", missing))).toBe("The GitHub CLI (gh) isn't installed. Install it and run `gh auth login` to see your pull requests.");
  const broken: GhRun = async () => {
    throw new GhSpawnError("timeout", "timed out after 90s");
  };
  expect(await fails(graphql("q", "pull requests", broken))).toBe("gh: timed out after 90s");
  expect(await fails(graphql("q", "x", async () => ({ code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login\n" })))).toBe("Not signed in to GitHub. Run `gh auth login`.");
  expect(await fails(graphql("q", "x", async () => ({ code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts" })))).toBe("Not signed in to GitHub. Run `gh auth login`.");
  expect(await fails(graphql("q", "x", async () => ({ code: 1, stdout: "not json", stderr: " HTTP 502 \n" })))).toBe("HTTP 502");
  expect(await fails(graphql("q", "x", async () => ({ code: 1, stdout: '{"data":null,"errors":[]}', stderr: "boom" })))).toBe("boom");
});

test("a partial answer still counts, and so does an answer that is not JSON on success", async () => {
  const partial = { data: { viewer: { login: "a" }, authored: { nodes: [node(1)] }, p0: null }, errors: [{ message: "rate limited" }] };
  expect(await graphql("q", "x", reply(partial, { code: 1, stderr: "gh: partial" }))).toEqual(partial);
  expect(await graphql("q", "x", async () => ({ code: 0, stdout: "nope", stderr: "" }))).toBeNull();
  expect(parse(await graphql("q", "x", async () => ({ code: 0, stdout: "nope", stderr: "" })))).toEqual({ viewer: "", items: [] });
});
