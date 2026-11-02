import "./sandbox.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhApi, type Call, type GhDeps, type Reply } from "../src/ghapi.ts";
import { GH_TIMEOUT, GhSpawnError, ghRun, realGh } from "../src/github/gh.ts";
import { detailsPort } from "../src/github/details.ts";
import { prsPort } from "../src/github/prs.ts";

const SCRIPT = `#!/bin/sh
{
  echo "ARGS $*"
  echo "ENV config=$GH_CONFIG_DIR token=\${GH_TOKEN-unset} prompt=$GIT_TERMINAL_PROMPT"
} >> "$FAKE_GH_LOG"
case "$1 $2" in
  "api graphql") cat "$FAKE_GH_DIR/graphql.json" ;;
  "pr view") cat "$FAKE_GH_DIR/pr.json" ;;
  "issue view") cat "$FAKE_GH_DIR/issue.json" ;;
  "pr diff") printf 'diff --git a/x.txt b/x.txt\\n@@ -1 +1 @@\\n-a\\n+b\\n' ;;
  "pr ready") echo "marked ready" ;;
  "slow 1") exec sleep 5 ;;
  "fail 1") echo "boom" >&2; exit 3 ;;
  "bad 1") echo "not a pull request" >&2; exit 1 ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`;

const graphql = {
  data: {
    viewer: { login: "ann" },
    authored: {
      nodes: [
        {
          number: 5, title: "Add a thing", url: "https://github.com/o/r/pull/5", state: "OPEN", isDraft: false, additions: 10, deletions: 2,
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", headRefName: "thing", headRefOid: "abc", reviewDecision: "APPROVED", mergeable: "MERGEABLE",
          repository: { nameWithOwner: "o/r" }, author: { login: "ann", avatarUrl: "https://avatars.example.com/1" }, labels: { nodes: [{ name: "bug", color: "ff0000" }] },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        },
      ],
    },
  },
};

const pull = {
  number: 5, title: "Add a thing", url: "https://github.com/o/r/pull/5", state: "OPEN", isDraft: false, author: { login: "ann" }, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z", baseRefName: "main", headRefName: "thing", additions: 10, deletions: 2, changedFiles: 1, body: "<p>Hello</p>",
};

const issue = {
  number: 3, title: "Broken", url: "https://github.com/o/r/issues/3", state: "OPEN", stateReason: "", author: { login: "ana" }, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z", labels: [], assignees: [], milestone: null, body: "b", comments: [],
};

let root: string;
let log: string;
const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN };

const calls = (): string[] => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("ARGS "));
const envs = (): string[] => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("ENV "));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "harbor-gh-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), SCRIPT);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(root, "graphql.json"), JSON.stringify(graphql));
  writeFileSync(join(root, "pr.json"), JSON.stringify(pull));
  writeFileSync(join(root, "issue.json"), JSON.stringify(issue));
  log = join(root, "calls.log");
  process.env.FAKE_GH_DIR = root;
  process.env.FAKE_GH_LOG = log;
});

beforeEach(() => {
  writeFileSync(log, "");
  process.env.PATH = `${join(root, "bin")}:${saved.PATH ?? ""}`;
  process.env.GH_TOKEN = "token-that-must-not-reach-gh";
});

afterAll(() => {
  if (saved.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = saved.PATH;
  if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = saved.GH_TOKEN;
  delete process.env.FAKE_GH_DIR;
  delete process.env.FAKE_GH_LOG;
  rmSync(root, { recursive: true, force: true });
});

const failure = (p: Promise<unknown>): Promise<Error> => p.then(() => new Error("it did not fail"), (e: Error) => e);

test("the real runner runs gh with Harbor's agent environment", async () => {
  const out = await ghRun(["pr", "diff", "https://github.com/o/r/pull/5"]);
  expect(out.code).toBe(0);
  expect(out.stdout).toContain("diff --git a/x.txt b/x.txt");
  expect(calls()).toEqual(["ARGS pr diff https://github.com/o/r/pull/5"]);
  const env = envs()[0] ?? "";
  expect(env).toContain("token=unset");
  expect(env).toContain("prompt=0");
  expect(env).toMatch(/config=\S*github-signed-out /);
});

test("a failing gh gives its exit code and stderr", async () => {
  const out = await ghRun(["fail", "1"]);
  expect([out.code, out.stdout, out.stderr]).toEqual([3, "", "boom\n"]);
});

test("a gh that hangs is killed after the timeout", async () => {
  expect(GH_TIMEOUT).toBe(90_000);
  const started = Date.now();
  const e = await failure(realGh(300)(["slow", "1"]));
  expect(e).toBeInstanceOf(GhSpawnError);
  expect((e as GhSpawnError).kind).toBe("timeout");
  expect(e.message).toBe("timed out after 0.3s");
  expect(Date.now() - started).toBeLessThan(3000);
});

test("no gh on the PC says to install it", async () => {
  process.env.PATH = join(root, "empty");
  const e = await failure(ghRun(["pr", "diff", "u"]));
  expect(e).toBeInstanceOf(GhSpawnError);
  expect((e as GhSpawnError).kind).toBe("missing");
  expect((await failure(prsPort.fetch("open", []))).message).toBe("The GitHub CLI (gh) isn't installed. Install it and run `gh auth login` to see your pull requests.");
  const port = detailsPort({ http: async () => [200, null] });
  expect((await failure(port.gh(["pr", "diff", "u"]))).message).toBe("gh: No such file or directory (os error 2)");
});

test("the pull request list comes from gh api graphql", async () => {
  const d = await prsPort.fetch("open", ["o/r"]);
  expect(d.viewer).toBe("ann");
  expect(d.items).toEqual([
    {
      number: 5, title: "Add a thing", url: "https://github.com/o/r/pull/5", repo: "o/r", state: "open", draft: false, adds: 10, dels: 2, created: 1_767_225_600, updated: 1_767_312_000,
      branch: "thing", head: "abc", review: "approved", checks: "passing", conflicting: false, author: "ann", avatar: "https://avatars.example.com/1", labels: [["bug", [255, 0, 0]]], review_requested: false,
    },
  ]);
  const [call] = calls();
  expect(call?.startsWith("ARGS api graphql -f query=query { viewer { login } authored: search(")).toBe(true);
  expect(call).toContain("p0: search(query: \"is:pr sort:updated-desc is:open repo:o/r\"");
  expect(prsPort.groups(d, { state: "open", involvement: "all", labels: [] }, "", "ready").map((g) => g.key)).toEqual(["authored"]);
  expect(prsPort.authors(d)).toEqual([["ann", 1]]);
  expect(prsPort.labels(d)).toEqual([["bug", [255, 0, 0], 1]]);
});

test("the details port reads pull requests and issues through gh", async () => {
  const port = detailsPort({ http: async () => [500, null] });
  const f = await port.fetchPr("https://github.com/o/r/pull/5");
  expect([f.number, f.title, f.body, f.timeline.length]).toEqual([5, "Add a thing", "Hello", 1]);
  expect((await port.fetchIssue("https://github.com/o/r/issues/3")).state).toBe("open");
  expect(await port.fetchIssueRaw("https://github.com/o/r/issues/3")).toEqual(issue);
  expect(port.parseDiff(await port.gh(["pr", "diff", "u"]))).toEqual([{ t: "file", path: "x.txt", adds: 1, dels: 1 }, { t: "hunk", text: "@@ -1 +1 @@" }, { t: "del", text: "a" }, { t: "add", text: "b" }]);
  expect((await failure(port.gh(["bad", "1"]))).message).toBe("not a pull request");
  expect((await failure(port.gh(["nothing", "1"]))).message).toBe("unexpected: nothing 1");
  expect(calls()[0]).toBe("ARGS pr view https://github.com/o/r/pull/5 --json number,title,body,url,state,isDraft,author,createdAt,updatedAt,baseRefName,headRefName,additions,deletions,changedFiles,labels,reviewRequests,latestReviews,reviews,comments,statusCheckRollup,commits,mergeable");
});

test("the details port reaches an issue on another PC through the mesh http it was given", async () => {
  const seen: string[] = [];
  const port = detailsPort({
    http: async (dest, method, path) => {
      seen.push(`${String(dest.id)} ${method} ${path.split("?")[0]}`);
      return [200, issue];
    },
  });
  const dest = { id: "peer" };
  expect((await port.fetchIssueOn(dest, "https://github.com/o/r/issues/3")).title).toBe("Broken");
  await port.setIssueOpenOn(dest, "https://github.com/o/r/issues/3", false);
  expect(seen).toEqual(["peer GET /mesh/v1/issues/view", "peer POST /mesh/v1/issues/close"]);
  expect(calls()).toEqual([]);
});

const callOf = (path: string[], method = "GET", query: [string, string][] = []): Call => ({ method, path, query, body: null, token: "", device: "", global: false });
const bodyOf = (r: Reply): Record<string, unknown> => r.body as Record<string, unknown>;

test("GhApi serves pull requests through the real ports", async () => {
  const deps: GhDeps = {
    prs: prsPort,
    issues: {
      fetch: async () => ({ viewer: "", items: [], sources: [] }),
      groups: () => [],
      mine: () => [],
      accounts: () => [],
      notes: () => [],
      authors: () => [],
      assignees: () => [],
      milestones: () => [],
      labels: () => [],
      otherProjects: () => [],
      owner: () => undefined,
      merge: () => ({ viewer: "", items: [], sources: [] }),
      shortError: (e) => e,
      sortLabel: (s) => s,
    },
    details: detailsPort({ http: async () => [500, null] }),
    mesh: { enabled: () => false, me: () => ({ name: "desk" }), peers: () => [], peer: () => undefined, http: async () => [500, null], forward: async () => ({ status: 500, body: null }), mapNew: (_h, r) => r },
    host: { repos: async () => ["o/r"], projects: async () => [], projectOf: () => undefined, agentLabel: () => "Claude", ctx: () => null, agentThread: async () => ({ status: 500, body: null }) },
    blocks: (md) => [{ t: "p", md }],
    deviceId: () => "dev",
  };
  const api = new GhApi(deps);
  const list = bodyOf(await api.handle(callOf(["v1", "prs"])));
  expect(list.viewer).toBe("ann");
  expect((list.groups as { key: string; items: { number: number; review: string }[] }[])[0]?.items[0]).toMatchObject({ number: 5, review: "approved" });
  expect((list.sorts as { id: string; label: string }[])[0]).toEqual({ id: "ready", label: "Merge readiness" });
  const url: [string, string][] = [["url", "https://github.com/o/r/pull/5"]];
  const one = bodyOf(await api.handle(callOf(["v1", "prs", "view"], "GET", url)));
  expect([one.number, one.repo, one.body]).toEqual([5, "o/r", "Hello"]);
  const diff = bodyOf(await api.handle(callOf(["v1", "prs", "diff"], "GET", url)));
  expect(diff.clipped).toBe(false);
  expect((diff.lines as unknown[]).length).toBe(4);
  expect((await api.handle(callOf(["v1", "prs", "ready"], "POST", url))).status).toBe(200);
  expect(calls().at(-1)).toBe("ARGS pr ready https://github.com/o/r/pull/5");
  expect((await api.handle(callOf(["v1", "prs", "view"], "GET", [["url", "https://github.com/o/r/pull/5/files"]]))).status).toBe(400);
});
